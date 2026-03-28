/**
 * Impression System — pi extension that distills long tool results into
 * compact notes, storing the originals for on-demand recall.
 *
 * How it works:
 *   1. Intercepts every tool_result whose text length >= MIN_LENGTH_FOR_IMPRESSION.
 *   2. Calls the active model to produce a shorter "impression" (distilled note).
 *   3. Replaces the tool result with the impression; the full content is stored
 *      in session entries and can be retrieved via the `recall_impression` tool.
 *   4. On the first recall, the model re-distills with updated context.
 *      After MAX_RECALL_BEFORE_PASSTHROUGH recalls, full content is returned as-is.
 *
 * Configuration — .pi/impression.json
 *
 *   Optional. If the file is missing or invalid the extension uses defaults.
 *   The config is reloaded on every session_start.
 *
 *   {
 *     "skipDistillation": string[],        // tool names whose results should never be distilled
 *     "minLength":        number,           // minimum text length to trigger distillation (default: 2048)
 *     "maxRecallBeforePassthrough": number  // recalls before returning full content (default: 1)
 *   }
 *
 *   skipDistillation patterns:
 *     - Exact match:  "bash"          — skips only the tool named "bash"
 *     - Glob suffix:  "background_*"  — skips any tool whose name starts with "background_"
 *
 *   Example .pi/impression.json:
 *
 *   {
 *     "skipDistillation": ["bash", "background_output", "my_custom_tool*"],
 *     "minLength": 1024,
 *     "maxRecallBeforePassthrough": 2
 *   }
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, complete, type ImageContent, type Model, type TextContent } from "@mariozechner/pi-ai";
import { buildSessionContext, type ExtensionAPI, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const IMPRESSION_ENTRY_TYPE = "impression-v1";
const DEFAULT_MIN_LENGTH = 2048;
const DEFAULT_MAX_RECALL = 1;
const DISTILLER_SENTINEL = "<passthrough/>";
const CONFIG_FILE_NAME = "impression.json";

interface ImpressionConfig {
	skipDistillation?: string[];
	minLength?: number;
	maxRecallBeforePassthrough?: number;
}

interface ResolvedConfig {
	skipDistillation: string[];
	minLength: number;
	maxRecall: number;
}

function resolveConfig(raw: ImpressionConfig): ResolvedConfig {
	return {
		skipDistillation: raw.skipDistillation ?? [],
		minLength: raw.minLength ?? DEFAULT_MIN_LENGTH,
		maxRecall: raw.maxRecallBeforePassthrough ?? DEFAULT_MAX_RECALL,
	};
}

function loadConfig(): ImpressionConfig {
	try {
		const configPath = join(process.cwd(), ".pi", CONFIG_FILE_NAME);
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as ImpressionConfig;
		}
	} catch {
		// Config file missing or invalid — use defaults
	}
	return {};
}

function shouldSkipDistillation(toolName: string, config: ResolvedConfig): boolean {
	const patterns = config.skipDistillation;
	if (patterns.length === 0) return false;
	for (const pattern of patterns) {
		if (pattern === toolName) return true;
		// Support simple glob: "prefix*" matches any tool starting with prefix
		if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) return true;
	}
	return false;
}

interface ImpressionEntry {
	id: string;
	toolName: string;
	toolCallId: string;
	fullContent: (TextContent | ImageContent)[];
	fullText: string;
	recallCount: number;
	createdAt: number;
	modelProvider: string;
	modelId: string;
}

const RecallImpressionParams = Type.Object({
	id: Type.String({ description: "Impression ID" }),
});

function isImpressionEntry(value: unknown): value is ImpressionEntry {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string") return false;
	if (typeof record.toolName !== "string") return false;
	if (typeof record.toolCallId !== "string") return false;
	if (!Array.isArray(record.fullContent)) return false;
	if (typeof record.fullText !== "string") return false;
	if (typeof record.recallCount !== "number") return false;
	if (typeof record.createdAt !== "number") return false;
	if (typeof record.modelProvider !== "string") return false;
	if (typeof record.modelId !== "string") return false;
	return true;
}

function getEntryData(entry: SessionEntry): unknown {
	if (entry.type !== "custom") return undefined;
	if (entry.customType !== IMPRESSION_ENTRY_TYPE) return undefined;
	return entry.data;
}

function serializeContent(content: (TextContent | ImageContent)[]): string {
	const lines: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			lines.push(block.text);
			continue;
		}
		lines.push(`[image: ${block.mimeType}]`);
	}
	return lines.join("\n").trim();
}

function buildImpressionText(id: string, note: string): string {
	return [
		`<impression id="${id}">`,
		note,
		"</impression>",
		"Note: this impression is not the full original output, and may omit details.",
		`If you need exact values, exact wording, full lists, or verification, call recall_impression with id "${id}" before answering.`,
	].join("\n");
}

async function distillWithSameModel(
	model: Model<Api>,
	auth: { apiKey?: string; headers?: Record<string, string> },
	toolName: string,
	content: (TextContent | ImageContent)[],
	visibleHistory: string,
	originalSystemPrompt: string,
	maxTokens: number,
): Promise<{ passthrough: boolean; note: string }> {
	const contentText = serializeContent(content);
	const systemPrompt = [
		"You are the same agent as the one in the visible history — the same identity, the same mind.",
		"You are about to receive a tool result. Your outer self (the main thread) will only see what you write here, not the original content.",
		"Think of this as choosing what to remember: you are compressing your own memory, not summarizing for someone else.",
		"You have exactly the full context of your outer self, including the original system prompt and the visible history up to this point.",
		"Your goal: with your notes, your outer self should be able to continue working without needing to recall the original immediately — immediate recall is a **failure** of your compression.",
		"",
		"Action-awareness:",
		"- Review the visible history and the original system prompt to infer what your outer self will do NEXT with this tool result.",
		"- If the next action requires precise original text (e.g., editing a file needs exact oldText matches, writing code needs exact signatures/types, executing a command needs exact paths/values), you have two choices:",
		"  (a) If the output is long, tend to provide smarter actionable guidance to your outer self -- e.g., 'lines 42-58 contain the function to edit' so that your outer self can act without reading the whole file again.",
		"  (b) If the tool output is of reasonable length or ALL text MUST be provided, return " + DISTILLER_SENTINEL + " to pass through the full content unchanged.",
		"- If the next action is analytical (understanding architecture, answering questions, planning), compress aggressively — semantic notes are sufficient.",
		"",
		"Compression guidelines:",
		"- You MUST NOT summarise or restate the visible history or the system prompt, just summarise the tool result and provide actionable notes — e.g., do NOT summarise like 'The outer self is intended to... So I should ...' These are irrelevant and your outer self must already knows it. The tokens you write are highly valuable, use them ONLY to capture the essence of the tool result and guide your outer self's next steps.",
		"- If the information already appears in the visible history, just reference it briefly — do NOT copy it again.",
		"- On a recall_impression call, take only additional notes on top of what is already in your visible history — do NOT repeat.",
		"- Your notes must be shorter than the original content.",
		"- **IMPORTANT**: After your notes, append ONE brief line prefixed with 'Also contains:' listing significant sections you did NOT capture. State \"all content are summarised\" if nothing was omitted.",
		"",
		"Return exactly " + DISTILLER_SENTINEL + " if full content are very much relevant for further actions and should pass through unchanged. NO EXPLANATIONS, NO MARKDOWN fences, JUST " + DISTILLER_SENTINEL + ".",
	].join("\n");
	const prompt = [
		"<original_system_prompt>",
		originalSystemPrompt || "[none]",
		"</original_system_prompt>",
		"",
		"<visible_history_before_tool_result>",
		visibleHistory || "[none]",
		"</visible_history_before_tool_result>",
		"",
		`Tool: ${toolName}`,
		"",
		"<tool_result>",
		contentText || "[empty]",
		"</tool_result>",
	].join("\n");

	const response = await complete(
		model,
		{
			systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens },
	);

	const text = response.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

	const normalized = text.trim();
	if (!normalized) {
		return { passthrough: true, note: DISTILLER_SENTINEL };
	}

	const sentinelLike = normalized
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.!。]+$/g, "")
		.trim();

	if (sentinelLike === DISTILLER_SENTINEL) {
		return { passthrough: true, note: text };
	}
	if (text.length >= contentText.length) {
		// If the model returns more text than the original content, it's likely not a good distillation. Pass through instead.
		return { passthrough: true, note: "[FAILING DISTILLATION: " + text.length + " >= " + contentText.length + "]" + text };
	}
	return { passthrough: false, note: text };
}

function createRecallToolResult(id: string, note: string): { content: TextContent[]; details: undefined } {
	return {
		content: [{ type: "text", text: buildImpressionText(id, note) }],
		details: undefined,
	};
}

function createPassthroughToolResult(content: (TextContent | ImageContent)[]): {
	content: (TextContent | ImageContent)[];
	details: undefined;
} {
	return {
		content,
		details: undefined,
	};
}

function resolveStoredModel(entry: ImpressionEntry, currentModel: Model<Api> | undefined): Model<Api> | undefined {
	if (currentModel && currentModel.provider === entry.modelProvider && currentModel.id === entry.modelId) {
		return currentModel;
	}
	return undefined;
}

function serializeVisibleHistory(messages: ReturnType<typeof buildSessionContext>["messages"]): string {
	return messages.map((m) => JSON.stringify(m)).join("\n");
}

function notifyImpressionSkip(
	ctx: {
		ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	},
	reason: string,
): void {
	ctx.ui.notify(`[impression] Skipped: ${reason}`, "warning");
}

export default function (pi: ExtensionAPI) {
	const impressions = new Map<string, ImpressionEntry>();
	let cfg: ResolvedConfig = resolveConfig(loadConfig());

	pi.on("session_start", async (_event, ctx) => {
		cfg = resolveConfig(loadConfig());
		impressions.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			const data = getEntryData(entry);
			if (!isImpressionEntry(data)) continue;
			impressions.set(data.id, data);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "recall_impression") return;
		if (shouldSkipDistillation(event.toolName, cfg)) {
			ctx.ui.notify(`[impression] Skipped distillation for "${event.toolName}" (configured in ${CONFIG_FILE_NAME})`, "info");
			return;
		}
		if (event.isError) {
			notifyImpressionSkip(ctx, "tool result is an error");
			return;
		}

		const fullText = serializeContent(event.content);
		if (fullText.length < cfg.minLength) {
			ctx.ui.notify(`[impression] Skipped: content length ${fullText.length} is below threshold of ${cfg.minLength}`, "info");
			return;
		}

		const model = ctx.model;
		if (!model) {
			notifyImpressionSkip(ctx, "no active model selected");
			return {
				content: event.content,
			};
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			notifyImpressionSkip(ctx, `missing auth for ${model.provider}/${model.id}: ${auth.error}`);
			return {
				content: event.content,
			};
		}
		const visibleHistory = serializeVisibleHistory(buildSessionContext(ctx.sessionManager.getEntries()).messages);
		const originalSystemPrompt = ctx.getSystemPrompt();
		ctx.ui.setStatus("impression-distill", `[impression] Distilling ${fullText.length} chars with ${model.provider}/${model.id}...`);
		let distillation: { passthrough: boolean; note: string };
		try {
			distillation = await distillWithSameModel(
				model,
				{ apiKey: auth.apiKey, headers: auth.headers },
				event.toolName,
				event.content,
				visibleHistory,
				originalSystemPrompt,
				Math.max(Math.ceil(cfg.minLength / 2), 1024),
			);
		} finally {
			ctx.ui.setStatus("impression-distill", undefined);
		}

		if (distillation.passthrough) {
			ctx.ui.notify(`[impression] Distillation passthrough with text: ${distillation.note}`, "info");
			return { content: event.content };
		}

		const id = randomUUID();
		const impression: ImpressionEntry = {
			id,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			fullContent: event.content,
			fullText,
			recallCount: 0,
			createdAt: Date.now(),
			modelProvider: model.provider,
			modelId: model.id,
		};
		impressions.set(id, impression);
		pi.appendEntry(IMPRESSION_ENTRY_TYPE, impression);

		return {
			content: [{ type: "text", text: buildImpressionText(id, distillation.note) }],
		};
	});

	pi.registerTool({
		name: "recall_impression",
		label: "Recall Impression",
		description:
			"Recall a stored impression by ID. Before " + cfg.maxRecall + " recalls it returns distilled notes; after that it returns full passthrough content.",
		parameters: RecallImpressionParams,
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const impression = impressions.get(args.id);
			if (!impression) {
				throw new Error(`Impression not found: ${args.id}`);
			}

			if (impression.recallCount >= cfg.maxRecall) {
				return createPassthroughToolResult(impression.fullContent);
			}

			const activeModel = ctx.model;
			const model = resolveStoredModel(impression, activeModel);
			if (!model) {
				notifyImpressionSkip(
					ctx,
					`model changed or unavailable (stored ${impression.modelProvider}/${impression.modelId})`,
				);
				impression.recallCount = cfg.maxRecall;
				pi.appendEntry(IMPRESSION_ENTRY_TYPE, impression);
				return createPassthroughToolResult(impression.fullContent);
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				notifyImpressionSkip(ctx, `missing auth for ${model.provider}/${model.id}: ${auth.error}`);
				impression.recallCount = cfg.maxRecall;
				pi.appendEntry(IMPRESSION_ENTRY_TYPE, impression);
				return createPassthroughToolResult(impression.fullContent);
			}
			const visibleHistory = serializeVisibleHistory(buildSessionContext(ctx.sessionManager.getEntries()).messages);
			const originalSystemPrompt = ctx.getSystemPrompt();
			ctx.ui.setStatus("impression-distill", `[impression] Re-distilling ${impression.fullText.length} chars with ${model.provider}/${model.id}...`);
			let distillation: { passthrough: boolean; note: string };
			try {
				distillation = await distillWithSameModel(
					model,
					{ apiKey: auth.apiKey, headers: auth.headers },
					impression.toolName,
					impression.fullContent,
					visibleHistory,
					originalSystemPrompt,
					Math.max(Math.ceil(cfg.minLength / 2), 1024),
				);
			} finally {
				ctx.ui.setStatus("impression-distill", undefined);
			}

			if (distillation.passthrough) {
				impression.recallCount = cfg.maxRecall;
				pi.appendEntry(IMPRESSION_ENTRY_TYPE, impression);
				return createPassthroughToolResult(impression.fullContent);
			}

			impression.recallCount += 1;
			if (impression.recallCount >= cfg.maxRecall) {
				pi.appendEntry(IMPRESSION_ENTRY_TYPE, impression);
				return createPassthroughToolResult(impression.fullContent);
			}

			pi.appendEntry(IMPRESSION_ENTRY_TYPE, impression);
			return createRecallToolResult(impression.id, distillation.note);
		},
	});
}
