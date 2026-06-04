# PR5：修复 round / convergence / force proceed 状态

## 目标

让多轮 review 的消息状态可追踪，避免 partial failure、cancel、force proceed 后出现混轮判断或上下文丢失。

## 背景

当前 convergence 通过 `conversationHistory.length / reviewers.length` 推断轮次。某个 reviewer failed 或 cancelled 后，消息数量不再等于 `round * reviewerCount`，最后 N 条消息可能混入上一轮。

force proceed 后，被取消 reviewer 下一轮可能被当作首次调用，导致看不到上一轮其他 reviewer 的结果。

## 范围

1. 扩展 `DebateMessage`。
   - `round`
   - `phase`
   - `status`
2. 写入 reviewer 消息时记录 round。
3. `checkConvergence()` 只读取当前 round 的成功 review 消息。
4. 拆开 reviewer 状态。
   - `hasResponded`
   - `lastSeenMessageIndex`
5. force proceed 后保留已完成消息的可见性。
6. 更新 session 序列化兼容旧消息。

## 不做

- 不改 issue 提取。
- 不改 provider。
- 不改 GitHub 评论发布。

## 影响文件

- `src/orchestrator/orchestrator.ts`
- `src/orchestrator/types.ts`
- `src/state/types.ts`
- `tests/orchestrator/*`
- `tests/state/*`

## 验收标准

- partial failure 不会触发错误 convergence。
- force proceed 后，下一轮 reviewer prompt 包含上一轮已完成结果。
- 旧 session 加载不崩溃。
- 单 reviewer 模式行为不变。

## 测试

- convergence partial failure 测试。
- force proceed 下一轮 prompt 内容测试。
- session 兼容性测试。
- 运行：

```bash
npm run build
npm run test:run
```
