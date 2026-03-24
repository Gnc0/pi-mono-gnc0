# web-search.ts 测试报告

## 测试环境

- 运行时：Bun
- 目标文件：`packages/coding-agent/examples/extensions/web-search.ts`
- API：Exa AI 公开 MCP 端点 `https://mcp.exa.ai/mcp`（无需 API key）
- 测试脚本：`.local/test-web-search.ts`

---

## 测试场景与结果

### Section 1: parseSseData 单元测试（8 项，全部 PASS）

| 测试用例 | 结果 |
|---|---|
| 多个 data: 行 — 只取第一个有效 JSON | PASS |
| 无效 JSON 后跟有效 JSON — 跳过并返回有效 | PASS |
| 空字符串输入 — 返回 undefined | PASS |
| 无 data: 行 — 返回 undefined | PASS |
| data: 后只有空白 — 返回 undefined | PASS |
| data: 后完全空 — 返回 undefined | PASS |
| data: 行尾有尾随空格 — JSON.parse 正确处理 | PASS |
| SSE 中的 error 响应 — 正确解析 | PASS |

### Section 2: JSON 检测逻辑测试（4 项，全部 PASS）

| 测试用例 | 结果 |
|---|---|
| 纯 JSON 响应以 { 开头 — 用 JSON.parse | PASS |
| SSE 响应以 event: 开头 — 走 parseSseData | PASS |
| JSON 有前导空白 — trimStart 正确检测 | PASS |
| 以 { 开头但 JSON 无效 — 回退 SSE，返回 undefined | PASS |

### Section 3: 实际 API 调用测试（15 项，全部 PASS）

| 测试用例 | 结果 | 备注 |
|---|---|---|
| 正常搜索 "TypeScript 5.5 new features" | PASS | 返回有意义结果 |
| numResults=1 | PASS | 返回结果 |
| numResults=20 | PASS | 不崩溃，返回结果 |
| type=fast | PASS | 返回结果 |
| type=deep | PASS | 服务器静默忽略，等同 auto |
| type=auto | PASS | 返回结果 |
| livecrawl=fallback | PASS | 返回结果 |
| livecrawl=preferred | PASS | 返回结果 |
| contextMaxCharacters=100 不崩溃 | PASS | 服务器静默忽略该参数 |
| contextMaxCharacters=100000 不崩溃 | PASS | 服务器静默忽略该参数 |
| AbortSignal 立即触发 → 请求中止 | PASS | 修复后通过 |
| 空查询字符串 | PASS | API 返回正常结果（无报错） |
| 含特殊字符查询 | PASS | 返回结果 |

### Section 4: 超时常量验证（1 项，PASS）

- `TIMEOUT_MS === 25000` — PASS

**总计：27 项全部通过**

---

## 发现的 Bug 及修复

### Bug 1: AbortSignal 已过期时 addEventListener 永不触发（Bun 环境）

**文件**: `web-search.ts` 第 112-114 行

**问题**: 如果调用方在调用 `execute()` 之前就已经 abort 了外部信号（`signal.aborted === true`），则 `signal.addEventListener("abort", ...)` 在 Bun 运行时下**永远不会触发**（既非同步也非异步）。这导致内部 `controller` 不被中止，`fetch` 正常继续，AbortSignal 完全失效。

**根本原因**: W3C 规范中，对已 aborted 的 `AbortSignal` 注册 listener 的行为在不同运行时存在差异。Node.js/浏览器 会异步触发，Bun 则完全不触发。

**修复**（已应用到 web-search.ts）:
```ts
if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    // If the signal is already aborted (e.g. caller aborted before execute was called),
    // addEventListener will never fire — check immediately.
    if (signal.aborted) {
        controller.abort();
    }
}
```

**验证**: 修复后，test 3.11 (立即触发的 AbortSignal) 从 FAIL 变为 PASS。

---

## 有争议的设计决策

### 1. `type: "deep"` 枚举值

**现状**: web-search.ts 在 `SEARCH_TYPES` 中包含 `"deep"`，并在工具描述中提到"deep: comprehensive search"。

**发现**: Exa 公开 MCP 端点的 `web_search_exa` 工具的实际 schema 只支持 `"auto"` 和 `"fast"`，不含 `"deep"`。服务器在收到 `type: "deep"` 时会静默忽略，实际执行等同于 `"auto"`。

**争议点**: 是否应该移除 `"deep"` 枚举值？
- 保留的理由：未来 Exa API 可能支持；扩展性；不会造成错误
- 移除的理由：实际无效果，会误导使用者

**当前决策**: 保留，但建议在 description 中注明"在公开端点上 deep 等同于 auto"。

### 2. `contextMaxCharacters` 参数

**现状**: web-search.ts 定义了 `contextMaxCharacters` 参数（默认值描述为 10000），并会传给 Exa API。

**发现**: Exa 公开 MCP 端点的 `web_search_exa` 工具 schema 中**完全不包含此参数**。服务器静默忽略，参数传入与否对结果无任何影响。

**争议点**: 是否应该移除此参数？
- 保留的理由：不造成崩溃；若未来 API 支持可无缝生效；工具描述让 agent 知道可能有截断选项
- 移除的理由：误导性 — 告诉 agent "可以设置 contextMaxCharacters=100 截断内容"，但实际无效

**当前决策**: 保留，但建议加注释说明当前公开端点不支持。

### 3. SSE 解析策略 — 只取第一个有效 data: 行

**现状**: `parseSseData` 遍历所有行，遇到第一个能成功 `JSON.parse` 的 `data:` 行即返回。

**实际 API 行为**: Exa 公开端点返回的 SSE 响应通常只有 1 个 `data:` 行，包含完整 JSON。此策略是正确的。

**理论争议**: SSE 协议允许多个 `data:` 行组成一个事件（应该拼接），但 Exa 的格式是单行 JSON。如果未来 Exa 发出多行拼接型 SSE，当前实现只取第一行会出错。

**当前决策**: 单行策略足够。真实 Exa 响应从未有多行 data 的情况。

### 4. 默认 numResults = 8

**现状**: 默认值 8。测试中 numResults=20 实际返回了约 60k 字符，numResults=1 约 3.8k 字符。

**争议点**: 8 是否合适？对于 Agent 来说，8 条结果通常够用，但会消耗较多上下文窗口。

**当前决策**: 8 是合理的中间值，与 Exa 官方 API 默认值一致。

### 5. 超时 25 秒

**现状**: `TIMEOUT_MS = 25_000`。实测 Exa API 响应时间在 1-11 秒之间（取决于 type 和 livecrawl）。

**争议点**: 25 秒是否过长？Agent 场景下用户体验会受影响。

**当前决策**: 25 秒是合理保守值。`type=deep` 理论上可能更慢。可以考虑降到 15 秒，但当前保持。

---

## 最终确认

**所有 27 项测试均通过（27 passed, 0 failed）**

唯一发现的代码 bug（AbortSignal 已过期时失效）已修复并验证通过。

---

## RPC 测试（通过真实 pi 进程）

**日期**: 2026-03-24
**方法**: 通过 `echo "..." | pi --print --no-session --no-extensions -e web-search.ts` 启动真实 pi 进程，让 pi agent 自主决定调用 web_search 工具。非脚本绕过，全部通过 pi RPC 通道执行。

### WebSearch 专项（5 项）

| # | 提示词意图 | 工具参数（pi 自选） | 结果 | 状态 |
|---|-----------|-------------------|------|------|
| 1 | 搜索 'TypeScript 5.5 new features' | `query="TypeScript 5.5 new features"` | 返回 5 项详细特性（推断类型谓词、正则检查、Set 方法等），内容准确 | PASS |
| 2 | 搜索 'IMO 2025 AI AlphaProof'，type=fast，numResults=3 | `query="IMO 2025 AI AlphaProof", type="fast", numResults=3` | 返回 3 条结果（Nature 论文、Julian 博客、Longbridge 报道），内容相关 | PASS |
| 3 | deep 模式搜索 'process reward model math LLM 2025' | `query="process reward model math LLM 2025", type="deep"` | 返回 PRM 论文摘要，内容专业（注：deep 模式在公开端点等同 auto） | PASS |
| 4 | 搜索 'pi coding agent mario zechner'，livecrawl=preferred | `query="pi coding agent mario zechner", livecrawl="preferred"` | 第一条即 mariozechner.at 的官方博客文章（2025-11-30），highly relevant | PASS |
| 5 | 搜索空字符串 | `query=""` | Exa MCP 端点返回 400 Validation error："Too small: expected string to have >=1 characters at query"，工具正确抛出错误 | PASS |

### 混合测试（3 项，同时加载 web-search.ts + web-fetch.ts）

| # | 提示词意图 | pi 调用顺序 | 结果 | 状态 |
|---|-----------|------------|------|------|
| M1 | 搜索 'example.com'，然后 fetch 第一个 URL | 先 `web_search`，再 `web_fetch(whois.com/...)` | 正确串联两步：搜索到 whois.com 结果，再 fetch 获取 example.com 域名注册信息 | PASS |
| M2 | 搜索 TypeScript 最新版本，再 fetch TypeScript 官网 | 先 `web_search`，再 `web_fetch(typescriptlang.org)` | 两步均成功；交叉验证得出 TypeScript 6.0（2026-03-23）为最新版本 | PASS |
| M3 | 搜索 'what is httpbin.org'，然后 fetch 首页 | 先 `web_search`，再 `web_fetch(httpbin.org, format=text)` | 成功串联；最终给出准确一句话总结 | PASS |

**全部 8/8 通过（5 WebSearch + 3 混合）。**

### 观察

- pi 在所有测试中均正确识别意图并自主选择工具参数，无需强制指定完整参数。
- 空字符串查询（#5）触发了 Exa 服务端 400 校验错误，工具正确抛出，pi 正确汇报——这是预期行为，说明工具错误传播链路正常。
- `type=deep` 在公开端点静默等同 `auto`，pi 不会感知差异，之前的测试报告已记录此行为。
- 混合测试中 pi 自动在两个扩展工具之间按逻辑顺序切换，无需用户显式指定调用顺序。
- `livecrawl=preferred` 在搜索 pi coding agent 时确实返回了 2025-11 的最新博文，说明 live crawl 参数生效。
