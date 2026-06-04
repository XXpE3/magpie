# PR10：Repo review 复用统一 issue schema

## 目标

让 repo review 使用与 PR review 一致的 issue schema，并让 API provider 能基于真实文件内容审查。

## 背景

repo review 当前更像独立原型。它要求模型输出 `ISSUE: [location] - [description] - [severity]`，解析依赖 regex，字段少，稳定性弱。API provider 只看到文件路径，看不到文件内容，容易基于文件名猜测。

## 范围

1. repo review 使用统一 issue schema。
   - `severity`
   - `category`
   - `file`
   - `line`
   - `title`
   - `description`
   - `suggestedFix`
   - `evidence`
2. 保留旧 regex 作为兼容 fallback。
3. API provider prompt 嵌入文件内容。
   - 控制最大文件数。
   - 控制单文件大小。
   - 控制总 prompt 大小。
   - 超限时 chunk。
4. CLI provider prompt 保持可读仓库模式。
5. reporter 输出统一字段。
   - 验证状态，如已有。
   - evidence。
   - suggested fix。
6. 为后续统一 `ReviewPipeline` 留出接口，但不在本 PR 做大重构。

## 不做

- 不实现完整统一 pipeline。
- 不新增 SARIF。
- 不新增 baseline suppression。
- 不改 PR review 主流程。

## 影响文件

- `src/orchestrator/repo-orchestrator.ts`
- `src/orchestrator/issue-parser.ts`
- `src/orchestrator/types.ts`
- `src/reporter/markdown.ts`
- `src/reporter/types.ts`
- `tests/orchestrator/repo-orchestrator.test.ts`
- `tests/orchestrator/issue-parser*.test.ts`
- `tests/reporter/markdown.test.ts`
- `tests/e2e/repo-review.test.ts`

## 验收标准

- repo review 能解析统一 JSON issue schema。
- API provider 能看到真实文件内容。
- 超大文件集合会按限制处理，不会无限扩大 prompt。
- markdown report 展示 file、line、severity、evidence、suggested fix。
- 旧格式输出仍能降级解析。

## 测试

- repo review JSON schema 解析测试。
- API provider 文件内容 prompt 测试。
- prompt size limit / chunk 测试。
- reporter 输出字段测试。
- 旧 regex fallback 测试。
- 运行：

```bash
npm run build
npm run test:run
```
