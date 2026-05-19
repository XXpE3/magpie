# Local Changes Review

## Analysis

我会用 `magpie` 审查流程看这组本地改动，并补充实际文件行号。先核对当前工作区里的代码位置，避免只依赖 diff 里的旧行号。我已读取 `magpie` 技能说明。当前工作区的 `git diff` 没有输出，说明这段 diff 可能来自外部传入内容；我会以你贴出的 diff 为准，并用其中的新文件行号定位审查重点。代码确实是已暂存变更，所以普通 `git diff` 为空。我接着看 staged diff 和关键实现行，重点检查状态跟踪、终端渲染和 provider 接口扩展。主要改动范围比“状态展示”本身更宽：它同时改了 orchestrator 的执行包装、provider 流式接口、两个 CLI 命令的输出控制，以及新增状态模块。这里的风险集中在终端输出互相清屏、任务状态生命周期、以及 `chatStream` 签名扩展。我发现一个实质问题：新的统一状态跟踪会收到 provider 的 `stdout/tool/stderr` 活动，但旧的 `onParallelStatus` 状态只在产出文本 chunk 时更新。很多 CLI provider 长时间只上报活动、最后才吐文本，这会让并行状态误报 stalled。接下来我再跑构建或测试入口，确认有没有类型层面的回归。构建通过，新增状态测试也通过。测试覆盖了 chunk 输出路径，但还没有覆盖“CLI 有活动但暂不产出文本”的路径，这正是当前最容易误报 stalled 的兼容场景。**1. 修改内容**

这次改动主要是在 `review` / `discuss` 的长时间多模型流程中增加状态展示：

- 新增 `src/status/*`：`StatusTracker` 负责任务状态，`StatusRenderer` 负责终端输出。
- `DebateOrchestrator` 新增 `collectStream()` 和 `trackedPromise()`，把 analyzer、reviewer、summarizer、verifier、convergence 等步骤接入状态跟踪。
- `ReviewerStatus` 增加 `streaming`、`stalled`、`lastActivityAt`、`outputChars`、`chunkCount` 等字段。
- 所有 provider 的 `chatStream()` 增加第三个参数 `ChatStreamOptions`，用于上报 `stdout`、`stderr`、`tool`、`output` 等活动。
- `src/commands/review.ts` 和 `src/commands/discuss.ts` 新增状态渲染、spinner 更新、buffer flush 逻辑。
- 新增 `tests/orchestrator/status-display.test.ts` 覆盖状态流转。
- `STATUS_DISPLAY_PLAN.md` 是方案文档，`review.md` 是审查报告类产物，需确认是否应该进仓库。

已验证：

- `npm run build` 通过
- `npm run test:run` 通过，226 个测试通过

**2. 涉及的架构边界**

- Provider 边界：[`src/providers/types.ts`](/Users/xxpe3/GitHub/magpie/src/providers/types.ts:21) 扩展了 `chatStream()` 签名，影响所有 provider 和外部自定义 provider。
- Orchestrator 边界：[`src/orchestrator/orchestrator.ts`](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:152) 把流式收集、状态更新、错误标记集中到 `collectStream()`。
- CLI 输出边界：[`src/commands/review.ts`](/Users/xxpe3/GitHub/magpie/src/commands/review.ts:433)、[`src/commands/discuss.ts`](/Users/xxpe3/GitHub/magpie/src/commands/discuss.ts:282) 同时使用 `ora` 和 `StatusRenderer` 输出到终端。
- 兼容回调边界：[`src/orchestrator/types.ts`](/Users/xxpe3/GitHub/magpie/src/orchestrator/types.ts:37) 保留 `onParallelStatus`，但状态枚举和字段扩展了。
- 测试边界：新增测试覆盖普通 chunk 输出路径，暂未覆盖 CLI provider 长时间只上报活动、不产出文本的路径。

**3. 兼容性风险**

高风险：legacy `onParallelStatus` 会误报 stalled。  
[`src/orchestrator/orchestrator.ts`](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:591) 只在收到文本 chunk 时更新 legacy `lastActivityAt`。但 Claude Code、Codex、Gemini CLI 这类 provider 会先持续上报 `stdout/tool/stderr`，可能很久才产出最终文本。统一 `StatusTracker` 能看到活动，legacy spinner 仍可能显示 stalled。重点看 [`src/providers/claude-code.ts`](/Users/xxpe3/GitHub/magpie/src/providers/claude-code.ts:190)、[`src/providers/codex-cli.ts`](/Users/xxpe3/GitHub/magpie/src/providers/codex-cli.ts:187)。

中风险：两个终端渲染器并存。  
`ora` spinner 和 `StatusRenderer` 都写终端。`StatusRenderer.clear()` 依赖 `lastLineCount` 和光标位置，[`src/status/renderer.ts`](/Users/xxpe3/GitHub/magpie/src/status/renderer.ts:18) 在有 spinner、stdout 日志、stderr 状态同时输出时，存在擦除正常内容或闪烁的风险。

