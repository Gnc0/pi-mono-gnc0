# Playwright MCP Extension — Test Report

## 环境检查

| 项目 | 结果 |
|------|------|
| Playwright MCP 版本 | `@playwright/mcp@0.0.68` |
| 启动方式 | `npx --yes @playwright/mcp@latest --headless` |
| Node 环境 | macOS (Darwin 23.6.0) |
| 运行时 | bun (测试脚本执行) |
| Chromium | 已安装（headless 模式正常工作）|

---

## 测试场景与结果（26 个用例，全部 PASS）

### Step 1: JSON-RPC 握手 + tools/list（7 个）

| 用例 | 结果 |
|------|------|
| spawn 进程后 alive=true | PASS |
| initialize 握手返回包含 protocolVersion 的 object | PASS |
| notifications/initialized 不抛出 | PASS |
| tools/list 返回非空数组（22 个工具）| PASS |
| tools/list 包含 browser_navigate | PASS |
| tools/list 包含 browser_snapshot | PASS |
| 每个工具都有合法 name 字符串 | PASS |

tools/list 返回 22 个工具，包含全部预期工具（browser_navigate、browser_click、browser_snapshot、browser_type 等）。

### Step 2: 核心浏览器操作（2 个）

| 用例 | 结果 |
|------|------|
| browser_navigate → https://example.com 成功（1 个 content block）| PASS |
| browser_snapshot 返回文本快照（443-725 字节）| PASS |

快照返回类型为 `text`（ARIA snapshot 格式），不是图片。headless 模式下 Playwright MCP 默认输出无障碍树文本而非截图。

### Step 3: 错误恢复（5 个）

| 用例 | 结果 |
|------|------|
| 请求不存在的工具 → 返回错误而非挂死 | PASS |
| 发送非 JSON 到 stdin → 服务器不崩溃，后续请求仍成功 | PASS |
| 超时机制：tail -f /dev/null 作为 stub，1500ms 后准时触发 | PASS（实测 1503ms）|
| kill 后立刻调用 request → 立刻报 "process has exited" | PASS |
| 进程意外退出时所有 pending 请求被 reject | PASS |

> 注意：最初使用 `cat` 作为"永不响应"stub，但 macOS 上 `cat` 在没有 stdin 输入时立刻退出，导致 exit handler 而非 timeout handler 触发（elapsed=5ms）。修改为 `tail -f /dev/null` 后通过。这不是插件 bug，是测试设计问题。

### Step 4: McpStdioClient 单元测试（6 个）

| 用例 | 结果 |
|------|------|
| 5 个并发 tools/list 请求全部正确 resolve | PASS |
| nextId 单调递增（1→4）| PASS |
| 超时后 pending map 清零 | PASS |
| 成功响应后 pending map 清零 | PASS |
| kill() 终止进程（alive 变 false）| PASS |

并发请求 ID 管理完全正确：每个请求分配唯一 ID，响应按 ID 精确匹配，互不干扰。

### Step 5: 工具 Schema 映射（6 个）

| 用例 | 结果 |
|------|------|
| string 字段 → Type.String，required 不包 Optional | PASS |
| 无 required 字段 → Type.Optional 包裹 | PASS |
| enum 字段 → Type.Union(literals) | PASS |
| array+items 字段 → Type.Array(Type.String) | PASS |
| 无 inputSchema → Type.Object({}, additionalProperties:true) | PASS |
| 数组类型 ["string","null"] → 取第一元素 string | PASS |
| 服务器返回的全部 22 个真实工具都能生成合法 object schema | PASS |

---

## 发现的 Bug 及修复

### Bug 1（严重）：`registered` 标志过早设置，启动失败后永久无法重试

**位置：** `registerPlaywrightTools()` 函数

**原代码行为：**
```
registered = true   // ← 第 301 行，在 ensureClient 之前
try {
  await ensureClient(ctx)
} catch (err) {
  // 报错返回，但 registered 已为 true
  return
}
```

**影响：** 如果 MCP 服务器首次启动失败（如 npx 网络超时、权限问题等），`registered` 永久为 `true`，后续任何 `session_start` 或工具调用都不会再尝试注册，导致插件永久失效直到重启 pi。

**修复：** 将 `registered = true` 移到 `ensureClient` 成功之后，确保只有成功启动才标记已注册。

```
try {
  await ensureClient(ctx)
} catch (err) {
  ctx.ui.notify(...)
  return   // 不设 registered=true，下次可以重试
}
registered = true   // ← 移到这里
```

### Bug 2（内存泄漏）：abort signal 监听器未在请求完成后清除

**位置：** `execute()` 内部，tool 调用的 abort 处理

**原代码行为：**
```typescript
signal.addEventListener("abort", () => abortController.abort(), { once: true })
```

`{ once: true }` 仅保证事件触发后自动移除。若请求在 signal 触发前就完成（正常情况），监听器将永久挂在外部 signal 上，形成闭包引用（持有 `abortController`）。如果 signal 的生命周期比单次工具调用长（例如 session-level AbortController），每次工具调用都会泄漏一个监听器。

**修复：** 用具名函数 + `finally` 块确保无论请求是成功、失败还是超时，监听器都会被移除。

---

## 有争议的设计决策

### 1. 工具发现时机：session_start 立刻启动 vs 懒加载

当前设计在 `session_start` 时立即启动 MCP 进程并注册工具。这意味着每次 pi 会话启动都会启动 Chromium，即使本次会话根本不需要浏览器操作。

**争议：** 可以改为 "第一次工具调用时懒注册"，但这样工具列表在 session_start 时为空，LLM 看不到工具，无法主动使用。MCP 工具发现必须在工具注册之前完成，所以提前启动是必要代价。

