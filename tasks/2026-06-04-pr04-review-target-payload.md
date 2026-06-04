# PR4：统一 ReviewTarget 构建

## 目标

PR、local、branch、files 审查都先生成统一 `ReviewTarget`，确保 context gatherer 和 API provider 能拿到真实 diff 或文件内容。

## 背景

CLI-only PR 当前可能只把 PR URL 放进 prompt，context gatherer 从 prompt 中提取不到真实 diff。branch / files 审查对 API provider 也不可用，因为 API provider 只能看到一句自然语言说明。

## 范围

1. 引入 `ReviewTarget`。
   - `kind`
   - `label`
   - `repoRoot`
   - `repo`
   - `prNumber`
   - `prUrl`
   - `baseBranch`
   - `headSha`
   - `diff`
   - `files`
2. 引入 `ReviewTargetPayload`。
   - `promptForCli`
   - `promptForApi`
   - `diff`
   - `files`
3. PR 审查独立获取 diff。
   - context gatherer 使用 `target.diff`。
   - reviewer prompt 是否嵌入 diff 由 provider capability 决定。
4. branch 审查获取 `git diff base...HEAD`。
5. files 审查为 API provider 嵌入文件内容。
6. base branch 不再写死为 `main`。
   - PR 从 GitHub metadata 获取。
   - branch 从 CLI option 或默认配置获取。

## 不做

- 不重写 orchestrator round 逻辑。
- 不修改 issue 提取。
- 不修改 GitHub 发布逻辑。

## 影响文件

- `src/commands/review.ts`
- `src/orchestrator/orchestrator.ts`
- `src/orchestrator/types.ts`
- `src/context-gatherer/gatherer.ts`
- `tests/e2e/review.test.ts`
- `tests/orchestrator/*`
- `tests/context-gatherer/*`

## 验收标准

- CLI-only PR 的 context gatherer 能拿到真实 diff。
- API provider 审查 branch 时能看到 diff。
- API provider 审查 files 时能看到文件内容或收到明确错误。
- base branch 可由 target 传递。

## 测试

- CLI-only PR + context gatherer 测试。
- branch review + API provider 测试。
- files review + API provider 测试。
- 非 `main` base branch 测试。
- 运行：

```bash
npm run build
npm run test:run
```
