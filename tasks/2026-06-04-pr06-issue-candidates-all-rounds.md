# PR6：全轮次 issue 提取与 dedupe 接入

## 目标

从所有 reviewer 的所有轮次提取 issue，避免第一轮发现的问题在后续轮次未重复时被丢弃。

## 背景

当前 `structurizeIssues()` 会按 reviewer 覆盖消息，只保留每个 reviewer 最后一条输出。这样会丢掉早期轮次的有效发现。

## 范围

1. 引入 `IssueCandidate`。
   - `reviewerId`
   - `round`
   - `messageIndex`
   - `issue`
2. 修改 `structurizeIssues()`。
   - 遍历所有 reviewer review 消息。
   - 每条消息单独提取 issue。
   - 保留来源信息。
3. 接入 deterministic dedupe。
   - 复用已有 dedupe 能力。
   - 合并重复 issue 时保留 `raisedBy` 和 round 来源。
4. 更新 `MergedIssue` 来源字段。
5. 控制结构化 prompt 大小。
   - 单消息提取。
   - 不把所有对话塞进一次调用。

## 不做

- 不引入 verification status。
- 不修改 GitHub 发布过滤。
- 不修改 convergence。

## 影响文件

- `src/orchestrator/orchestrator.ts`
- `src/orchestrator/issue-parser.ts`
- `src/orchestrator/types.ts`
- `tests/orchestrator/issue-parser*.test.ts`
- `tests/orchestrator/orchestrator*.test.ts`

## 验收标准

- 第一轮发现的 issue 不会因第二轮未重复而丢失。
- 同一问题被多个 reviewer 提出时只保留一条 merged issue。
- merged issue 能看到来源 reviewer 和 round。

## 测试

- 多轮 issue 保留测试。
- 多 reviewer dedupe 测试。
- 空输出 / 非 JSON 输出容错测试。
- 运行：

```bash
npm run build
npm run test:run
```