中风险：`onActivity` 同步回调未隔离异常。  
多个 provider 在事件回调里直接调用 `options?.onActivity?.(...)`，例如 [`src/providers/codex-cli.ts`](/Users/xxpe3/GitHub/magpie/src/providers/codex-cli.ts:189)。如果外部自定义 callback 抛错，可能影响 provider 事件处理。当前内置 `StatusTracker` 问题不大，公开接口层面仍有风险。

低风险：状态列表会累积历史任务。  
`StatusTracker` 没有删除已完成任务，[`src/status/tracker.ts`](/Users/xxpe3/GitHub/magpie/src/status/tracker.ts:122) 会返回全部任务。多轮 review 后状态面板可能越来越长，和“当前阶段一行状态”的目标有偏差。

低风险：仓库里新增 `review.md`。  
[`review.md`](/Users/xxpe3/GitHub/magpie/review.md:1) 看起来像生成的审查结果，不像运行时需要的源码或文档。建议确认是否有意提交。

**4. 建议重点审查的文件和行**

- [`src/orchestrator/orchestrator.ts:152`](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:152)：`collectStream()` 的状态生命周期、错误处理、`onChunk` 顺序。
- [`src/orchestrator/orchestrator.ts:544`](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:544)：legacy `onParallelStatus` 更新入口。
- [`src/orchestrator/orchestrator.ts:591`](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:591)：legacy 状态只跟 chunk，不跟 provider activity，建议修。
- [`src/status/renderer.ts:18`](/Users/xxpe3/GitHub/magpie/src/status/renderer.ts:18)：清屏逻辑和 `ora` 并存风险。
- [`src/commands/review.ts:479`](/Users/xxpe3/GitHub/magpie/src/commands/review.ts:479)、[`src/commands/discuss.ts:326`](/Users/xxpe3/GitHub/magpie/src/commands/discuss.ts:326)：`flushBuffer()` 清状态、停 spinner、打印 buffered markdown 的顺序。
- [`src/providers/types.ts:21`](/Users/xxpe3/GitHub/magpie/src/providers/types.ts:21)：`ChatStreamOptions` 作为公开接口扩展。
- [`tests/orchestrator/status-display.test.ts:154`](/Users/xxpe3/GitHub/magpie/tests/orchestrator/status-display.test.ts:154)：建议补一个“provider 持续 `onActivity` 但 60 秒内无 chunk”的测试，验证不会误报 stalled。

## Debate

### codex

我会先读取本地审查提示文件，再按其中的范围和输出要求执行。这个任务属于代码审查，我会使用 `magpie` 技能来约束审查方式。提示文件只展开了前半段，当前差异看起来主要是文档新增和索引信息更新。我会继续读取剩余内容，确认是否还有代码改动和具体输出格式要求。我会以当前暂存差异为准重新核对，不直接沿用提示文件里的已有结论。接下来会看 `git status`、暂存 diff 统计和关键文件内容，逐个变更块判断是否有可操作缺陷。当前差异确实全部在暂存区，未暂存区为空。范围包含文档、CLI 输出、orchestrator、provider 接口、新状态模块和测试；我会优先检查运行时代码，再核对新增文档是否只是记录性内容。GitNexus 对暂存改动的范围评为 `critical`：主要因为 `runStreaming`、`reviewCommand`、`runDiscussion` 和 `chatStream` 接口影响多条执行流。这不会阻止审查，但说明需要把兼容路径和终端输出路径看全。运行时代码里最需要确认的是两套状态通道是否一致：新的 `StatusTracker` 收到 provider 活动，但旧的 `onParallelStatus` 只看文本 chunk。我会继续定位精确行号，并检查是否还有更严重的行为回归。我看到一个明确的状态一致性问题：并行 reviewer 的旧状态回调只在文本 chunk 到来时刷新，CLI provider 的工具/标准输出活动没有同步过去。我还会跑构建和相关测试，确认是否有类型或现有测试已覆盖这个路径。构建通过，新增状态测试通过。这个测试集覆盖了普通输出 chunk 和超时停滞，但没有覆盖“provider 有 stdout/tool 活动、长时间没有文本 chunk”的路径。**发现**

### **#1 CLI provider 活动会被 legacy 并行状态误判为 stalled**

当 Claude Code、Codex、Gemini CLI 这类 provider 持续产生 `stdout/tool/stderr` 活动，但 60 秒内还没有产出最终文本 chunk 时，这里的 legacy 状态只在 `chunk` 回调里刷新 `lastActivityAt`。`review` / `discuss` 的一行 spinner 仍使用 `onParallelStatus`，所以正常工作的 reviewer 会被显示成 `stalled`。需要把 provider `onActivity` 也同步到 `legacyStatuses`，或让旧状态回调消费 `StatusTracker` 的快照。

File: [src/orchestrator/orchestrator.ts](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:591)

