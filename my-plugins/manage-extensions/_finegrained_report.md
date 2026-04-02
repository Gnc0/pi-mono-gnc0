# manage-extensions 当前实现说明（更新后）

> 说明：此前的细粒度检查报告基于旧实现。本文件反映当前已修复后的主要逻辑与一致性状态。

## 已完成的关键修复

- 增加了**重复扩展名检测**，发现重名即阻止继续应用。
- 扫描结果增加 `error` 字段，**扫描失败会显式提示**，不再伪装成“没有 repo 配置”。
- 首次调用命令时，若无缓存结果，会显示**扫描进度界面**，扫描完成后自动进入主列表。
- 主界面改为**单界面 TUI**：列表区 + 底部 `Apply / Back / Cancel` 操作区。
- 新增 **preflightChanges()**，在 apply 前预检查目标路径冲突、错误 symlink、非 symlink 文件等问题。
- `Apply` 按钮会在存在 blocking preflight issue 时禁用。
- 搜索逻辑已改为：**大小写无关的顺序子序列匹配**，例如 `g54` 可匹配 `gpt-5.4` 风格名称。
- 应用成功后会 `clearCache()`，避免后续继续使用旧扫描结果。

## 当前命令主流程

1. `/manage-extensions` 启动。
2. 若当前无 UI，则直接返回。
3. 启动后台扫描；若无缓存结果，则显示扫描进度界面。
4. 扫描完成后：
   - 若扫描失败，提示错误并结束。
   - 若没有找到扩展，提示检查 repo 配置并结束。
   - 若发现重复扩展名，逐条提示并结束。
5. 根据 symlink 解析每个扩展当前的 local/global 启用状态。
6. 打开主 TUI：
   - 列表区支持搜索、上下移动、左右切换 local/global、空格/回车切换勾选。
   - Tab 切到底部按钮区；按钮区支持 `Apply / Back / Cancel`。
7. 每轮进入列表前，都会基于当前 pending 变更计算 preflight issues，并在界面中展示。
8. 若点 `Apply`：
   - 生成变更集。
   - 若无变更，提示 `No changes`。
   - 执行 symlink 创建/删除。
   - 输出 warnings。
   - 若有成功应用项，则 reload。
9. 若点 `Cancel`，提示 `Cancelled`。

## 当前搜索规则

- 搜索文本：`repoName/extensionName`
- 匹配方式：
  - 先把 query 和候选文本都转成小写
  - 再做**顺序字符匹配**（subsequence match）
- 例如：
  - `omp` 可匹配 `oh-my-pi`
  - `mext` 可匹配 `manage-extensions`
  - `g54` 可匹配 `gpt-5.4-*`

## 当前扫描进度界面

显示内容包括：
- 当前 repo 名
- repo 进度：`当前 repo / 总 repo`
- 当前 entry 名
- entry 进度：`当前 entry / 当前 repo 总 entry`

按 `Esc` 可关闭进度查看界面，但后台扫描会继续。

## 当前剩余注意点

- `index.ts` 仍承担较多实现逻辑；若项目有“index.ts 只做 re-export”的规则，这里仍可继续拆分。
- 左右键 / Tab / Shift-Tab 仍依赖终端输入序列判断，只是现在已集中到 `createKeyMap()` 中统一管理。
- 目前没有自动清理“repo 配置删除后遗留的旧 symlink”这一类历史残留。
