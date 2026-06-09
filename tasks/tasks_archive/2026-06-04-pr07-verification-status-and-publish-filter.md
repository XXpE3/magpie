# PR7：验证状态与发布过滤

## 目标

让每条 issue 带验证状态，并阻止 false positive 被发布到 GitHub。

## 背景

当前验证阶段主要调整 severity。false positive 可能被降级成 nitpick 后继续进入发布流程。审查结果需要能表达真实性、证据和发布资格。

## 范围

1. 引入验证状态。
   - `verified`
   - `false_positive`
   - `pre_existing`
   - `needs_manual_review`
2. 引入 `VerifiedIssue`。
   - `verification.status`
   - `verification.severity`
   - `verification.reason`
   - `verification.evidence`
   - `publishable`
3. 修改 `verifyIssues()`。
   - 不只改 severity。
   - false positive 设置 `publishable: false`。
   - pre-existing 默认不作为 PR inline comment 发布。
4. GitHub 发布前过滤。
   - 发布 `verified`。
   - `needs_manual_review` 进入人工确认路径。
   - 过滤 `false_positive`。
5. reporter 展示验证状态和原因。

## 不做

- 不改 issue 提取来源。
- 不重写 GitHub 评论定位。
- 不做 baseline suppression。

## 影响文件

- `src/orchestrator/orchestrator.ts`
- `src/orchestrator/types.ts`
- `src/github/commenter.ts`
- `src/reporter/markdown.ts`
- `tests/orchestrator/*`
- `tests/github/commenter.test.ts`
- `tests/reporter/markdown.test.ts`

## 验收标准

- false positive 不会发布。
- verified issue 可发布。
- needs manual review 能进入确认流程。
- markdown 报告展示验证状态、原因和证据。

## 测试

- false positive publish filter 测试。
- verified issue 发布测试。
- reporter 输出验证状态测试。
- 运行：

```bash
npm run build
npm run test:run
```
