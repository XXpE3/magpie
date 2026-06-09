# PR1：收紧 GitHub / Git 命令执行

## 目标

消除 GitHub 和 Git 调用中的 shell 字符串拼接风险。所有来自用户、PR、remote、仓库配置的输入都必须作为参数传入子进程，并经过必要校验。

## 背景

审查指出多个位置使用 `execSync(string)` 拼接外部输入：

- `src/commands/review.ts`
- `src/github/commenter.ts`
- `src/utils/large-diff.ts`

这些输入包括 PR URL、PR number、repo、remote 名称和 GitHub API path。PR 描述、diff、remote 配置都应按不可信输入处理。

## 范围

1. 新增统一命令封装。
   - 建议文件：`src/utils/command.ts` 或 `src/utils/gh.ts`
   - 使用 `execFileSync` 或 `spawnSync` 参数数组。
   - 默认设置 timeout、maxBuffer、cwd、stdio。
2. 替换 GitHub CLI 调用。
   - `gh pr view`
   - `gh pr diff`
   - `gh api`
   - `gh pr comment`
   - `gh pr review`
3. 替换 Git 调用。
   - `git diff`
   - `git log`
   - `git branch --show-current`
   - `git remote get-url`
4. 增加输入校验。
   - PR number 只能是正整数。
   - repo 只能是 `owner/name`。
   - remote 名称只允许 Git remote 合法字符范围。
   - 对 PR URL 做最小白名单校验，或交给 `gh` 参数数组处理且不进入 shell。

## 不做

- 不调整 CLI provider 权限。
- 不重构 review target。
- 不改变 GitHub 评论业务逻辑。

## 影响文件

- `src/commands/review.ts`
- `src/github/commenter.ts`
- `src/utils/large-diff.ts`
- `src/utils/*`
- `tests/*`

## 验收标准

- `rg "execSync\\(` src` 中不再出现拼接外部输入的调用。
- 恶意 PR URL、repo、remote、PR number 不会进入 shell。
- 原有 review / GitHub comment 流程行为不变。

## 测试

- 增加 command injection 输入测试。
- 覆盖 PR URL、repo、remote、PR number。
- 运行：

```bash
npm run build
npm run test:run
```