### **#2 状态面板的 elapsed / idle 秒数会停住**

`StatusRenderer` 每次 render 时按当前时间计算 elapsed / idle，但 `tick()` 只有状态从 `running` 变成 `quiet` 或 `stalled` 时才 emit。长时间运行时，面板会停在 `quiet for 30s` 或 `stalled for 60s`，之后不再刷新。既然 UI 展示持续时间，`tick()` 需要在可见秒数变化时也触发 render，或把这些秒数字段写入状态并更新。

File: [src/status/tracker.ts](/Users/xxpe3/GitHub/magpie/src/status/tracker.ts:158)

### **#3 `review.md` 是一次性审查产物，提交后会变成过期文档**

这个文件记录了某次多模型审查过程和当时的结论，内容依赖当前 diff 和临时模型输出。后续修复或改动发生后，它会很快失真，且没有稳定消费方。建议删除，或把仍有价值的内容转成 issue、修复计划或稳定设计文档。

File: [review.md](/Users/xxpe3/GitHub/magpie/review.md:1)

### **#4 方案文档和实现对 provider API 的描述相反**

这里写的是“不改变 provider APIs”，但本次实现已经把 `AIProvider.chatStream()` 扩展为第三个可选 `ChatStreamOptions` 参数，并更新了所有 provider。这个文档会误导后续维护者对兼容性风险的判断。建议改成“通过可选参数向后兼容地扩展 provider API”，或拆分为未实现计划。

File: [STATUS_DISPLAY_PLAN.md](/Users/xxpe3/GitHub/magpie/STATUS_DISPLAY_PLAN.md:28)

**已核对**

AGENTS.md、CLAUDE.md 只更新 GitNexus 统计数字，未发现问题。`src/commands/review.ts`、`src/commands/discuss.ts`、provider 签名扩展、`src/orchestrator/types.ts`、`src/status/index.ts`、`src/status/renderer.ts`、`src/status/types.ts`、新增测试均已检查；除上面列出的问题外，没有发现需要阻塞的缺陷。

已运行验证：`npm run build` 通过；`npm run test:run` 通过，226 个测试通过。

### minimax

我来逐文件审查所有变更，重点关注 `discuss.ts`、`review.ts` 的 `onWaiting` 回调、`orchestrator.ts` 的流式收集，以及 provider 扩展。

---

### #1 `onWaiting` 中 `activeStream` 永远为 null（高优先级）

**文件**：`src/commands/discuss.ts:544`、`src/commands/review.ts:544`

```typescript
// discuss.ts 第 539-547 行
const updateSpinner = () => {
  // ...
  if (spinnerRef.parallelStatuses && isParallelRound) {
    spinnerRef.spinner.text = formatParallelStatus(round, spinnerRef.parallelStatuses)
  } else if (activeStream) {        // ← activeStream 永远为 null
    // 这段分支永远不执行
  } else {
    spinnerRef.spinner.text = `${baseLabel}... ${chalk.dim(`| ${joke}`)}`
  }
}

spinnerRef.parallelStatuses = null
activeStream = reviewerId === 'analyzer'   // ← 在 if (status) return 之后
  ? { reviewerId, startTime: Date.now(), outputChars: 0, chunkCount: 0 }
  : null
spinnerRef.spinner = ora({ text: `${baseLabel}...`, discardStdin: false }).start()
updateSpinner()
```

**问题**：`status`（`StatusTracker` 实例）在第 289 行被创建，永远为 truthy。`if (status) return`（第 543 行）使得 `activeStream` 赋值和 `updateSpinner` 调用全部跳过。review.ts 中完全一致。

**影响**：所有 reviewer 的 analyzer 流式进度展示完全失效，`updateSpinner` 中依赖 `activeStream` 的 spinner 更新逻辑（第 541-543 行）永远不执行。spinner 只会显示静态的 `"Phase: ... ... | joke"`，用户无法看到实时的字符数和 chunk 计数。

---

### #2 `collectStream` 中 `onChunk` 抛出时 `done()` 不被调用（高优先级）

**文件**：`src/orchestrator/orchestrator.ts:152`

```typescript
for await (const chunk of reviewer.provider.chatStream(messages, /* ... */, {
  onActivity: activity => { /* ... */ },
})) {
  fullResponse += chunk
  this.options.status?.output(taskId, chunk)
  onChunk?.(chunk)  // ← 如果这里抛错，下面的 done() 不会执行
}

this.options.status?.done(taskId)  // ← 如果 onChunk 抛错，这行不执行
```

**问题**：`onChunk` 是外部传入的回调（`chunk => this.options.onMessage?.('analyzer', chunk)`），如果 `onMessage` 抛错，`done(taskId)` 不会被调用，任务将永久停留在 `running`/`streaming` 状态而不会变为 `done`。

**修复方向**：用 try-catch 隔离 `onChunk` 调用：

