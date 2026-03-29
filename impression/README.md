# Impression System

A single-file, plug-and-play extension for [pi](https://github.com/badlogic/pi-mono) that automatically compresses long tool results into compact "impressions" using the active LLM, storing the originals for on-demand recall.

## What is pi?

[pi](https://github.com/badlogic/pi-mono) is a **minimal terminal coding agent harness**. Unlike Claude Code or Cursor, pi itself ships almost no built-in features — no sub-agents, no plan mode, no context-compression tricks. Instead, it exposes a small extension API and lets you compose the behaviors you want from plain `.ts` files. Extensions are just TypeScript modules that hook into pi's event lifecycle; drop one into a folder and it's loaded on startup. No build step, no config ceremony.

Impression System is one such extension — a single `.ts` file, ~450 lines, zero external dependencies beyond what pi already bundles. Copy it in, and context compression is on. Remove it, and everything goes back to normal.

## The Problem

In long coding sessions, tool results (file reads, command outputs, search results) accumulate rapidly in the conversation context. Most of the content is read once, understood, and never referenced again — but it stays in the context window, consuming tokens and degrading model attention.

## How It Works

1. **Intercept** — hooks every `tool_result` event; if the text length exceeds a configurable threshold (default 2048 chars), distillation kicks in.
2. **Distill** — calls the active model with a specialized prompt that tells it: "you are compressing your own memory". The model produces a short note capturing what matters for the next step.
3. **Replace** — the original tool result is swapped out for the compressed impression, wrapped in `<impression id="...">` tags.
4. **Recall** — a `recall_impression` tool is registered. The agent can call it to retrieve the original content. On the first recall, the model re-distills with updated context (it may now know better what's important). After the configured number of recalls, full content is returned verbatim.

The distillation prompt is designed so the model treats it as self-compression, not third-party summarization. It receives the full visible history and system prompt, so impressions are context-aware — they emphasize what the agent will need next, not what a human reader would find interesting.

## Installation

Copy `impression-system.ts` into your pi extensions directory:

```bash
# Auto-discovery: place in the global or project-level extensions folder
cp impression-system.ts ~/.pi/agent/extensions/

# Or project-local
mkdir -p .pi/extensions
cp impression-system.ts .pi/extensions/
```

Alternatively, pass it as a flag:

```bash
pi --extension path/to/impression-system.ts
```

No additional dependencies are needed beyond what pi already provides (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@sinclair/typebox`).

## Configuration

Create `.pi/impression.json` in your project root (optional — all fields have defaults):

```json
{
  "skipDistillation": [],
  "minLength": 2048,
  "maxRecallBeforePassthrough": 1
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `skipDistillation` | `string[]` | `[]` | Tool names to never distill. Supports exact match (`"bash"`) and glob prefix (`"background_*"`). |
| `minLength` | `number` | `2048` | Minimum text length (chars) to trigger distillation. Results shorter than this pass through unchanged. |
| `maxRecallBeforePassthrough` | `number` | `1` | How many `recall_impression` calls return re-distilled notes before switching to full passthrough. |

Config is reloaded on every session start — edit it without restarting pi.

## What to Expect

### Signs It's Active

- **Status bar** shows `[impression] Distilling N chars with provider/model...` during compression.
- **Notifications** appear for skipped results:
  - `Skipped: content length 512 is below threshold of 2048` — too short, passed through.
  - `Skipped distillation for "bash" (configured in impression.json)` — tool is in the skip list.
- **Tool results in the conversation** are replaced with a note format:
  ```
  🧠 [MY INTERNAL MEMORY | ID: a1b2c3d4-...]
  I have already processed the raw output of this tool in the background for further processing.
  I trust these notes completely (EXCEPT WHEN REPORTING ERRORS). They are sufficient for all reasoning, planning, and answering for the CURRENT needs.

  --- MY NOTES ---
  Compact notes about the tool result...
  ----------------

  🛑 CRITICAL INSTRUCTION FOR MYSELF:
  - I MUST NOT call `recall_impression` just to 'verify' or 'get more context'.
  - However, I should NOT hesitate to use `recall_impression` when precise, verbatim information is required for the next action (e.g., `edit`, `write`), or new information is needed and additional information should be extracted in the FUTURE.
  ```
- A **`recall_impression` tool** appears in the agent's tool list.

### Signs It's Working Well

- The agent **continues working fluidly** after reading a large file — it doesn't lose track of what it found.
- You see **fewer tokens consumed** per turn in long sessions (check usage stats if your provider reports them).
- The agent **calls `recall_impression`** when it actually needs exact text (e.g., before editing a file), and gets the right content back.
- Distilled notes are **shorter than the original** but capture the key information. If the model returns `<passthrough/>`, the system recognizes the content was too important to compress and passes it through unchanged.

### Signs Something Needs Tuning

- The agent keeps calling `recall_impression` immediately after every impression → your `minLength` may be too low (the model needs the full content more often than expected). Raise it.
- Important details are lost and the agent makes mistakes → lower `maxRecallBeforePassthrough` to `0` for faster full-content access, or add the tool to `skipDistillation`.
- Distillation takes too long → it uses the active model for compression. If you're on a slow model, the latency is per-tool-call. Consider raising `minLength` to distill less often.

## Effect on Context Window

In a typical session that reads 20+ files, the impression system can reduce context usage by 40–70%. The exact savings depend on:

- How large individual tool results are (bigger = more compression opportunity)
- How aggressive the model is at distillation (varies by model)
- How often the agent needs to recall originals

The system is conservative by design: if the model can't compress effectively (output ≥ input length), or returns the `<passthrough/>` sentinel, the original content is kept. Nothing is silently lost.

## Session Persistence

Impressions survive session restarts. The extension writes entries to pi's session storage (`impression-v1` entry type). On the next `session_start`, the impression map is rebuilt from stored entries.

## How the Distillation Prompt Works

The key insight is framing distillation as **self-compression**: the model is told it's the same agent, choosing what to remember. It receives:

- The full **visible history** up to the current point
- The **original system prompt**
- The **tool result** to compress

The model can use `<thinking>` tags to reason privately (stripped from the impression, shown as a notification). It's instructed to:

- Focus on what the outer self needs **next**, not what's generally interesting
- Return `<passthrough/>` when exact content is critical (e.g., short outputs needed verbatim for editing)
- Reference information already in the visible history instead of repeating it
- Append an "Also contains:" line listing significant sections that were omitted

This produces impressions that are genuinely useful to the agent — not generic summaries, but targeted working notes.
