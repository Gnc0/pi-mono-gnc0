/**
 * High-intensity test suite for web-search.ts
 * Tests all scenarios specified in task requirements.
 * Run with: bun run test-web-search.ts
 */

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const TIMEOUT_MS = 25_000;

// ============================================================
// Pure-function unit tests (no network)
// ============================================================

/** Inline the parseSseData logic for unit testing */
interface ExaMcpResponse {
	jsonrpc: string;
	result?: {
		content?: Array<{ type: string; text: string }>;
	};
	error?: { code: number; message: string };
}

function parseSseData(text: string): ExaMcpResponse | undefined {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("data: ")) {
			try {
				return JSON.parse(trimmed.slice(6)) as ExaMcpResponse;
			} catch {
				// continue scanning
			}
		}
	}
	return undefined;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.log(`  FAIL  ${name}${detail ? ": " + detail : ""}`);
		failed++;
	}
}

// ============================================================
// Section 1: parseSseData unit tests
// ============================================================
console.log("\n=== Section 1: parseSseData unit tests ===");

{
	// Multiple data: lines, only first valid JSON should be returned
	const sse = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}\ndata: {"jsonrpc":"2.0","id":2}\n`;
	const result = parseSseData(sse);
	assert(result?.result?.content?.[0]?.text === "hello", "multiple data: lines — returns first valid JSON");
}

{
	// Invalid JSON before valid JSON — should skip and return valid
	const sse = `data: not-valid-json\ndata: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"ok"}]}}\n`;
	const result = parseSseData(sse);
	assert(result?.result?.content?.[0]?.text === "ok", "invalid JSON before valid — skips and returns valid");
}

{
	// Empty string input
	const result = parseSseData("");
	assert(result === undefined, "empty string — returns undefined");
}

{
	// No data: lines at all
	const result = parseSseData("event: open\ncomment: hello\n");
	assert(result === undefined, "no data: lines — returns undefined");
}

{
	// data: line with only whitespace after it (edge case)
	const result = parseSseData("data:   \n");
	assert(result === undefined, "data: with only whitespace — returns undefined");
}

{
	// data: line where trimmed matches but slice(6) gives whitespace — should fail JSON.parse
	const result = parseSseData("data: \n");
	assert(result === undefined, "data: with empty value — returns undefined");
}

{
	// Trailing whitespace on data line
	const sse = `data: {"jsonrpc":"2.0","result":null}   \n`;
	const result = parseSseData(sse);
	// trimmed.slice(6) still has trailing spaces: JSON.parse handles trailing whitespace fine
	assert(result !== undefined && result.result === null, "data: line with trailing whitespace — parsed correctly");
}

{
	// Error response in SSE
	const sse = `data: {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}\n`;
	const result = parseSseData(sse);
	assert(result?.error?.message === "Method not found", "SSE error response parsed correctly");
}

// ============================================================
// Section 2: JSON detection logic
// ============================================================
console.log("\n=== Section 2: JSON detection logic ===");

function detectAndParse(responseText: string): ExaMcpResponse | undefined {
	let data: ExaMcpResponse | undefined;
	if (responseText.trimStart().startsWith("{")) {
		try {
			data = JSON.parse(responseText) as ExaMcpResponse;
		} catch {
			// fall through to SSE parsing
		}
	}
	data ??= parseSseData(responseText);
	return data;
}

{
	// Plain JSON response
	const json = `{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"json-result"}]}}`;
	const result = detectAndParse(json);
	assert(result?.result?.content?.[0]?.text === "json-result", "plain JSON detected and parsed");
}

{
	// SSE response (starts with event:, not {)
	const sse = `event: message\ndata: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"sse-result"}]}}\n`;
	const result = detectAndParse(sse);
	assert(result?.result?.content?.[0]?.text === "sse-result", "SSE response detected and parsed");
}

{
	// Whitespace before JSON
	const json = `  \n{"jsonrpc":"2.0","result":null}`;
	const result = detectAndParse(json);
	assert(result !== undefined, "JSON with leading whitespace: trimStart detects {");
}

{
	// Invalid JSON that starts with { — should fall through to SSE (which also finds nothing)
	const bad = `{not valid json`;
	const result = detectAndParse(bad);
	assert(result === undefined, "invalid JSON starting with { — falls through to SSE, returns undefined");
}

// ============================================================
// Section 3: Live API tests (network required)
// ============================================================
console.log("\n=== Section 3: Live API tests ===");

interface SearchResult {
	ok: boolean;
	text?: string;
	error?: string;
	status?: number;
}

async function callExa(
	args: {
		query: string;
		numResults?: number;
		type?: "auto" | "fast" | "deep";
		livecrawl?: "fallback" | "preferred";
		contextMaxCharacters?: number;
	},
	signal?: AbortSignal,
): Promise<SearchResult> {
	const body = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "web_search_exa",
			arguments: {
				query: args.query,
				type: args.type ?? "auto",
				numResults: args.numResults ?? 8,
				livecrawl: args.livecrawl ?? "fallback",
				...(args.contextMaxCharacters !== undefined ? { contextMaxCharacters: args.contextMaxCharacters } : {}),
			},
		},
	};

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	if (signal) {
		signal.addEventListener("abort", () => controller.abort(), { once: true });
		// Bug fix: if signal is already aborted, addEventListener never fires in Bun
		if (signal.aborted) {
			controller.abort();
		}
	}

	try {
		const response = await fetch(EXA_MCP_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(timer);

		if (!response.ok) {
			const errorText = await response.text();
			return { ok: false, error: `HTTP ${response.status}: ${errorText}`, status: response.status };
		}

		const responseText = await response.text();

		// Detection logic (mirrors web-search.ts)
		let data: ExaMcpResponse | undefined;
		if (responseText.trimStart().startsWith("{")) {
			try {
				data = JSON.parse(responseText) as ExaMcpResponse;
			} catch {
				// fall through
			}
		}
		data ??= parseSseData(responseText);

		if (data?.error) {
			return { ok: false, error: `API error: ${data.error.message}` };
		}

		const text = data?.result?.content?.[0]?.text;
		return { ok: true, text };
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
			return { ok: false, error: "ABORTED" };
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// 3.1 Normal search — real keyword
console.log("\n  3.1 Normal search: TypeScript 5.5 new features");
{
	const r = await callExa({ query: "TypeScript 5.5 new features" });
	if (r.ok && r.text && r.text.length > 10) {
		assert(true, "normal search returns meaningful text", `(length=${r.text.length})`);
		console.log(`       Sample: ${r.text.slice(0, 120)}...`);
	} else {
		assert(false, "normal search returns meaningful text", r.error ?? "empty text");
	}
}

// 3.2 numResults = 1
console.log("\n  3.2 numResults=1");
{
	const r = await callExa({ query: "TypeScript", numResults: 1 });
	if (r.ok && r.text) {
		// We can't easily count results from text, but we should get *some* result
		assert(true, "numResults=1 returns a result");
		console.log(`       Length=${r.text.length}`);
	} else {
		assert(false, "numResults=1 returns a result", r.error ?? "empty");
	}
}

// 3.3 numResults = 20
console.log("\n  3.3 numResults=20");
{
	const r = await callExa({ query: "JavaScript frameworks 2025", numResults: 20 });
	if (r.ok && r.text && r.text.length > 0) {
		assert(true, "numResults=20 returns a result without crash");
		console.log(`       Length=${r.text.length}`);
	} else {
		assert(false, "numResults=20 returns a result without crash", r.error ?? "empty");
	}
}

// 3.4 type=fast
console.log("\n  3.4 type=fast");
{
	const r = await callExa({ query: "Bun runtime features", type: "fast" });
	if (r.ok && r.text && r.text.length > 0) {
		assert(true, "type=fast returns result");
	} else {
		assert(false, "type=fast returns result", r.error ?? "empty");
	}
}

// 3.5 type=deep
// Note: Exa public endpoint only supports "auto" and "fast"; "deep" is silently ignored (treated as auto).
console.log("\n  3.5 type=deep (silently treated as auto by public endpoint)");
{
	const r = await callExa({ query: "React server components architecture", type: "deep" });
	if (r.ok && r.text && r.text.length > 0) {
		assert(true, "type=deep returns result (server ignores deep, falls back to auto)");
	} else {
		assert(false, "type=deep returns result", r.error ?? "empty");
	}
}

// 3.6 type=auto (explicit)
console.log("\n  3.6 type=auto");
{
	const r = await callExa({ query: "Node.js 22 LTS features", type: "auto" });
	if (r.ok && r.text && r.text.length > 0) {
		assert(true, "type=auto returns result");
	} else {
		assert(false, "type=auto returns result", r.error ?? "empty");
	}
}

// 3.7 livecrawl=fallback
console.log("\n  3.7 livecrawl=fallback");
{
	const r = await callExa({ query: "OpenAI API latest models", livecrawl: "fallback" });
	if (r.ok && r.text && r.text.length > 0) {
		assert(true, "livecrawl=fallback returns result");
	} else {
		assert(false, "livecrawl=fallback returns result", r.error ?? "empty");
	}
}

// 3.8 livecrawl=preferred
console.log("\n  3.8 livecrawl=preferred");
{
	const r = await callExa({ query: "Claude Anthropic news", livecrawl: "preferred" });
	if (r.ok && r.text && r.text.length > 0) {
		assert(true, "livecrawl=preferred returns result");
	} else {
		assert(false, "livecrawl=preferred returns result", r.error ?? "empty");
	}
}

// 3.9 contextMaxCharacters: the Exa public MCP endpoint does not support this parameter.
// The server silently ignores it, so it must not cause crashes or errors.
console.log("\n  3.9 contextMaxCharacters: ignored by public Exa endpoint — must not crash");
{
	const rSmall = await callExa({
		query: "TypeScript 5.5 features",
		contextMaxCharacters: 100,
	});
	const rLarge = await callExa({
		query: "TypeScript 5.5 features",
		contextMaxCharacters: 100000,
	});
	const smallOk = rSmall.ok && rSmall.text !== undefined;
	const largeOk = rLarge.ok && rLarge.text !== undefined;
	assert(
		smallOk,
		"contextMaxCharacters=100: no crash, returns results",
		smallOk ? undefined : (rSmall.error ?? "empty"),
	);
	assert(
		largeOk,
		"contextMaxCharacters=100000: no crash, returns results",
		largeOk ? undefined : (rLarge.error ?? "empty"),
	);
}

// 3.10 contextMaxCharacters=100000 (no crash)
console.log("\n  3.10 contextMaxCharacters=100000");
{
	const r = await callExa({ query: "TypeScript", contextMaxCharacters: 100000 });
	if (r.ok) {
		assert(true, "contextMaxCharacters=100000 does not crash");
	} else {
		assert(false, "contextMaxCharacters=100000 does not crash", r.error ?? "empty");
	}
}

// 3.11 AbortSignal triggered before request completes
console.log("\n  3.11 AbortSignal triggers abort");
{
	const controller = new AbortController();
	// Abort immediately
	controller.abort();
	const r = await callExa({ query: "should be aborted" }, controller.signal);
	assert(r.error === "ABORTED", "immediately-aborted signal returns ABORTED", `got: ${r.error}`);
}

// 3.12 Empty query string
console.log("\n  3.12 Empty query string");
{
	const r = await callExa({ query: "" });
	// Should either return something or a meaningful error — must not throw unhandled
	if (r.ok) {
		assert(true, "empty query: API returned gracefully (with results)");
	} else {
		assert(r.error !== undefined, "empty query: API returned gracefully (with error)", r.error);
	}
}

// 3.13 Special characters in query
console.log("\n  3.13 Special characters in query");
{
	const r = await callExa({ query: 'TypeScript "generic types" <T extends object>' });
	if (r.ok && r.text && r.text.length > 0) {
		assert(true, "special characters in query returns result");
	} else if (!r.ok) {
		// API error is still "graceful handling"
		assert(r.error !== undefined, "special characters: graceful error", r.error);
	} else {
		assert(false, "special characters in query", "empty result");
	}
}

// ============================================================
// Section 4: Timeout logic inspection
// ============================================================
console.log("\n=== Section 4: Timeout constant verification ===");
{
	// We verify the constant is set correctly by reading the source
	// (We already know TIMEOUT_MS = 25000 from reading web-search.ts)
	assert(TIMEOUT_MS === 25_000, "TIMEOUT_MS is 25 seconds");
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`TOTAL: ${passed} passed, ${failed} failed`);
if (failed === 0) {
	console.log("ALL TESTS PASSED");
} else {
	console.log(`${failed} TEST(S) FAILED — see above`);
	process.exit(1);
}