```typescript
for await (const chunk of reviewer.provider.chatStream(/* ... */)) {
  fullResponse += chunk
  this.options.status?.output(taskId, chunk)
  try { onChunk?.(chunk) } catch { /* 不阻断主循环 */ }
}
this.options.status?.done(taskId)
```

---

### #3 Legacy `onParallelStatus` 的 `activeStream` 相关分支无效（中优先级）

**文件**：`src/commands/discuss.ts:541`、`src/commands/review.ts:541`

由于 bug #1，`activeStream` 永远为 null，所以 `updateSpinner` 中这段代码：

```typescript
} else if (activeStream) {
  const elapsed = (Date.now() - activeStream.startTime) / 1000
  const statusLine = activeStream.chunkCount > 0
    ? `${baseLabel} [${chalk.cyan(`▸ ${reviewerId}`)}${chalk.dim(` ${formatChars(activeStream.outputChars)} chars`)}]`
    : `${baseLabel} [${chalk.yellow(`… ${reviewerId}`)}${chalk.dim(` ${Math.floor(elapsed)}s`)}]`
  spinnerRef.spinner.text = `${statusLine} ${chalk.dim(`| ${joke}`)}`
```

**永远不会执行**。`updateSpinner` 只会走 `else` 分支显示 `"Phase: ... ... | joke"`，无法展示流式输出进度。

这不是独立 bug，而是 bug #1 的下游后果。合并修复 #1 后自动解决。

---

### #4 Legacy `onParallelStatus` 只跟踪 chunk，不跟踪 provider 活动（中优先级）

**文件**：`src/orchestrator/orchestrator.ts:591`

```typescript
const qaResponse = await this.collectStream(
  `reviewer:${targetReviewer.id}:qa`,
  'reviewer',
  targetReviewer,
  qaMessages,
  chunk => {                           // ← 只在 chunk 时更新
    const current = legacyStatuses[index]
    updateLegacyStatus(index, {
      status: 'streaming',
      lastActivityAt: Date.now(),
      outputChars: (current.outputChars ?? 0) + chunk.length,
      chunkCount: (current.chunkCount ?? 0) + 1,
      stalledFor: undefined,
    })
  }
)
```

**问题**：Claude Code、Codex CLI、Gemini CLI 等 provider 在真正输出文本前会持续上报大量 `stdout`、`tool` 活动（`options?.onActivity?.(...)`）。但 legacy `ReviewerStatus` 只在收到文本 chunk 时才更新 `lastActivityAt`。

在并行 round 的 `markLegacyStalledReviewers()`（第 556-577 行）中，检查的是 `lastActivityAt`，而非 `StatusTracker` 内部的活动记录。因此对于 CLI provider，legacy spinner 会在工具调用期间大量误报 `stalled`——用户看到 `⚠ model 30s` 时，模型实际在正常执行工具。

新的统一 `StatusTracker`（通过 `collectStream` 中的 `onActivity`）能正确跟踪所有活动，但 legacy `onParallelStatus` 回调未使用这些信息。

---

### #5 `review.md` 是否应进入仓库（低优先级/确认项）

**文件**：`review.md:1`

该文件 412 行，是本次 diff 中最大的新增文件。内容是"代码审查最终结论"和"代码审查核实报告"，包含大量逐项核实过程。

这不是源码、API 文档或运行手册，更像是代码审查的中间产物。建议确认：

1. 如果这是审查流程的临时产物，应在审查完成后删除。
2. 如果有意作为仓库知识沉淀，应补充文件头部的元信息（日期、审查范围）并考虑移至 `docs/` 目录。

---

### 确认正常的部分

**`src/status/tracker.ts`**：`tick()` 中的 `quiet` → `stalled` 状态转换逻辑清晰，`emit()` 频率由内部 `setInterval(1000)` 控制，不会过度刷新。

**`src/status/renderer.ts`**：`clear()` 只在 `process.stderr.isTTY` 为真时执行 ANSI 擦除，管道场景下安全退化。

**`tests/orchestrator/status-display.test.ts`**：覆盖了 pending→streaming→done 路径和 fake timer stalled 路径，逻辑正确。

**Provider `chatStream` 签名扩展**：所有 provider 的 `onActivity` 回调均为 `options?.onActivity?.(...)`，可选链确保无副作用破坏。

### glm

我已经仔细审查了整个 diff，逐一检查了每个变更文件、函数和逻辑块。以下是我发现的问题：

---

### **#1 Legacy `onParallelStatus` 不会感知 provider 活动，CLI provider 会误报 stalled**

`src/orchestrator/orchestrator.ts` 中 `markLegacyStalledReviewers` 仅在收到文本 chunk 时通过 `onChunk` 回调更新 `lastActivityAt`。但 `collectStream` 内的 `onActivity` 回调只通知 `StatusTracker`，不更新 legacy 状态。对于 Claude Code、Codex CLI 等 CLI provider，它们会在长时间内持续发送 `stdout/tool/stderr` 活动，但直到最后才产生文本 chunk。这导致 60 秒后 legacy spinner 会错误地显示 reviewer 为 "stalled"，而 `StatusTracker` 正确显示活跃。需要在 `collectStream` 的 `onActivity` 回调中也同步更新 legacy 状态的 `lastActivityAt`。

