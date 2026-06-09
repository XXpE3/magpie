以下审查基于你上传的 Magpie 项目 context pack，未实际运行测试或构建。

# 总体判断

Magpie 的方向是清晰的：把 PR / 本地 diff / 仓库扫描交给多个 AI reviewer 并行审查，再由 summarizer 做结论、结构化 issue、验证和 GitHub 评论。项目已经具备完整雏形：provider 抽象、CLI provider、上下文收集、并行审查、状态展示、GitHub 评论、repo review、session 保存。

当前主要问题集中在四类：

1. **安全边界弱**：多个位置用 shell 字符串拼接执行命令；CLI provider 默认启用危险权限；PR 描述和 diff 属于不可信输入，可能触发 prompt injection 后执行本地命令。
2. **review 结果可信度链路还不稳**：issue 结构化只看最后一轮消息；验证阶段对 API provider 并没有真实代码访问；false positive 只降级成 nitpick，仍可能被发布。
3. **PR review 与 repo review 两套实现割裂**：PR pipeline 比较强，repo pipeline 仍偏早期原型，解析 brittle，状态保存有竞态。
4. **Provider 抽象没有完全收口**：`disableTools`、timeout、abort、session、cwd、API/CLI 能力差异没有统一表达，导致调用方误以为某些能力存在。

# 架构审查

## 现有模块划分

当前分层大体合理：

```text
cli / commands
  ├─ review command
  ├─ repo review command
  └─ interactive / GitHub post flow

config
  └─ YAML config + env expansion + shared prompt

providers
  ├─ OpenAI / Anthropic / Gemini / MiniMax / Ollama API
  └─ Claude Code / Codex / Gemini CLI / Qwen CLI

orchestrator
  ├─ analyzer
  ├─ parallel reviewer rounds
  ├─ convergence judge
  ├─ final summarizer
  ├─ issue structurizer
  └─ verifier

context-gatherer
  ├─ reference collector
  ├─ history collector
  └─ docs collector

repo review
  ├─ scanner
  ├─ feature analyzer
  ├─ planner
  ├─ repo orchestrator
  └─ reporter / state
```

这个拆分能支撑后续扩展。问题在于部分边界没有稳定下来：

| 边界               | 当前问题                                  | 建议                                                                                  |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| Provider 能力      | API provider 和 CLI provider 能力混在一个接口里 | 加 `capabilities`，显式声明 `canReadRepo`、`canUseTools`、`supportsAbort`、`supportsSession` |
| Orchestrator     | PR review 强，repo review 弱，逻辑重复        | 抽成统一 `ReviewPipeline`，repo / PR / local 只是不同 target                                 |
| Issue 结构化        | 依赖 summarizer 一次性提取                   | 改为每个 reviewer 输出结构化结果，再统一 dedupe + verify                                           |
| GitHub 发布        | 分类、修正、发布混在一起                          | 拆成 `DiffLocator`、`CommentClassifier`、`ReviewPoster`                                 |
| Context gatherer | 对 CLI-only PR 拿不到真实 diff              | context 阶段必须独立获取 diff，不能依赖 reviewer 自己拿                                             |

# 高风险问题

## P0：CLI provider 默认启用危险权限

`ClaudeCodeProvider` 默认使用：

```ts
['-p', '-', '--dangerously-skip-permissions']
```

`CodexCliProvider` 默认使用：

```ts
['--json', '--dangerously-bypass-approvals-and-sandbox']
```

这两个默认值风险很高。PR 标题、PR body、diff、代码注释都属于不可信输入。攻击者可以在 PR 描述或代码注释里诱导 reviewer 执行命令。当前又绕过权限和沙箱，风险直接落到用户本机、repo、环境变量、GitHub token。

建议改成：

```yaml
providers:
  claude-code:
    enabled: true
    permissions: read-only
    allow_write: false
    allow_network: false
    allow_dangerous_bypass: false
```

代码层面：

```ts
interface CliSecurityOptions {
  allowDangerousBypass?: boolean
  allowNetwork?: boolean
  allowWrite?: boolean
  extraAllowedTools?: string[]
}

function buildClaudeArgs(security: CliSecurityOptions): string[] {
  const args = ['-p', '-']

  if (security.allowDangerousBypass) {
    args.push('--dangerously-skip-permissions')
  } else {
    args.push('--tools', 'Read,Grep,Glob')
  }

  return args
}
```

默认应是只读。危险模式需要用户显式打开，并在终端打印清楚：

```text
Dangerous CLI permissions enabled: reviewer can execute commands and modify files.
```

