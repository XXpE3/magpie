# PR9：Repo review 安全与状态可靠性

## 目标

修复 repo review 的状态保存竞态、扫描越界和缓存误命中问题。

## 背景

repo review 目前有几处稳定性风险：

- `onFeatureComplete` 可传 async callback，但类型是 `void`，调用处未 `await`。
- scanner 使用 `path.join`，`--path ../../` 可能扫描仓库外文件。
- symlink 可能造成越界或循环。
- codebase hash 只看 path + size，等长内容变化不会刷新分析。
- session 保存不是原子写。
- nested Date 恢复不完整。

## 范围

1. 修复 `onFeatureComplete`。
   - 类型改为 `void | Promise<void>`。
   - 调用处 `await`。
2. 修复 scanner path 校验。
   - 使用 `path.resolve`。
   - 校验目标路径必须在 repo root 内。
3. 处理 symlink。
   - 使用 `lstat`。
   - 默认跳过 symlink。
4. 改进 codebase hash。
   - 加入 `mtimeMs`。
   - 保持排序稳定。
5. session 原子写。
   - 写临时文件。
   - rename 替换。
6. 恢复 nested Date。
   - `featureResults[].reviewedAt`
   - 后续 reporter 需要的日期字段。

## 不做

- 不统一 repo review issue schema。
- 不让 API provider 读取文件内容。
- 不改 planner。

## 影响文件

- `src/orchestrator/repo-orchestrator.ts`
- `src/repo-scanner/scanner.ts`
- `src/repo-scanner/types.ts`
- `src/feature-analyzer/hash.ts`
- `src/state/state-manager.ts`
- `src/state/types.ts`
- `tests/orchestrator/repo-orchestrator.test.ts`
- `tests/repo-scanner/scanner.test.ts`
- `tests/feature-analyzer/hash.test.ts`
- `tests/state/state-manager.test.ts`

## 验收标准

- repo review 每个 feature 完成后会等待 session 保存。
- scanner 拒绝 repo root 外路径。
- symlink 不会导致扫描外部文件。
- 等长内容变化会改变 codebase hash。
- session 写入中断风险降低。

## 测试

- async onFeatureComplete 测试。
- path traversal 测试。
- symlink 跳过测试。
- same-size content hash 测试。
- atomic save 测试。
- nested Date restore 测试。
- 运行：

```bash
npm run build
npm run test:run
```