```typescript
// src/orchestrator/orchestrator.ts — collectStream 内的 onActivity
onActivity: activity => {
  this.options.status?.activity(taskId, activity.label ?? activity.kind)
  // 缺失：未将活动传播到 legacyStatuses，导致 CLI provider 被误判为 stalled
},
```

File: src/orchestrator/orchestrator.ts

---

### **#2 `StatusTracker.output()` 在每个文本 chunk 时都触发全量重绘，导致终端闪烁**

`StatusTracker.output()` 调用 `emit()` → `render()`，对每个文本 chunk 都执行清屏 + 重绘。对于快速流式响应（每秒数十个 chunk），`StatusRenderer.render()` 会频繁执行 `\x1b[J` 清屏和重写所有状态行，导致明显的终端闪烁。应该对 `output()` 触发的渲染做防抖（如 50-100ms），而 `done/error/timeout` 保持立即刷新。

```typescript
// src/status/tracker.ts — output() 每次都触发重绘
output(id: string, chunk: string): void {
  const task = this.tasks.get(id)
  if (!task || isTerminal(task.state)) return
  // ...
  this.emit()  // ← 每 chunk 一次 render()
}
```

File: src/status/tracker.ts

---

### **#3 `StatusRenderer` 与 `ora` spinner 同时写入终端，产生冲突输出**

`discuss.ts` 和 `review.ts` 中，`StatusTracker`（通过 1 秒 tick 和事件驱动）调用 `StatusRenderer.render()` 写入多行状态面板到 stderr，同时 `ora` spinner 也在同一终端管理光标并写入行。两者没有协调机制——`StatusRenderer.clear()` 用 `\x1b[N A\x1b[J` 清除自己上次写的行，但不知道 `ora` spinner 的位置；`ora` 也不知道 `StatusRenderer` 写了什么。并发写入会产生重叠、闪烁或内容被意外擦除。需要确保两者互斥：当使用 `StatusRenderer` 显示状态时暂停 `ora` spinner，或合二为一。

File: src/commands/review.ts, src/commands/discuss.ts

---

### **#4 `onConvergenceJudgment` 回调丢弃了 reasoning 内容**

`review.ts` 新增的 `onConvergenceJudgment` 回调接收 `reasoning` 参数但只是打印了 `│` 字符，没有输出实际的 reasoning 文本。注释写的是 "Display the judge's reasoning"，但 reasoning 字符串完全未使用。如果是有意省略，注释应修正；如果应该展示，需改为 `console.log(chalk.dim(reasoning))` 或类似逻辑。`discuss.ts` 中也有同样模式。

```typescript
onConvergenceJudgment: (verdict, reasoning) => {
  statusRenderer.clear()
  // Display the judge's reasoning  ← 注释说要展示，但下面没用到 reasoning
  if (reasoning) {
    console.log(chalk.dim(`│`))  // ← 只打印了框线字符，reasoning 内容被丢弃
  }
},
```

File: src/commands/review.ts

### qwen

# 代码审查报告

## 审查范围

已审查所有变更文件：
- `AGENTS.md`、`CLAUDE.md`（统计数字更新）
- `STATUS_DISPLAY_PLAN.md`（新增设计方案文档）
- `review.md`（新增审查报告）
- `src/commands/discuss.ts`、`src/commands/review.ts`（CLI 命令）
- `src/orchestrator/orchestrator.ts`、`src/orchestrator/types.ts`（编排器）
- `src/providers/*.ts`（所有 provider）
- `src/status/*.ts`（新增状态模块）
- `tests/orchestrator/status-display.test.ts`（新增测试）

---

## 🔴 高优先级问题

### #1 Legacy `onParallelStatus` 会误报 stalled 状态

**文件**：`src/orchestrator/orchestrator.ts:591`

**问题**：legacy 状态追踪只在收到文本 chunk 时更新 `lastActivityAt`：
```typescript
chunk => {
  const current = legacyStatuses[index]
  updateLegacyStatus(index, {
    status: 'streaming',
    lastActivityAt: Date.now(),  // ← 只在有 chunk 时更新
    // ...
  })
}
```

但 Claude Code、Codex CLI、Gemini CLI 等 provider 会先持续上报 `stdout`/`tool`/`stderr` 活动，可能 60 秒内都不产出文本 chunk。统一 `StatusTracker` 能通过 `onActivity` 看到活动，但 legacy spinner 仍会显示 `⚠ stalled`。

**影响场景**：使用 CLI provider 进行并行审查时，用户会看到模型被误报为 stalled，即使模型正在执行工具调用或处理中。