## P0：多处 shell command injection

代码里大量使用 `execSync(string)` 拼接用户输入或外部输入：

```ts
execSync(`gh pr view ${prUrl} --json title,body`)
execSync(`gh pr diff ${prUrl}`)
execSync(`gh api repos/${repo}/pulls/${prNumber}/files --paginate`)
execSync(`gh pr comment ${prNumber}${repoFlag} --body-file -`)
```

`prUrl`、`repo`、`prNumber`、remote URL 推导结果都应视为不可信。虽然部分地方校验了 PR number，但不完整。尤其用户传入 `http...` 时，`prUrl` 直接进入 shell。

建议统一改成 `execFileSync` 或 `spawnSync` 参数数组：

```ts
import { execFileSync } from 'node:child_process'

function gh(args: string[], opts: { input?: string; cwd?: string; timeout?: number } = {}): string {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    input: opts.input,
    cwd: opts.cwd,
    timeout: opts.timeout ?? 30_000,
    stdio: opts.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  })
}

const prInfo = JSON.parse(gh(['pr', 'view', prUrl, '--json', 'title,body']))
const prDiff = gh(['pr', 'diff', prUrl], { timeout: 60_000 })
```

再加统一校验：

```ts
function assertPrNumber(value: string): void {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid PR number: ${value}`)
  }
}

