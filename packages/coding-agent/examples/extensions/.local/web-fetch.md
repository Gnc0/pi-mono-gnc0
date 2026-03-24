# web-fetch.ts Test Report

**Date**: 2026-03-23
**Test file**: `/tmp/test-web-fetch.mjs`
**Source**: `packages/coding-agent/examples/extensions/web-fetch.ts`

## Summary

| Result | Count |
|--------|-------|
| PASS   | 26    |
| FAIL   | 0     |
| TOTAL  | 26    |

All 26 tests passed. No bugs found.

---

## Unit Test Scenarios

### decodeHtmlEntities (8 tests)

| # | Scenario | Status |
|---|----------|--------|
| 1 | `&amp;lt;` decodes to `&lt;` (not `<`) — single-pass guarantee | PASS |
| 2 | `&lt;` decodes to `<` | PASS |
| 3 | `&amp;` decodes to `&` | PASS |
| 4 | `&quot;` decodes to `"` | PASS |
| 5 | `&copy;` decodes to `©` | PASS |
| 6 | `&#65;` (decimal) decodes to `A` | PASS |
| 7 | `&#x41;` (hex) decodes to `A` | PASS |
| 8 | Unknown entity `&unknownentity;` preserved as-is | PASS |

### htmlToText — tag stripping (5 tests)

| # | Scenario | Status |
|---|----------|--------|
| 9  | `<script>alert('xss')</script>` content stripped | PASS |
| 10 | Surrounding `<p>` text preserved after script strip | PASS |
| 11 | Multiline `<script type='text/javascript'>` stripped | PASS |
| 12 | `<style>body { color: red; }</style>` content stripped | PASS |
| 13 | Content preserved after style strip | PASS |

### htmlToMarkdown — conversion (4 tests)

| # | Scenario | Status |
|---|----------|--------|
| 14 | `<h1>Title</h1>` converts to `# Title` | PASS |
| 15 | `<strong>bold</strong>` converts to `**bold**` | PASS |
| 16 | `<a href="...">text</a>` converts to `[text](url)` | PASS |
| 17 | `<script>` content stripped in htmlToMarkdown | PASS |

---

## Integration Test Scenarios

| # | Scenario | Status | Notes |
|---|----------|--------|-------|
| 18 | `fetch https://example.com` returns non-empty markdown (>50 chars) | PASS | |
| 19 | Markdown output has no `<html>` tags | PASS | |
| 20 | Markdown output contains actual content | PASS | Contains "Example" |
| 21 | `format=text`: no HTML tags in output | PASS | |
| 22 | `format=text`: has actual text content | PASS | |
| 23 | `format=html`: contains `<html>` or `<!DOCTYPE>` | PASS | Raw HTML preserved |
| 24 | `timeout=1s` with httpbin delay/10: throws timeout error, does not hang | PASS | |
| 25 | `ftp://example.com` rejected by `execute()` (non-http/https) | PASS | Throws "http" |
| 26 | `https://example.com/404xyz` throws error with status info | PASS | "404" in message |

---

## Bugs Found

None. All scenarios passed on first run.

---

## Design Decisions

### Single-pass entity decoding
`decodeHtmlEntities` uses a single `.replace()` call with a regex that matches all entity forms simultaneously. This prevents double-decoding: `&amp;lt;` becomes `&lt;` (not `<`), which is correct — the outer `&amp;` is the only entity to decode at each pass.

### stripTagRegex — content-strip (not security sanitiser)
The `stripTagRegex(tag)` function builds a regex that strips paired tags like `<script>...</script>` and `<style>...</style>`. It handles optional whitespace in closing tags (`</script  >`). The comment in source correctly notes this is for LLM text extraction, not a security sanitiser.

The regex used:
```
/<script\b[^<]*(?:(?!<\/script\s*>)<[^<]*)*<\/script\s*>/gi
```
This uses a tempered greedy token pattern. It correctly handles multiline scripts because the regex does not use the `s` (dotAll) flag — instead the alternation `[^<]*` already matches newlines since `[^<]` is newline-inclusive by default.

### Timeout implementation
Timeout is implemented via `setTimeout` + `AbortController`. The abort signal is forwarded to `fetch()`. On abort, the catch block detects `err.name === "AbortError"` or `err.message.includes("abort")` and re-throws as a human-readable timeout error: `"Request timed out after Xs"`.

### URL scheme validation
`execute()` checks `params.url.startsWith("http://") || params.url.startsWith("https://")` before issuing any network call. Non-http schemes (ftp, file, data, etc.) are synchronously rejected with `throw new Error("URL must start with http:// or https://")`. The `assertRejects` test verifies the rejection occurs before any fetch attempt.

### HTTP error handling
Non-2xx responses trigger `throw new Error(`Request failed: ${status} ${statusText}`)`. The test verified this with a 404 path on example.com. The error message reliably includes the status code.

### Format routing
- `format=html`: raw text passthrough, no transformation
- `format=text`: `htmlToText()` applied only when `Content-Type` includes `text/html`; plain-text/markdown responses pass through unchanged
- `format=markdown` (default): `htmlToMarkdown()` applied only for HTML content-type; non-HTML (JSON, plain text, etc.) passes through unchanged