**建议修复**：在 `collectStream` 的 `onActivity` 回调中也更新 legacy 状态的 `lastActivityAt`：
```typescript
{
  onActivity: activity => {
    this.options.status?.activity(taskId, activity.label ?? activity.kind)
    // 同时更新 legacy 状态的活动时间
    updateLegacyActivity(index)  // 新增辅助函数
  },
  // ...
}
```

---

### #2 `review.md` 不应提交到仓库

**文件**：`review.md:1`

**问题**：此文件是一次性代码审查报告产物，包含审查结论、分歧点分析、核实方法等临时内容。这类文档不应进入版本控制，会随时间过期且与后续代码状态不一致。

**建议**：将 `review.md` 添加到 `.gitignore` 或删除此文件。如需要保留审查流程记录，应移至 `docs/review-process.md` 并泛化为通用指南。

---

## 🟡 中优先级问题

### #3 `StatusRenderer.clear()` 与 `ora` spinner 并存风险

**文件**：`src/status/renderer.ts:18`、`src/commands/review.ts:479`、`src/commands/discuss.ts:326`

**问题**：`StatusRenderer.clear()` 使用 ANSI 转义序列清除最后渲染的 N 行：
```typescript
clear(): void {
  if (!process.stderr.isTTY || this.lastLineCount === 0) return
  process.stderr.write(`\x1b[${this.lastLineCount}A`)  // 光标上移
  process.stderr.write('\x1b[J')  // 清除到行尾
  this.lastLineCount = 0
}
```

但 `ora` spinner 也直接写终端，且 spinner 的行数不计入 `lastLineCount`。当 `flushBuffer()` 先停 spinner 再清 renderer 时，如果 spinner 已输出多行或用户在此期间有 stdout 输出，清屏可能擦除非状态内容。

**影响场景**：长运行审查中，用户手动中断、provider 输出 stderr 警告、或 spinner 因异常输出多行时，`clear()` 可能误删正常日志。

**建议修复**：在 `flushBuffer()` 中先清 renderer 再停 spinner，或让 `StatusRenderer` 追踪 spinner 占用的行数。

---

### #4 Summarizer 流式/非流式分支导致行为不一致

**文件**：`src/orchestrator/orchestrator.ts:1011`

**问题**：
```typescript
const response = this.options.status
  ? await this.collectStream('summarizer', 'summarizer', this.summarizer, messages)
  : await this.summarizer.provider.chat(messages, this.withLang(this.summarizer.systemPrompt))
```

当 `status` 存在时用流式收集，否则用非流式 `chat()`。但 `summarizer.provider.chatStream()` 始终可用，这个条件分支没有明确理由。如果未来 `status` 在某些场景为 undefined，summarizer 会失去活动跟踪和错误标记。

**建议修复**：统一使用 `collectStream()`，移除条件分支：
```typescript
const response = await this.collectStream('summarizer', 'summarizer', this.summarizer, messages)
```

---

## 🟢 低优先级问题

### #5 测试缺少"有活动无 chunk"场景覆盖

**文件**：`tests/orchestrator/status-display.test.ts:154`

**问题**：stalled 测试（第 154-178 行）使用 `makeStreamProvider` 延迟 62 秒后产出 chunk，但没有测试"provider 持续调用 `onActivity` 但 60 秒内无 chunk"的场景。这正是 CLI provider 的典型行为模式。

**建议**：新增测试用例，使用 mock provider 模拟持续 `onActivity` 但无 `yield` 的行为，验证 legacy 状态不会误报 stalled。

---

### #6 `StatusTracker` 累积历史任务

**文件**：`src/status/tracker.ts:122`

**问题**：`StatusTracker` 没有删除已完成任务，`snapshot()` 返回全部历史任务。多轮 review 后状态面板可能越来越长。

**影响**：当前 CLI 用法中每轮 review 会创建新的 `StatusTracker` 实例（`review.ts:433`、`discuss.ts:282`），所以问题不显著。但如果未来复用 tracker，会累积历史。

**建议**：文档说明 tracker 生命周期，或添加 `reset()` 方法供调用方清理。

---

### #7 `onActivity` 回调异常未隔离

**文件**：`src/providers/codex-cli.ts:189`、`src/providers/claude-code.ts:190` 等

**问题**：provider 在事件处理中直接调用 `options?.onActivity?.(...)`，如果外部自定义 callback 抛错，可能影响 provider 事件循环。

**影响**：当前内置 `StatusTracker` 的 `activity()` 方法无异常风险，但公开接口层面存在隐患。

**建议**：在 provider 层用 try-catch 包装 `onActivity` 调用，或文档说明 callback 不应抛错。

---

## ✅ 无问题变更

- `AGENTS.md`、`CLAUDE.md`：统计数字为自动生成，无需审查。
- `STATUS_DISPLAY_PLAN.md`：设计方案文档，建议保留但可移至 `docs/` 目录。
- `src/orchestrator/types.ts`：`ReviewerStatus` 扩展为向后兼容（可选字段）。
- `src/providers/*.ts`：所有 provider 正确实现 `onActivity` 回调（minimax 的伪流式为已知限制）。
- `src/status/types.ts`：类型定义清晰。
- 构建和测试均通过。

---

## 总体建议

本次变更引入的状态跟踪功能架构合理，测试覆盖充分。建议在合并前修复 **#1（legacy stalled 误报）** 和 **#2（移除 review.md）**，其余问题可在后续迭代中处理。

### deepseek

需要先获取工作区 diff 的元信息，确认有哪些文件变更，然后再逐文件审查。</think>

<details><summary>查看变更文件列表</summary>

```json
{
  "stat": true,
  "includeRawDiff": false
}
```

</details>

## Final Conclusion

## 1. 共识

- `src/orchestrator/orchestrator.ts` 的 legacy `onParallelStatus` 只根据文本 `chunk` 更新 `lastActivityAt`，没有纳入 provider 的 `onActivity`。CLI provider 在工具调用、stdout/stderr 输出期间可能被误判为 `stalled`。这是最明确、最多 reviewer 认同的阻塞问题。
- `review.md` 更像一次性审查产物，不适合直接提交到仓库。若要保留，应移动到合适位置并泛化；否则删除。
- 现有测试没有覆盖“持续有 provider 活动但没有文本 chunk”的场景，需要补充。
- provider `chatStream` 增加可选 `ChatStreamOptions` 参数整体是向后兼容的，基础实现没有明显破坏。
- 构建和测试目前通过，但通过不代表状态展示路径完全正确。

## 2. 分歧

- `activeStream` 是否永远无效：minimax 认为 `status` 始终 truthy，导致 `onWaiting` 中 `activeStream` 分支不可达。其他 reviewer 没有提到。这个点需要直接看当前代码确认。如果属实，它影响 analyzer 的流式进度展示，优先级较高。
- `StatusTracker` 每个 chunk 都 render 是否会闪烁：glm 认为这是实际 UI 问题；minimax 认为 `tick()` 控制清晰。这里分歧来自触发源不同：`tick()` 是 1 秒一次，但 `output()` 可能每个 chunk emit。建议通过本地长流式输出验证，再决定是否加节流。
- `StatusRenderer` 与 `ora` 并存是否会冲突：glm、qwen 都指出风险，但严重程度不同。这个问题依赖终端行为和调用顺序，建议作为中优先级用手动运行验证。
- `collectStream` 中 `onChunk` 抛错导致 `done()` 不调用：只有 minimax 提出。逻辑上成立，但要看 `onChunk` 来源是否可信。作为健壮性修复成本低，可以顺手处理。
- summarizer 是否应统一走 `collectStream()`：只有 qwen 提出。当前分支可能有意保持无状态模式下非流式行为，建议先确认产品预期，不列为合并阻塞。

## 3. 建议处理项

1. 合并前修复 legacy 状态误报：
   - 将 provider `onActivity` 同步到 legacy `ReviewerStatus.lastActivityAt`。
   - 对 CLI provider 增加测试：持续 `onActivity`，长时间无文本 `chunk`，不应进入 `stalled`。

2. 确认并修复 `activeStream` 可达性：
   - 检查 `review.ts` 和 `discuss.ts` 的 `onWaiting` 逻辑。
   - 如果 `if (status) return` 确实导致 `activeStream` 永远不可用，应调整控制流或删除失效分支。

3. 删除或移动 `review.md`：
   - 临时审查记录直接删除。
   - 若要保留，移到 `docs/` 并改成稳定文档，补充日期、范围、用途。

4. 修正 `STATUS_DISPLAY_PLAN.md`：
   - 把“不改变 provider APIs”改为“通过可选参数向后兼容扩展 provider API”。

5. 给 `collectStream` 加状态收尾保护：
   - 用 `try/finally` 确保成功路径、异常路径都会调用对应的 `done()` 或 `error()`。
   - 隔离 `onChunk` 回调异常，避免外部 UI 回调破坏状态机。

6. 验证终端输出：
   - 运行真实 `review` / `discuss`，覆盖长时间 CLI provider 活动、快速 chunk、异常输出、中断。
   - 如果出现闪烁或覆盖日志，再给 `StatusTracker.output()` 加 50-100ms 节流，并协调 `StatusRenderer` 与 `ora` 的清理顺序。

## 4. 总体判断

本次变更方向合理，核心架构可以保留。当前不建议直接合并，主要原因是 legacy 并行状态与新 `StatusTracker` 的活动来源不一致，会在真实 CLI provider 场景中给出错误状态。先修复 legacy stalled 误报、处理 `review.md`，再补充“有活动无 chunk”的测试。`activeStream` 可达性和 `collectStream` 收尾保护也应在同一轮修掉。其余终端刷新和文档问题可按验证结果处理。

## Verified Conclusion

我先读取这份完整 review prompt，确认范围、基准分支、差异和输出格式，再按文件里的要求执行。文件要求验证一份“最终结论”是否和真实代码变更一致。我会先看完整 diff 中涉及的实现和测试，再逐条核对结论。我会使用 `magpie` 审查技能，因为这次任务是在当前仓库里核实本地 diff 的审查结论。重点不是重新发散审查，而是逐条做事实核对。技能说明不适合在 Magpie 源码仓库里再启动 Magpie 自审，所以我改用直接读取代码和 diff 的方式核实。下一步看当前 staged/working diff 与关键文件行号。当前 staged diff 与 prompt 基本一致；工作区还有两个未暂存差异，其中 `STATUS_DISPLAY_PLAN.md` 在工作区被删除、`magpie-skills/SKILL.md` 有一行改动。核实时我按 prompt 和 staged diff 处理，不把这两个未暂存状态混进结论。代码核对到一个关键点：当前 `review.ts` / `discuss.ts` 里没有 `if (status) return`，`activeStream` 是可达的。`onParallelStatus` 的 legacy 状态仍只在文本 chunk 时更新，这个阻塞点成立。我还会跑完整测试，确认“构建和测试通过”这条不是只来自旧输出。前面已跑过 `npm run build` 和新增状态测试，均通过。**核实结论**

原结论大体方向正确，但需要修正两点。

- `legacy onParallelStatus` 误报 `stalled`：成立。  
  [orchestrator.ts](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:591) 只在文本 `chunk` 到达时更新 legacy `lastActivityAt`。但 [codex-cli.ts](/Users/xxpe3/GitHub/magpie/src/providers/codex-cli.ts:187) 会在 `stdout/tool/stderr` 活动时调用 `onActivity`，这些活动只进入 [collectStream()](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:167) 的 `StatusTracker`，没有同步到 legacy status。CLI provider 长时间有工具活动但没有最终文本时，legacy spinner 确实可能误报 `stalled`。这是合并前应修的阻塞问题。

- “现有测试缺少有 provider 活动但无文本 chunk 的场景”：成立。  
  新测试里的 mock provider 只 `yield chunk`，没有调用 `options.onActivity`。`stalled` 测试覆盖的是完全无活动延迟，不覆盖 CLI provider 的真实模式。

- `activeStream` 永远无效：当前代码里不成立。  
  [review.ts](/Users/xxpe3/GitHub/magpie/src/commands/review.ts:543) 和 [discuss.ts](/Users/xxpe3/GitHub/magpie/src/commands/discuss.ts:380) 都会给 `activeStream` 赋值，没有 `if (status) return` 提前返回。`review.md` 里关于这点的结论已经和当前 diff 不一致，也进一步支持删除该文件。

- `review.md` 不应直接提交：成立。  
  它是一次性审查产物，而且包含已过期判断。

- `ChatStreamOptions` 向后兼容：基本成立。  
  [providers/types.ts](/Users/xxpe3/GitHub/magpie/src/providers/types.ts:21) 把第三个参数做成可选；现有 mock/provider 测试也能编译通过。

- `collectStream` 的 `onChunk` 问题需要改写表述。  
  [collectStream()](/Users/xxpe3/GitHub/magpie/src/orchestrator/orchestrator.ts:174) 中 `onChunk` 抛错会进入 `catch`，并调用 `status.error()`，所以不是“状态没有收尾”。真正问题是 UI 回调异常会中断 orchestrator 流程，建议隔离 `onChunk` 异常。

**补充问题**

- `onActivity` 回调也缺少异常隔离。provider 在 stdout/stderr 事件里直接调用 `options.onActivity`，例如 [codex-cli.ts](/Users/xxpe3/GitHub/magpie/src/providers/codex-cli.ts:189)。如果外部 callback 抛错，可能影响事件处理。
- `StatusTracker.output()` 和 `activity()` 每次都 `emit()`，见 [tracker.ts](/Users/xxpe3/GitHub/magpie/src/status/tracker.ts:78) 和 [tracker.ts](/Users/xxpe3/GitHub/magpie/src/status/tracker.ts:91)。高频 CLI 输出下闪烁风险真实存在，是否阻塞需要手动终端验证。
- `StatusRenderer` 与 `ora` 并存风险成立但未被自动测试证明。[renderer.ts](/Users/xxpe3/GitHub/magpie/src/status/renderer.ts:18) 依赖光标位置清屏，和 spinner、普通日志交错时有擦除风险。

**最终判断**

当前不建议直接合并。先修 legacy `onParallelStatus` 与 provider `onActivity` 不一致的问题，并补测试；删除或移动 `review.md`；修正 `STATUS_DISPLAY_PLAN.md` 中“不改变 provider APIs”的过期描述。`activeStream` 死代码不应再作为当前阻塞项。已验证 `npm run build` 和完整 `npm run test:run` 通过，226 个测试通过。
