/**
 * Test script for claude-compatible extension.
 * Spawns pi in RPC mode, loads the extension, sends a prompt, prints response.
 *
 * Usage: node test/test-claude-compatible.mjs
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(__dirname, "../examples/extensions/claude-compatible.ts");

// Spawn pi in RPC mode with the extension
const pi = spawn(
	"pi",
	[
		"--mode", "rpc",
		"--no-session",
		"--provider", "yunwu-openai",
		"--model", "claude-opus-4-6",
		"--extension", extensionPath,
	],
	{
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	}
);

// Collect stderr for debugging
pi.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

let buffer = "";

pi.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? ""; // keep incomplete line

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			handleEvent(event);
		} catch {
			console.error("[parse error]", line);
		}
	}
});

pi.on("exit", (code) => {
	console.log(`\n[pi exited with code ${code}]`);
});

let promptSent = false;

function sendPrompt() {
	const prompt = {
		id: "1",
		type: "prompt",
		message: "你好，请帮我做一个任务：列出当前目录的文件",
	};
	console.log("\n[sending prompt]\n");
	pi.stdin.write(JSON.stringify(prompt) + "\n");
}

function handleEvent(event) {
	// Print every event type for inspection
	if (event.type === "message_update") {
		const e = event.assistantMessageEvent;
		if (e?.type === "text_delta") process.stdout.write(e.delta);
		return;
	}

	if (event.type === "agent_end" || event.type === "turn_end") {
		console.log(`\n\n[event: ${event.type}]`);
		if (event.type === "agent_end") {
			// Done — exit
			pi.stdin.end();
			setTimeout(() => process.exit(0), 500);
		}
		return;
	}

	if (event.type === "response" && event.command === "prompt") {
		if (!event.success) {
			console.error("[prompt failed]", event.error);
			process.exit(1);
		}
		// prompt accepted, wait for agent_end
		return;
	}

	// Auto-respond to UI requests (model select, confirm dialogs, etc.)
	if (event.type === "extension_ui_request") {
		console.log(`[ui_request: ${event.method}]`, JSON.stringify(event).slice(0, 200));
		let response;
		if (event.method === "notify" || event.method === "setTitle" || event.method === "set_editor_text") {
			// Informational — no response needed
			// After the extension notify fires (session_start may have already fired), send prompt
			if (!promptSent) {
				promptSent = true;
				sendPrompt();
			}
			return;
		} else if (event.method === "select") {
			// Pick first option
			response = { type: "extension_ui_response", id: event.id, value: event.options?.[0] ?? "" };
		} else if (event.method === "confirm") {
			response = { type: "extension_ui_response", id: event.id, confirmed: true };
		} else {
			response = { type: "extension_ui_response", id: event.id, value: "" };
		}
		pi.stdin.write(JSON.stringify(response) + "\n");
		return;
	}

	if (event.type === "session_start" || event.type === "model_select") {
		console.log(`[event: ${event.type}]`, JSON.stringify(event).slice(0, 120));

		// Send prompt after session is ready
		if (event.type === "session_start" && !promptSent) {
			promptSent = true;
			sendPrompt();
		}
		return;
	}

	// Print other notable events
	if (!["tool_execution_start", "tool_execution_end", "message_start", "message_end"].includes(event.type)) {
		console.log(`[event: ${event.type}]`);
	}
}

// Timeout safety
setTimeout(() => {
	console.error("[timeout after 60s]");
	process.exit(1);
}, 60_000);
