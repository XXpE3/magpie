# PR3：Provider 能力声明与 CLI 超时

## 目标

让调用方能明确判断 provider 能力，并保证所有 CLI provider 的 `chat()` 和 `chatStream()` 都有 timeout / abort 控制。

## 背景

当前 `disableTools`、repo 读取能力、session、abort、streaming 支持分散在具体实现中。调用方只能猜 provider 能否读仓库、能否禁用工具、能否取消请求。

同时，部分非 streaming CLI 调用没有 timeout，结构化、验证、预分析阶段可能长时间挂起。

## 范围

1. 在 `AIProvider` 增加 `capabilities`。
   - `canReadRepo`
   - `canUseTools`
   - `canDisableTools`
   - `supportsStreaming`
   - `supportsAbort`
   - `supportsSession`
2. 给所有 provider 填充能力声明。
   - API provider 默认不能读 repo。
   - CLI provider 根据工具能力声明。
3. 抽公共 CLI 子进程 runner。
   - 支持 stdin。
   - 支持 timeout。
   - 支持 AbortSignal。
   - 统一 stdout / stderr 收集。
4. 修改 CLI provider 复用 runner。
   - Claude Code
   - Codex CLI
   - Gemini CLI
   - Qwen Code
5. 修复 `disableTools + large prompt` 冲突。
   - 禁用工具时不使用“请读取临时文件”的 prompt。
   - 超大内容在应用内分批或报出明确错误。

## 不做

- 不调整 ReviewTarget。
- 不改 issue 结构化策略。
- 不改变 CLI 默认权限，默认权限由 PR2 负责。

## 影响文件

- `src/providers/types.ts`
- `src/providers/*.ts`
- `src/providers/process-control.ts`
- `src/utils/prompt-file.ts`
- `tests/providers/*`
- `tests/utils/prompt-file.test.ts`

## 验收标准

- 每个 provider 都声明能力。
- CLI `chat()` 和 `chatStream()` 都有 timeout。
- `disableTools` 时不会要求模型读取临时文件。
- 调用方可以根据 capability 做安全分支。

## 测试

- provider capability 测试。
- CLI timeout 测试。
- abort 测试。
- long prompt + disableTools 测试。
- 运行：

```bash
npm run build
npm run test:run
```
