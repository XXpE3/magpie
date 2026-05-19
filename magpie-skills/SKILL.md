---
name: magpie
description: Use Magpie from any repository to run multi-AI adversarial code reviews, repository reviews, and engineering discussions. Use when the user asks to review a PR, local diff, branch diff, selected files, an entire repository, or to run a multi-model technical debate with Magpie.
---

# Magpie 使用指南

Magpie 是多 AI 对抗式代码审查 CLI。可审查 PR、本地改动、分支差异、指定文件、整仓，也可讨论技术方案。

## 基本原则

- 在“目标仓库”里运行 Magpie，不要在 Magpie 源码仓库里运行。
- 默认配置文件：`~/.magpie/config.yaml`；可用 `--config <path>` 覆盖。
- `reviewers`、`analyzer`、`summarizer` 必须显式配置 `provider`。
- 需要报告文件时加：`--output <file>`。

## 启动检查

```bash
cd /path/to/target-repo
magpie --help
```

如果没有全局命令：

```bash
node /path/to/magpie/dist/cli.js --help
```

首次使用：

```bash
magpie init
# 或
magpie init -y
```

## 配置要点

最小配置应包含：

```yaml
providers:
  claude-code:
    enabled: true

reviewers:
  claude:
    provider: claude-code
    model: claude-code

analyzer:
  provider: claude-code
  model: claude-code
  prompt: Analyze the change and risks.

summarizer:
  provider: claude-code
  model: claude-code
  prompt: Summarize findings and recommendation.
```

CLI provider 需要对应命令已安装并登录：`claude`、`codex`、`gemini`、`qwen`。API provider 需要配置 API key。

## 常用命令

```bash
# 审查 GitHub PR
magpie review 12345
magpie review https://github.com/owner/repo/pull/12345

# PR 常用选项
magpie review 12345 --all
magpie review 12345 --reviewers claude,codex
magpie review 12345 --rounds 3
magpie review 12345 --skip-context
magpie review 12345 --no-post
magpie review 12345 --output review.md
magpie review 12345 --format json --output review.json

# 审查本地改动
magpie review --local

# 审查当前分支相对 base 的差异
magpie review --branch
magpie review --branch main

# 审查指定文件
magpie review --files src/foo.ts src/bar.ts

# 审查整仓
magpie review --repo
magpie review --repo --quick
magpie review --repo --deep
magpie review --repo --path src/api
magpie review --repo --ignore dist node_modules coverage

# 会话
magpie review --list-sessions
magpie review --session <session-id>
magpie review --export review-report.md

# 技术讨论
magpie discuss "Should we use microservices or a monolith?"
magpie discuss /path/to/proposal.md
magpie discuss "Is Kubernetes overkill?" --devil-advocate
magpie discuss "How should we handle migrations?" --interactive
magpie discuss --list
magpie discuss --resume <session-id> "What about rollback?"
```

## Agent 使用流程

1. 进入目标仓库。
2. 确认 `magpie --help` 可用；不可用则用 `node /path/to/magpie/dist/cli.js`。
3. 确认配置存在；没有就运行 `magpie init` 或询问配置路径。
4. 按需求运行对应命令。
5. 如需产物，加 `--output <file>`。
6. 最后只汇报报告路径和关键结论，除非用户要求完整输出。

## 常见问题

- `Provider is required`：给 reviewer、analyzer、summarizer 都加 `provider`。
- `Unknown provider`：在 `providers` 中定义它，或设置对应 `type`。
- CLI provider 不可用：安装并登录对应 CLI。
- PR 审查失败：检查 `gh auth status`，并确认当前目录是 GitHub 仓库。
- 审查错仓库：切到目标仓库后再运行。
