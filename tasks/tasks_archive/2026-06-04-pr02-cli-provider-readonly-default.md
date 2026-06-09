# PR2：CLI provider 默认只读

## 目标

将 CLI provider 的默认权限改为只读，危险权限必须由用户显式开启。

## 背景

当前 CLI provider 默认使用危险参数：

- `ClaudeCodeProvider` 使用 `--dangerously-skip-permissions`
- `CodexCliProvider` 使用 `--dangerously-bypass-approvals-and-sandbox`

PR 标题、PR body、diff、代码注释都属于不可信输入。默认绕过权限会把 prompt injection 风险落到用户本机和仓库环境。

## 范围

1. 增加 CLI 安全配置。
   - `allowDangerousBypass`
   - `allowWrite`
   - `allowNetwork`
   - `extraAllowedTools`
2. 修改 Claude Code 默认参数。
   - 默认只允许只读工具，例如 `Read,Grep,Glob`。
   - 只有显式配置时才添加 `--dangerously-skip-permissions`。
3. 修改 Codex CLI 默认参数。
   - 默认不添加 `--dangerously-bypass-approvals-and-sandbox`。
   - 危险模式由配置开启。
4. 开启危险模式时输出清楚提示。
   - 说明 reviewer 可能执行命令或修改文件。
5. 更新默认配置生成逻辑。

## 不做

- 不统一 provider capability。
- 不处理 CLI timeout。
- 不修改 orchestrator 行为。

## 影响文件

- `src/providers/claude-code.ts`
- `src/providers/codex-cli.ts`
- `src/config/types.ts`
- `src/config/init.ts`
- `src/config/loader.ts`
- `tests/providers/*`
- `tests/config/*`

## 验收标准

- 默认配置下不会传入 `--dangerously-*` 参数。
- 显式开启危险模式时才会传入危险参数。
- 开启危险模式时终端有提示。
- 旧配置仍能加载，默认值向只读收敛。

## 测试

- CLI provider 默认参数测试。
- 危险模式显式开启测试。
- 配置加载兼容性测试。
- 运行：

```bash
npm run build
npm run test:run
```