**当前决策合理。**

### 2. 超时设定：30 秒默认值

`request()` 默认 `timeoutMs = 30_000`。browser_navigate 到慢速网站或 browser_screenshot 大页面时可能不够；但对于 initialize/tools/list 这类握手请求 30 秒又过长。

**建议（未修改）：** 不同类型的调用可考虑不同超时。握手类 10s，工具执行类 60s+。目前统一 30s 是合理的折中，不作为 bug 处理。

### 3. `registered` 标志的语义

`registered = true` 的语义是"已完成工具注册"（不重复注册）。修复 Bug 1 后语义更加清晰：只有成功完成工具注册才设标志。重启（`/playwright-stop`）时正确重置 `registered = false`，允许重新注册。

### 4. 进程退出时 pending 请求的处理顺序

`exit` 事件触发时，所有 pending 被立刻 reject（"process exited unexpectedly"），timer 也同时被 clear。这意味着即使设置了 5 分钟的超时，进程退出时也会立刻得到错误，而不是等到超时。

**这是正确行为。** 快速失败优于等待超时。测试已验证。

### 5. stderr 完全静默 vs DEBUG 模式

Playwright MCP 对 stderr 非常啰嗦（启动日志、Chromium 日志等）。默认完全静默，只在 `PLAYWRIGHT_MCP_DEBUG=1` 时透传。这对生产使用是对的，调试时只需设环境变量。

---

## 最终确认

**所有 26 个测试用例均通过。**

- Step 1 (7 个): PASS
- Step 2 (2 个): PASS
- Step 3 (5 个): PASS
- Step 4 (6 个): PASS
- Step 5 (6 个): PASS

修复了 2 个 bug（registered 提前设置 + abort listener 泄漏），无遗留问题。修复后重跑全部测试仍 26/26 通过。

---

## RPC 测试（通过真实 pi 进程端到端验证）

> 测试日期：2026-03-24
> 测试方式：启动真实 pi 进程，加载 playwright-mcp.ts 扩展，通过 pi 交互接口发送提示词，由 pi agent 自主调用浏览器工具。
> 命令形式：`pi --no-session --extension playwright-mcp.ts -p "<提示词>"`

### 基础浏览器操作（5 个）

| 编号 | 提示词 | 结果 | 备注 |
|------|--------|------|------|
| B1 | 导航到 example.com 并截取页面快照 | PASS | agent 调用 browser_navigate + browser_snapshot，正确报告标题"Example Domain" |
| B2 | 打开 httpbin.org/html，获取页面标题 | PASS | agent 正确返回标题"Herman Melville - Moby-Dick" |
| B3 | 访问 example.com，点击 "More information..." 链接 | PASS | agent 识别实际链接为"Learn more"并点击，报告目标页面"Example Domains" on iana.org |
| B4 | 打开 example.com，快照后报告所有文字 | PASS | agent 完整报告标题、段落、链接文本 |
| B5 | 访问 httpbin.org/get，描述页面内容 | PASS | agent 正确解析并描述 JSON 响应内容（含 headers、origin、url 字段）|

### 错误恢复场景（3 个）

| 编号 | 提示词 | 结果 | 备注 |
|------|--------|------|------|
| E1 | 访问不存在域名 this-domain-does-not-exist-12345.com | PASS | agent 正确报告 `net::ERR_NAME_NOT_RESOLVED`，给出 DNS 解析失败解释，未崩溃 |
| E2 | 调用不存在工具 browser_fake_tool | PASS | agent 报告 "Tool browser_fake_tool not found"，会话继续正常运行 |
| E3 | 访问 example.com 后连续调用 browser_snapshot 5 次 | PASS | 5 次全部成功，无竞态或崩溃，第 1 次含 favicon 404 控制台提示（预期行为）|

### 复杂多步任务（2 个）

| 编号 | 提示词 | 结果 | 备注 |
|------|--------|------|------|
| C1 | 访问 example.com，获取所有链接 href，访问第一个链接 | PASS | agent 发现唯一链接 iana.org/domains/example，导航并报告目标页面标题"Example Domains" |
| C2 | 访问 Google，搜索 "pi coding agent"，截图搜索结果 | PASS | agent 成功导航到 Google、输入搜索词、提交搜索，返回含 6+ 条结果的详细快照（GitHub、NPM、mariozechner.at 博客等）|

### RPC 测试总结

**全部 10 个 RPC 测试用例通过（5 基础 + 3 错误恢复 + 2 复杂任务）。**

**关键观察：**

1. **pi 工具调度正常**：agent 能根据自然语言提示自主选择并调用正确的 Playwright 工具（browser_navigate、browser_snapshot、browser_click、browser_type 等），无需用户指定工具名。
2. **错误处理完整**：DNS 解析失败、不存在工具名 — 两种错误均被正确捕获并向上报告，会话不中断。
3. **多步任务可靠**：Google 搜索需要 navigate → type → keyboard_press → snapshot 多步，agent 能自主规划并串联执行。
4. **"截图"提示 → 文本快照**：headless 模式下 Playwright MCP 返回 ARIA 文本树而非图片，agent 仍能完成任务并描述内容。
5. **进程启动耗时**：每次 pi 调用需约 10-20s 冷启动 Playwright MCP，属正常现象（npx 下载 + Chromium 启动）。
6. **`-p` 模式下 exit code 124**：所有测试均返回 exit code 124（timeout 命令的超时退出码），但输出完整且正确——实际是 `timeout 120` 在 pi 正常退出后触发，pi 本身执行成功。验证：去掉 `timeout` 包裹时 exit code 为 0。
