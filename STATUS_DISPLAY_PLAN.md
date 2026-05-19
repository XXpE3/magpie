# Parallel Review Status Display Plan

## Goal

Make long-running multi-model reviews observable: users should see the current phase/step, which models are active, which models are producing output, and which models appear stalled.

## Current Findings

- Main parallel review flow: `src/orchestrator/orchestrator.ts` → `DebateOrchestrator.runStreaming()`.
- CLI display entrypoints:
  - `src/commands/review.ts` for `magpie review`.
  - `src/commands/discuss.ts` for discussion mode.
- Current status type: `ReviewerStatus` in `src/orchestrator/types.ts` only supports `pending | thinking | done | error`, plus start/end/duration.
- Current UI renders a single ora spinner line via local `formatParallelStatus()` functions.
- Parallel model calls are already tracked at start/done/error, but not per output activity.
- During the parallel round, chunks from `chatStream()` are accumulated silently; `onMessage` is only called after a reviewer fully finishes, so users cannot tell if a model is actively outputting.
- Repo-wide feature review flow (`src/orchestrator/repo-orchestrator.ts`) runs reviewers sequentially per feature and only prints coarse `[n/total] Reviewing ...` progress.

## Impact / Risk Notes

- `DebateOrchestrator.runStreaming()` impact is HIGH: direct callers include `reviewCommand`, `runDiscussion`, and resilience tests; it affects review and discussion flows.
- `ReviewerStatus` impact is HIGH because it is imported widely. Keep changes backward-compatible by adding optional fields and avoiding breaking renames.
- `formatParallelStatus()` in `src/commands/review.ts` impact is LOW.
- `RepoOrchestrator.executeStep()` impact is LOW.

## Proposed Small Feature

Add lightweight liveness-aware status reporting without changing provider APIs.

### Status Model

Extend `ReviewerStatus` additively:

- `status`: keep existing states, optionally add `streaming` and `stalled`.
- `lastActivityAt?: number` — updated on each received stream chunk.
- `outputChars?: number` — cumulative emitted/received characters.
- `chunkCount?: number` — number of stream chunks observed.
- `stalledFor?: number` — seconds since last activity when over threshold.

Recommended status semantics:

- `pending`: queued, not started.
- `thinking`: started, no output chunks yet.
- `streaming`: at least one chunk received recently.
- `stalled`: started but no chunk/activity for threshold, while still running.
- `done`: completed successfully.
- `error`: failed.

### Orchestrator Changes

In `DebateOrchestrator.runStreaming()`:

1. Initialize each reviewer status with `pending`.
2. On task start, set `thinking`, `startTime`, `lastActivityAt`.
3. Inside `for await (const chunk of reviewer.provider.chatStream(...))`:
   - append chunk as today;
   - update `status` to `streaming`;
   - update `lastActivityAt`, `chunkCount`, `outputChars`;
   - call `onParallelStatus(round, statuses)`.
4. Add a small interval during the parallel `Promise.all` phase that recalculates stalled reviewers every 1–2s:
   - if running and `Date.now() - lastActivityAt > threshold`, mark `stalled` and set `stalledFor`;
   - emit `onParallelStatus` when visible state changes.
5. Clear the interval in `finally` after all reviewer tasks settle.

Default stall threshold: 60s initially. Make it a constant, not config, unless users ask for configurability.

### CLI Display Changes

Update `formatParallelStatus()` in both `src/commands/review.ts` and `src/commands/discuss.ts`:

- `○ model` pending
- `… model 12s` thinking
- `▸ model 1.2k chars` streaming/outputting
- `⚠ model stalled 75s` stalled
- `✓ model 38.4s` done
- `✗ model 38.4s` error

Also show phase text before the model list:

- `Phase: context gathering`
- `Phase: analyzing changes`
- `Round 1/2: parallel review`
- `Phase: convergence check`
- `Phase: final summary`

Keep it to one concise spinner line to avoid noisy terminal output.

### Repo Review Flow

For `RepoOrchestrator` / `executeFeatureReview()`:

- Reuse the same `ReviewerStatus` shape for each feature step.
- Add optional callback `onReviewerStatus?: (step, index, total, statuses) => void` to `RepoOrchestratorOptions`.
- Update `executeStep()` to emit per-reviewer status before/after each reviewer call.
- This can be a second patch if we want to keep the first patch focused on the existing parallel debate flow.

## Test Plan

1. Unit-test status transitions with `MockProvider.chatStream()`:
   - pending → thinking → streaming → done.
   - provider error → error.
2. Add fake slow stream test using fake timers:
   - thinking/streaming → stalled after threshold.
3. Test `formatParallelStatus()` output for every state.
4. Run:
   - `npm run build`
   - `npm run test:run`

## Suggested Implementation Order

1. Add optional liveness fields to `ReviewerStatus`.
2. Update `runStreaming()` to record chunk activity and emit live status.
3. Add stall detection interval around the parallel reviewer phase.
4. Update `review.ts` and `discuss.ts` status rendering.
5. Add/adjust tests.
6. Run GitNexus change detection before committing: `gitnexus_detect_changes()`.
