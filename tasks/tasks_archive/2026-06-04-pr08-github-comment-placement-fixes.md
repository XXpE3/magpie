# PR8：GitHub 评论定位修复

## 目标

修复 GitHub 评论统计和 fallback 匹配问题，减少 inline / file / global 评论误分类。

## 背景

当前 file-level comment 成功后可能返回 `inline: true`，会污染统计。batch fallback 用 path + line 反查原始评论，重复 path + line 时可能匹配到第一条。内容匹配也可能被空行或短行误命中。

## 范围

1. 修改评论结果类型。
   - 从 `inline: boolean` 改为 `mode: 'inline' | 'file' | 'global'`。
2. 修复 file-level comment 返回值。
3. 重构 batch fallback 数据结构。
   - 构建 review payload 时保留原始 input。
   - fallback 直接遍历 entries。
   - 不再通过 path + line 重新 find。
4. 修复 `findLineByContent()`。
   - 跳过空行。
   - 跳过过短内容。
   - 保持现有合理匹配行为。
5. 更新统计和展示。

## 不做

- 不修改 verification。
- 不改 GitHub 命令执行封装，PR1 负责。
- 不改 issue schema。

## 影响文件

- `src/github/commenter.ts`
- `tests/github/commenter.test.ts`

## 验收标准

- file-level comment 统计为 file。
- 重复 path + line 的评论 fallback 不串内容。
- 空行和短行不会被错误匹配。
- 现有 inline comment 行定位行为不退化。

## 测试

- file-level mode 测试。
- 重复 path + line fallback 测试。
- 空行 / 短行 content matching 测试。
- 运行：

```bash
npm run build
npm run test:run
```