function assertGitHubRepo(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`Invalid GitHub repo: ${value}`)
  }
}
```

这个优先级应排第一批。

## P0：`src/cli.ts` 引用的命令在 file tree 中缺失

`src/cli.ts` 引用了：

```ts
import { initCommand } from './commands/init.js'
import { discussCommand } from './commands/discuss.js'
import { statsCommand } from './commands/stats.js'
```

但上传的 file tree 里只看到：

```text
src/commands/review.ts
src/commands/review/*
```

没有 `init.ts`、`discuss.ts`、`stats.ts`。如果实际仓库也缺这些文件，`tsc` 会直接失败。类似地，`review.ts` 里动态引用了：

```ts
../history/tracker.js
```

file tree 里也没有 `src/history`。

建议先跑：

```bash
npm run build
npm test
```

如果确实缺文件，要么补回，要么从 CLI 注册里移除。

# 核心逻辑问题

## 1. CLI-only PR 下，context gatherer 实际拿不到 diff

PR 流程里，如果 analyzer / reviewers / summarizer 全部是 CLI provider，会走：

```ts
prPrompt = `Please review ${prUrl}... Use gh pr diff ${prUrl}...`
```

也就是不把 diff 嵌入 prompt。随后 `runStreaming()` 里：

```ts
const diff = this.extractDiffFromPrompt(prompt)
this.gatheredContext = await this.contextGatherer!.gather(diff, label, 'main')
```

`extractDiffFromPrompt()` 没找到 fenced diff 时返回整个自然语言 prompt。`ContextGatherer.extractChangedFiles()` 只能从 unified diff 里提取文件，所以 CLI-only PR 的 context 阶段基本拿不到 changed files、references、history。

这会让上下文收集在最推荐的 CLI-only 模式下失效。

建议改成：**context gatherer 必须独立获取 diff**。不要把“reviewer 能自己取 diff”扩展到 context 阶段。

```ts
interface ReviewTarget {
  type: 'pr' | 'local' | 'branch' | 'files'
  label: string
  prompt: string
  diff?: string
  repo?: string
  prNumber?: string
  baseBranch?: string
}
```

然后：

```ts
const contextDiff = target.diff ?? await fetchTargetDiff(target)
await contextGatherer.gather(contextDiff, target.label, target.baseBranch ?? 'main')
```

## 2. branch / files review 对 API provider 不可用

`--branch` 现在只生成：

```ts
Review the changes in branch "x" compared to "main".
```

`--files` 只生成：

```ts
Review the following files: ...
```

如果 reviewer 是 API provider，它没有 repo 访问能力，只能看到这句话，无法审查代码。PR 分支只对 PR 做了 `allCli` 判断，branch/files/local 没有完整处理。

建议统一 target 构建：

| Target | CLI provider                       | API provider                |
| ------ | ---------------------------------- | --------------------------- |
| PR     | 可只给 PR URL，但 context 仍应 fetch diff | 必须嵌入 diff                   |
| local  | 可嵌入 diff                           | 必须嵌入 diff                   |
| branch | 可给命令说明，也建议嵌入 diff                  | 必须嵌入 `git diff base...HEAD` |
| files  | 可让 CLI read files                  | 必须嵌入文件内容，且控制大小              |

更好的做法是统一先生成 `ReviewTargetPayload`：

```ts
interface ReviewTargetPayload {
  label: string
  promptForCli: string
  promptForApi: string
  diff?: string
  files?: Array<{ path: string; content: string }>
}
```

选择 reviewer 后再决定用哪个 prompt。

## 3. issue 结构化只读取最后一轮消息

`structurizeIssues()` 里：

```ts
const lastMessages = new Map<string, string>()
for (const msg of this.conversationHistory) {
  if (msg.reviewerId === 'user') continue
  lastMessages.set(msg.reviewerId, msg.content)
}
```

这会覆盖前面轮次。第一轮发现的 issue，如果第二轮没有重复，就会丢失。

建议改成两段式：

第一段：每个 reviewer 每轮都结构化。

```ts
interface IssueCandidate {
  reviewerId: string
  round: number
  issue: ReviewIssue
}
```

第二段：用 deterministic dedupe 合并。

```ts
const issuesByReviewer = new Map<string, ReviewIssue[]>()

for (const msg of this.conversationHistory) {
  if (msg.reviewerId === 'user') continue
  const parsed = await extractIssuesFromSingleMessage(msg)
  issuesByReviewer.set(msg.reviewerId, [
    ...(issuesByReviewer.get(msg.reviewerId) ?? []),
    ...parsed,
  ])
}

return deduplicateIssues(issuesByReviewer)
```

当前 `deduplicateIssues()` 已经存在，但 orchestrator 没真正用起来。应让它进入主链路。

## 4. convergence 判断在 partial failure / force proceed 下会误判

`checkConvergence()` 用：

```ts
const roundsCompleted = Math.floor(this.conversationHistory.length / this.reviewers.length)
const lastRoundMessages = this.conversationHistory.slice(-this.reviewers.length)
```

当某个 reviewer failed / cancelled 时，`conversationHistory.length` 不再等于 `round * reviewers.length`。这时最后 N 条可能混入上一轮消息，convergence judge 得到错误上下文。

建议给 `DebateMessage` 加 `round` 和 `phase`：

```ts
interface DebateMessage {
  reviewerId: string
  content: string
  timestamp: Date
  round?: number
  phase: 'analysis' | 'review' | 'qa' | 'summary' | 'user'
  status?: 'completed' | 'failed' | 'cancelled'
}
```

convergence 只看当前 round 的成功 reviewer 输出：

```ts
const lastRoundMessages = this.conversationHistory.filter(
  m => m.phase === 'review' && m.round === round && m.status === 'completed'
)

if (lastRoundMessages.length < this.reviewers.length) {
  return false
}
```

## 5. force proceed 后，被取消 reviewer 下一轮会丢上下文

force proceed 后，取消的 reviewer 没有被 `markAsSeen()`。下一轮它会被当作第一次调用：

```ts
const isFirstCall = lastSeen < 0
```

结果它看不到上一轮其他 reviewer 已完成的结果。测试里覆盖了“下一轮继续”，但没有验证 prompt 内容是否包含上一轮信息。

建议把“是否首次调用”和“是否已看过哪些消息”分开：

```ts
private hasResponded = new Set<string>()
private lastSeenMessageIndex = new Map<string, number>()
```

取消时不要标记 responded，但下一轮仍应把 missed messages 传过去。

# Provider 抽象问题

## 1. `disableTools` 没有被所有 provider 执行

接口定义：

```ts
chat(messages, systemPrompt?, options?: ChatOptions)
```

Claude provider 的 `chat()` 支持 `disableTools`。但 Codex `chat()` 没有第三个参数，OpenAI / Anthropic 也没有使用这个参数。`structurizeIssues()` 里传了：

```ts
const chatOpts = { disableTools: true }
this.summarizer.provider.chat(messages, systemPrompt, chatOpts)
```

如果 summarizer 是 Codex CLI，这个配置会被忽略。结构化 JSON 阶段仍可能启用工具，甚至在危险权限下读写文件。

建议在 `AIProvider` 增加能力声明：

```ts
interface ProviderCapabilities {
  readsRepository: boolean
  supportsTools: boolean
  supportsDisableTools: boolean
  supportsAbort: boolean
  supportsSession: boolean
}

interface AIProvider {
  name: string
  capabilities: ProviderCapabilities
  chat(...): Promise<string>
}
```

然后结构化阶段只允许：

```ts
if (provider.capabilities.supportsTools && !provider.capabilities.supportsDisableTools) {
  throw new Error(`${provider.name} cannot safely run structurizer with tools disabled`)
}
```

更好的方式是结构化使用 API provider 或本地 JSON parser，不要让 CLI agent 参与。

## 2. 非 streaming CLI 调用没有 timeout

`ClaudeCodeProvider.runClaude()` 和 `CodexCliProvider.runCodex()` 都没有 timeout。默认 timeout 只在 stream 路径里实现。`structurizeIssues()`、`verifyIssues()`、`preAnalyze()` 等路径可能走 `chat()`，进程可能一直挂住。

建议抽公共 subprocess runner：

```ts
interface RunProcessOptions {
  command: string
  args: string[]
  cwd: string
  input: string
  timeoutMs: number
  signal?: AbortSignal
}

async function runProcess(opts: RunProcessOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      terminateProcess(child)
      reject(new Error(`${opts.command} timed out after ${opts.timeoutMs / 1000}s`))
    }, opts.timeoutMs)

    timer.unref()

    // collect stdout/stderr...
  })
}
```

所有 CLI provider 都复用它。

## 3. 大 prompt + `disableTools` 会自相矛盾

`preparePromptForCli()` 遇到超过 100KB 的 prompt 会写临时文件，然后把 stdin 变成：

```text
Please read the file at: /tmp/magpie_prompt_xxx.txt
```

但结构化阶段传了 `disableTools: true`，Claude 会收到 `--tools ''`，无法读取这个文件。结果长 review text 的 JSON 提取可能失败。

建议：

1. `disableTools` 时不要走 temp file 机制。
2. 或者结构化阶段固定走 API provider。
3. 或者给 Claude 允许只读文件工具，不允许写工具。

更稳的方案：

```ts
function preparePromptForCli(prompt: string, opts?: { requireInline?: boolean }): PreparedPrompt {
  if (opts?.requireInline) {
    return { prompt, cleanup: () => {} }
  }

  // large temp file path mode...
}
```

结构化阶段：

```ts
preparePromptForCli(prompt, { requireInline: true })
```

如果太大，先在应用内裁剪 / 分批结构化，不交给 CLI 读临时文件。

# Issue 可信度链路优化

当前链路：

```text
reviewers 输出自然语言
  ↓
summarizer 从最后一轮提取 JSON
  ↓
verifyIssues 调 summarizer 再验证
  ↓
只更新 severity
  ↓
GitHub 发布
```

建议改成：

```text
reviewer 每轮输出
  ↓
per-message extractor 提取 IssueCandidate
  ↓
deterministic normalize + dedupe
  ↓
diff locator 校验 file + line
  ↓
verifier 验证真实性
  ↓
filter false positive
  ↓
生成 comment
  ↓
人工确认 / 自动发布
```

推荐数据结构：

```ts
type VerificationStatus = 'verified' | 'false_positive' | 'pre_existing' | 'needs_manual_review'

interface VerifiedIssue extends MergedIssue {
  verification: {
    status: VerificationStatus
    severity: MergedIssue['severity']
    reason: string
    evidence?: Array<{ file: string; line?: number; snippet?: string }>
  }
  placement?: {
    mode: 'inline' | 'file' | 'global'
    line?: number
    reason?: string
  }
}
```

`verifyIssues()` 不应只改 severity：

```ts
if (v.status === 'false_positive') {
  issue.verification.status = 'false_positive'
  issue.publishable = false
}
```

GitHub 发布前过滤：

```ts
const publishableIssues = issues.filter(
  i => i.verification.status === 'verified' || i.verification.status === 'needs_manual_review'
)
```

# GitHub 评论模块问题

## 1. file-level comment 被标记成 inline

`postComment()` 里 file-level 成功后返回：

```ts
return { success: true, inline: true }
```

这会污染统计。应该返回 `inline: false`，或者改成 `mode`：

```ts
interface CommentResult {
  success: boolean
  mode: 'inline' | 'file' | 'global'
  error?: string
}
```

## 2. batch fallback 会错误匹配重复 path + line 的评论

fallback 里用：

```ts
const orig = classified.find(
  cc => cc.input.path === details[idx].path && cc.input.line === details[idx].line
)
```

如果同一个 path + line 有多条评论，会重复拿第一条。

建议在构建 `reviewComments` 时保存原始 input：

```ts
const reviewEntries: Array<{
  input: ReviewCommentInput
  mode: 'inline' | 'file'
  detailIndex: number
  payload: ReviewCommentPayload
}> = []
```

fallback 直接遍历 `reviewEntries`，不要重新 find。

## 3. content line matching 可能误匹配空行 / 短行

`findLineByContent()` 里：

```ts
if (content.includes(normalized) || normalized.includes(content)) {
  return rightLine
}
```

如果 patch 某行 trim 后为空字符串，`normalized.includes('')` 恒为 true。应加长度限制：

```ts
const content = line.slice(1).trim()
if (content.length < 8) {
  rightLine++
  continue
}
```

# Repo review 子系统问题

repo review 目前像一个独立原型，和 PR review 的强链路不一致。

## 1. API reviewer 只能看到文件路径，看不到内容

`RepoOrchestrator.executeStep()` prompt 是：

```ts
Review the following files in ${step.name}:
${fileList}
```

CLI provider 可以自己读文件，API provider 读不到。结果会变成基于文件名的猜测。

建议：

```ts
if (allReviewersCanReadRepo) {
  prompt = `Read and review these files:\n${fileList}`
} else {
  prompt = buildPromptWithFileContents(step.files, maxTokens)
}
```

## 2. issue 解析依赖脆弱 regex

当前要求：

```text
ISSUE: [location] - [description] - [severity: high/medium/low]
```

然后用 regex 解析。这对 LLM 输出很脆弱，也没有 category、line、fix、evidence、raisedBy。

建议 repo review 复用 PR review 的 issue schema：

```json
{
  "issues": [
    {
      "severity": "high",
      "category": "security",
      "file": "src/foo.ts",
      "line": 42,
      "title": "...",
      "description": "...",
      "suggestedFix": "..."
    }
  ]
}
```

## 3. `onFeatureComplete` 是 async，但类型是 void，调用处没 await

接口：

```ts
onFeatureComplete?: (featureId: string, result: FeatureReviewResult) => void
```

实际传入的是 async callback，会保存 session：

```ts
onFeatureComplete: async (...) => {
  await stateManager.saveSession(currentSession)
}
```

但 `RepoOrchestrator.executeFeaturePlan()` 里：

```ts
this.options.onFeatureComplete?.(step.featureId, result)
```

没有 await。进度保存可能和后续步骤、进程结束、异常处理发生竞态。

修复：

```ts
export interface RepoOrchestratorOptions {
  onFeatureComplete?: (
    featureId: string,
    result: FeatureReviewResult
  ) => void | Promise<void>
}
```

调用：

```ts
await this.options.onFeatureComplete?.(step.featureId, result)
```

这是 repo review 恢复能力的关键修复。

## 4. repo scanner 可扫描 repo 外路径

`scanFiles()`：

```ts
const targetPath = this.options.path
  ? path.join(this.rootPath, this.options.path)
  : this.rootPath
```

如果用户传 `--path ../../`，可能扫描仓库外文件。应使用 `resolve` 并校验：

```ts
const root = path.resolve(this.rootPath)
const target = this.options.path
  ? path.resolve(root, this.options.path)
  : root

if (target !== root && !target.startsWith(root + path.sep)) {
  throw new Error(`Scan path escapes repository root: ${this.options.path}`)
}
```

同时用 `lstatSync` 跳过 symlink，避免循环或扫描外部路径。

# Context gatherer 优化

## 1. symbol 提取只看新增行

`extractSymbolsFromDiff()` 大量 regex 都以 `^\+` 开头。修改函数体但没有新增函数签名时，关键 symbol 抽不出来。删除、重命名、调用点变更也容易漏。

建议按文件级别提取：

1. 从 diff 拿 changed file + hunk range。
2. 读取 changed file 当前内容。
3. 用轻量 parser 或 regex 从 hunk 附近找 enclosing function / class。
4. 再用 `rg` 查引用。

TypeScript 版本可以先简单做：

```ts
interface ChangedSymbol {
  name: string
  file: string
  line: number
  kind: 'function' | 'class' | 'method' | 'unknown'
}
```

比单纯从新增行提取要稳很多。

## 2. docs 收集缺少总量限制

`collectDocs()` 对每个文档按 `maxSize` 限制，但没有限制总文档数量和总 prompt 大小。大型 repo 的 docs 目录可能让 context prompt 过大。

建议加：

```ts
docs: {
  patterns: string[]
  maxSizePerFile: number
  maxFiles: number
  maxTotalSize: number
}
```

## 3. base branch 写死为 main

`runStreaming()` 里：

```ts
this.contextGatherer!.gather(diff, label, 'main')
```

PR 的 base branch 不一定是 main。branch review 也可能指定 base。

建议 `ReviewTarget` 带 `baseBranch`，从 GitHub PR metadata 或 CLI option 获取。

# Config 与可运维性

## 1. provider.enabled 没有生效

`ProviderConfig` 有：

```ts
enabled?: boolean
```

但 factory 没检查。禁用 provider 仍可被创建。

建议：

```ts
if (providerConfig?.enabled === false) {
  throw new Error(`Provider ${provider} is disabled`)
}
```

## 2. API key 为空只 warn，不 fail

当前：

```ts
logger.warn(`providers.${name}.api_key is empty`)
```

对 API provider 来说，空 key 多半会在运行时失败。建议：

| provider                                                 | 空 api_key 行为   |
| -------------------------------------------------------- | -------------- |
| CLI provider                                             | 允许             |
| mock                                                     | 允许             |
| ollama                                                   | 允许，默认 `ollama` |
| openai/anthropic/google/minimax/custom OpenAI-compatible | 默认报错           |
| 显式 `allow_empty_api_key: true`                           | 允许             |

## 3. `--rounds`、`--format` 缺少校验

`parseInt(options.rounds, 10)` 可能得到 `NaN`。建议：

```ts
function parsePositiveInt(value: string, name: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return n
}
```

format：

```ts
if (!['markdown', 'json'].includes(options.format)) {
  throw new Error('--format must be markdown or json')
}
```

# State 与缓存

## 1. `computeCodebaseHash()` 只使用 path + size

```ts
const content = sorted.map(f => `${f.relativePath}:${f.size}`).join('\n')
```

两个文件内容变化但 size 相同，hash 不变，feature analysis 不会刷新。

建议至少加 mtime：

```ts
`${f.relativePath}:${f.size}:${f.mtimeMs}`
```

更稳是内容 hash，但大型 repo 成本高。可以折中：

```ts
hash(path + size + mtimeMs)
```

## 2. session 保存不是原子写

`writeFile(filePath, JSON.stringify(...))` 中断时可能留下半个 JSON。建议 temp + rename：

```ts
const tmp = `${filePath}.tmp`
await writeFile(tmp, JSON.stringify(session, null, 2))
await rename(tmp, filePath)
```

## 3. loadSession 只恢复部分 Date

`ReviewSession` 的 `startedAt`、`updatedAt` 会恢复，但 `featureResults[].reviewedAt` 没恢复。短期不影响大逻辑，但 reporter / resume 如果按 Date 使用会出问题。

# 测试缺口

当前测试覆盖了 provider factory、session helper、orchestrator resilience、status display、issue parser、GitHub commenter、scanner、feature analyzer。覆盖方向不错，但缺下面这些关键测试：

| 测试                                  | 目的                                        |
| ----------------------------------- | ----------------------------------------- |
| command injection 输入                | 验证 PR URL、repo、remote、PR number 不进入 shell |
| CLI dangerous mode 默认关闭             | 防止默认绕过权限                                  |
| branch review + API provider        | 确认 diff 被嵌入 prompt                        |
| files review + API provider         | 确认文件内容被嵌入或明确拒绝                            |
| CLI-only PR + context gatherer      | 确认 context 阶段能拿到真实 diff                   |
| force proceed 后下一轮 prompt           | 确认被取消 reviewer 能看到上一轮已完成结果                |
| convergence partial failure         | 防止混轮判断                                    |
| structurizer 多轮 issue 保留            | 防止第一轮 issue 丢失                            |
| long prompt + disableTools          | 防止临时文件和禁用工具冲突                             |
| repo review async onFeatureComplete | 防止 session 保存竞态                           |
| scanner path traversal / symlink    | 防止扫描 repo 外路径                             |
| codebase hash same-size change      | 防止缓存误命中                                   |

# 建议的重构顺序

## 第一阶段：先保安全和可构建

1. 把所有 `execSync(string)` 改为 `execFileSync/spawnSync(args)`。
2. CLI provider 默认禁用危险权限，只读工具作为默认。
3. 校验 `prNumber`、`repo`、`remote`、`format`、`rounds`、`path`。
4. 修复 `cli.ts` 里缺失命令文件或移除导入。
5. 给所有 CLI `chat()` 和 `chatStream()` 加 timeout / abort。

这一阶段目标是避免本机风险和构建失败。

## 第二阶段：修 review 结果可信度

1. `ReviewTarget` 增加 `diff/files/baseBranch/prNumber/repo`。
2. context gatherer 使用真实 diff，不依赖 prompt。
3. branch/files/API provider 注入真实 diff 或文件内容。
4. issue 提取从“最后一轮 summarizer 提取”改为“每条 reviewer 消息提取 + deterministic dedupe”。
5. verifier 输出 `verified / false_positive / pre_existing / needs_manual_review`，false positive 默认不发布。
6. convergence 改为基于 round id 的判断。

这一阶段目标是让输出结果可追踪、可解释、可复查。

## 第三阶段：统一 PR review 和 repo review

1. repo review 复用 PR issue schema。
2. repo review 支持并行 reviewer 和统一 status tracker。
3. repo review 的 feature 保存 callback 改成 await。
4. reporter 输出 verified issue、evidence、fix suggestion。
5. repo review 支持 chunked file content，API provider 可用。

这一阶段目标是让 repo review 从原型变成可长期使用的功能。

## 第四阶段：增强产品能力

可以按下面方向加功能：

| 功能                     | 价值                                                                     |
| ---------------------- | ---------------------------------------------------------------------- |
| Review profile         | 用户可选 security / compatibility / performance / migration / API breaking |
| Baseline suppression   | 记录已知问题，后续只报新增问题                                                        |
| Confidence score       | 每个 issue 带 evidence、raisedBy、verificationStatus、confidence             |
| Patch suggestion       | 针对 verified issue 生成最小修复 patch                                         |
| CI mode                | 输出 SARIF / JSON，适合 GitHub Actions                                      |
| Review budget          | 控制最大 token、最大文件数、最大耗时                                                  |
| Provider benchmark     | 统计每个 reviewer 的有效 issue、false positive、耗时                              |
| Prompt injection guard | 扫描 PR body/diff 中的“忽略上文/执行命令/读取密钥”等模式                                  |
| Read-only sandbox      | CLI provider 在临时 worktree / container / restricted env 中运行             |
| Review replay          | 保存完整 prompt、模型输出、验证结果，支持复查和调试                                          |

# 推荐的目标架构

可以把核心 pipeline 收成下面形态：

```ts
interface ReviewPipeline {
  prepareTarget(input: ReviewInput): Promise<ReviewTarget>
  gatherContext(target: ReviewTarget): Promise<GatheredContext>
  analyze(target: ReviewTarget, context: GatheredContext): Promise<AnalysisResult>
  runReviewRounds(target: ReviewTarget, analysis: AnalysisResult): Promise<ReviewRoundResult[]>
  extractIssues(rounds: ReviewRoundResult[]): Promise<IssueCandidate[]>
  dedupeIssues(candidates: IssueCandidate[]): MergedIssue[]
  verifyIssues(issues: MergedIssue[], target: ReviewTarget): Promise<VerifiedIssue[]>
  render(result: ReviewResult): string
  publish?(result: ReviewResult): Promise<PublishResult>
}
```

PR / local / branch / repo 的差异收敛到 `ReviewTarget`：

```ts
interface ReviewTarget {
  kind: 'pr' | 'local' | 'branch' | 'files' | 'repo'
  label: string
  repoRoot: string
  repo?: string
  prNumber?: string
  prUrl?: string
  baseBranch?: string
  headSha?: string
  diff?: string
  files?: Array<{
    path: string
    content?: string
    language?: string
  }>
  trust: 'untrusted'
}
```

Provider 侧收敛到：

```ts
interface AIProvider {
  name: string
  capabilities: {
    canReadRepo: boolean
    canUseTools: boolean
    canDisableTools: boolean
    supportsStreaming: boolean
    supportsAbort: boolean
    supportsSession: boolean
  }

  chat(input: ChatInput): Promise<ChatOutput>
  stream?(input: ChatInput): AsyncGenerator<ChatEvent>
}
```

这样 orchestrator 就不用猜 provider 能不能读文件、能不能关工具、能不能 session。

# 具体优先修复清单

| 优先级 | 文件                                                               | 问题                         | 修复                             |                        |
| --- | ---------------------------------------------------------------- | -------------------------- | ------------------------------ | ---------------------- |
| P0  | `providers/claude-code.ts`、`providers/codex-cli.ts`              | 默认危险权限                     | 默认只读，危险模式显式配置                  |                        |
| P0  | `commands/review.ts`、`github/commenter.ts`、`utils/large-diff.ts` | shell 拼接                   | 全部换成 args 调用                   |                        |
| P0  | `cli.ts`                                                         | 可能引用不存在命令                  | 补文件或移除导入                       |                        |
| P0  | `orchestrator.ts`                                                | CLI-only PR context 无 diff | target 保存真实 diff，context 直接用   |                        |
| P1  | `orchestrator.ts`                                                | issue 只看最后一轮               | 全轮次提取 + dedupe                 |                        |
| P1  | `orchestrator.ts`                                                | convergence 混轮             | message 加 round id             |                        |
| P1  | `providers/*`                                                    | `disableTools` 不一致         | capabilities + 强制实现            |                        |
| P1  | `repo-orchestrator.ts`                                           | async callback 未 await     | `void                          | Promise<void>` 并 await |
| P1  | `repo-scanner/scanner.ts`                                        | path traversal / symlink   | resolve 校验 + lstat             |                        |
| P2  | `feature-analyzer/hash.ts`                                       | hash 不看内容变化                | 加 mtime 或内容 hash               |                        |
| P2  | `github/commenter.ts`                                            | file comment 统计错误          | 返回 mode                        |                        |
| P2  | `context-gatherer`                                               | symbol 提取弱                 | hunk 附近找 enclosing symbol      |                        |
| P2  | `reporter`                                                       | repo report 信息少            | 加 verified status/evidence/fix |                        |

# 一个可直接落地的小 patch 方向

先从最关键的命令执行封装开始，收益最大：

```ts
// src/utils/gh.ts
import { execFileSync } from 'node:child_process'

export function validatePrNumber(prNumber: string): void {
  if (!/^\d+$/.test(prNumber)) {
    throw new Error(`Invalid PR number: ${prNumber}`)
  }
}

export function validateRepo(repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repo: ${repo}`)
  }
}

export function gh(args: string[], options: {
  input?: string
  cwd?: string
  timeout?: number
  maxBuffer?: number
} = {}): string {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    input: options.input,
    cwd: options.cwd,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  })
}
```

替换调用：

```ts
const resolvedUrl = gh(['pr', 'view', prNumber, '--json', 'url', '--jq', '.url']).trim()

const prInfo = JSON.parse(
  gh(['pr', 'view', prUrl, '--json', 'title,body'])
)

const prDiff = gh(['pr', 'diff', prUrl], {
  timeout: 60_000,
  maxBuffer: 10 * 1024 * 1024,
})
```

这个改动范围可控，能立刻降低最高风险。

# 下一步开发方向

建议把 Magpie 的路线拆成三个版本：

## v0.3：安全和稳定版

目标：本机可安全运行，结果不因明显逻辑问题丢失。

包含：

* 安全命令执行封装。
* CLI provider 默认只读。
* branch/files/API provider 正常可审查。
* context gatherer 总能拿到真实 diff。
* 所有 CLI 调用有 timeout。
* `--rounds`、`--format`、`--path` 校验。
* 修复缺失命令文件或导入。
* repo review 保存进度无竞态。

## v0.4：可信 issue 版

目标：每条 issue 可追踪来源、证据和验证状态。

包含：

* IssueCandidate / MergedIssue / VerifiedIssue 三层模型。
* 全轮次 issue 提取。
* deterministic dedupe 真正接入。
* verifier 输出 `verified / false_positive / pre_existing / needs_manual_review`。
* GitHub 评论只发布 verified / manual approved。
* reporter 展示证据、来源 reviewer、验证原因。
* convergence 基于 round id。

## v0.5：仓库级审查成熟版

目标：repo review 和 PR review 使用同一条 review pipeline。

包含：

* repo review 使用统一 orchestrator。
* feature analyzer 增加文件摘要 / import graph / hunk context。
* API provider 支持 chunked file content。
* repo report 支持 JSON / Markdown / SARIF。
* review baseline，支持只报告新增问题。
* provider effectiveness 统计。

# 当前项目最值得保留的设计

1. **同轮 reviewer 并行并且信息公平**：先构建 `reviewerTasks`，再并行执行，方向正确。
2. **status tracker 抽出来是对的**：相比把状态散落在 CLI spinner 里，更容易维护。
3. **provider session helper 值得继续抽象**：Claude / Codex / Gemini / Qwen 都需要统一 session 行为。
4. **context gatherer 的方向正确**：调用链、历史 PR、文档上下文能显著减少 reviewer 的盲区。
5. **GitHub comment 先 classify 再 post 是正确方向**：line 修正、file-level、global fallback 都应该保留，只需强化实现。

# 当前最应该停止扩张的部分

在 P0/P1 修完前，建议先不要继续加新 provider、新 UI、新 repo review 功能。当前更需要收紧核心路径：

```text
安全执行命令
→ 稳定获取 target diff/code
→ 全轮次收集 issue
→ 验证并过滤 false positive
→ 安全发布评论
```

这条链路稳定后，新增 provider、CI、SARIF、patch suggestion 才有足够基础。