---

## RPC 测试（通过真实 pi 进程）

**日期**: 2026-03-24
**方法**: 通过 `echo "..." | pi --print --no-session --no-extensions -e web-fetch.ts` 启动真实 pi 进程，让 pi agent 自主决定调用 web_fetch 工具。非脚本绕过，全部通过 pi RPC 通道执行。

| # | 提示词意图 | 工具参数（pi 自选） | 结果 | 状态 |
|---|-----------|-------------------|------|------|
| 1 | 以 markdown 格式获取 https://example.com 并总结 | `url=https://example.com, format=markdown` | 返回页面摘要（"Example Domain，用于文档示例占位"），内容合理 | PASS |
| 2 | 以 text 格式获取 https://httpbin.org/html，确认无 HTML 标签 | `url=https://httpbin.org/html, format=text` | 无标签，返回《白鲸记》节选纯文本 | PASS |
| 3 | 获取 https://httpbin.org/status/404，告知结果 | `url=https://httpbin.org/status/404` | 工具抛出 "404 NOT FOUND" 错误，pi 正确汇报 | PASS |
| 4 | 获取 https://httpbin.org/delay/5，timeout=2 | `url=https://httpbin.org/delay/5, timeout=2` | 2 秒超时，工具抛出 "Request timed out after 2s"，pi 正确描述 | PASS |
| 5 | 以 html 格式获取 https://example.com | `url=https://example.com, format=html` | 原始 HTML 返回，含 `<!doctype html>`、`<html lang="en">` 等标签 | PASS |

**全部 5/5 通过。**

### 观察

- pi 在所有情况下都正确理解自然语言并选择了合适的工具参数。
- `timeout` 参数在测试 4 中被 pi 正确传递为数值 `2`，工具按预期超时。
- format=html 测试（#5）首次提示词过于简单导致 pi 输出为空（pi 可能受上下文长度限制截断了大段 HTML 输出）；调整提示词为"告诉我返回内容是否包含 HTML 标签"后成功。
- 错误响应（404、超时）均通过工具 `throw` 传递给 pi，pi 能正确汇报给用户。

---

## 目录型重构（2026-03-24）

**源文件**: `packages/coding-agent/examples/extensions/web-fetch/` (目录型 Extension)
**删除**: `packages/coding-agent/examples/extensions/web-fetch.ts` (旧单文件形式)

### 为什么改用 turndown

原版 opencode（https://github.com/anomalyco/opencode）的 WebFetch 工具本身就使用 turndown 库进行 HTML → Markdown 转换。手写正则链虽然无外部依赖，但覆盖面有限（缺少表格的完整格式化、嵌套列表、定义列表等），且难以维护。turndown 是成熟的 HTML → Markdown 转换库，处理边缘情况更健壮。

### 目录结构

```
packages/coding-agent/examples/extensions/web-fetch/
├── package.json          # pi.extensions 入口声明 + turndown 依赖
├── index.ts              # Extension 主文件（从 web-fetch.ts 迁移）
├── bun.lockb             # bun 锁文件
└── node_modules/         # turndown + @types/turndown
```

### package.json 格式

参照 `with-deps/` 目录：`"pi": { "extensions": ["./index.ts"] }` 字段声明入口，jiti 加载器遇到目录时读取此字段找到入口文件，`node_modules/` 内依赖被 jiti 正常解析。

```json
{
  "name": "@pi-extensions/web-fetch",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {
    "turndown": "^7.2.0"
  },
  "devDependencies": {
    "@types/turndown": "^5.0.5"
  }
}
```

### htmlToMarkdown 实现对比

**旧实现（手写正则链，已删除）**：
- 约 70 行的链式 `.replace()` 调用
- 逐一处理标题、链接、图片、代码块、粗体/斜体、列表、段落、表格等
- 依赖 `stripTagRegex()` 自定义函数清理 script/style

**新实现（TurndownService）**：
```typescript
function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.remove(["script", "style", "meta", "link", "nav", "header", "footer"]);
  return td.turndown(html);
}
```
- 6 行代码，交由 turndown 处理所有 HTML 结构
- `td.remove()` 声明式地过滤无需转换的标签（script、style、nav 等）

### 删除的内容

以下内容从 index.ts 中删除（turndown 已内置同等功能）：
- `stripTagRegex()` 函数（tempered greedy token 正则构造器）
- `NAMED_HTML_ENTITIES` 常量（命名实体映射表）
- 原 `htmlToMarkdown()` 中的完整正则转换链（70+ 行）

保留的内容：
- `decodeHtmlEntities()` — text 格式路径仍需单独使用
- `stripTagRegex()` — `htmlToText()` 内部仍依赖此函数
- `htmlToText()` — text 格式路径不走 turndown，保持原有实现
- 所有 execute 逻辑（超时、Cloudflare 检测、图片处理）原封不动

### 验证结果

```bash
cd packages/coding-agent/examples/extensions/web-fetch
bun run /tmp/verify-turndown.ts
```

输出：
```
# Hello

World & **bold**
```

符合预期：`<h1>` → `# Hello`，`&amp;` → `&`，`<strong>` → `**bold**`。
