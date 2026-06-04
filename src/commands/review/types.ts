// src/commands/review/types.ts
import type { Message } from '../../providers/types.js'
export type { ReviewTarget, ReviewTargetPayload, ReviewTargetFile } from '../../orchestrator/types.js'

export interface ReviewerSessionState {
  conversationHistory: Message[]
  sessionStarted: boolean
}
