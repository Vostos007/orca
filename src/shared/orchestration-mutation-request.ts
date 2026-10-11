import {
  projectTerminalPromptMutation,
  type TerminalPromptMutationObservation
} from './terminal-prompt-mutation-observation'

// Shared shape for `orchestration request-show`, the read-only answer to
// "did my mutation take effect?" when the response was lost in transit.

export const MUTATION_REQUEST_STATES = ['completed', 'pending', 'absent'] as const

export type OrchestrationMutationRequestState = (typeof MUTATION_REQUEST_STATES)[number]

export type OrchestrationMutationRequestShowResult = {
  requestId: string
  state: OrchestrationMutationRequestState
  method?: string
  createdAt?: string
  updatedAt?: string
  receipt?: unknown
  /** Recorded input evidence; absence on older hosts leaves execution unknown. */
  terminalPrompt?: TerminalPromptMutationObservation
  // Why: `absent` is genuinely ambiguous, so the honest reading ships with the row
  // instead of being re-derived (and softened) by every caller.
  interpretation: string
}

export function describeMutationRequestState(params: {
  requestId: string
  state: OrchestrationMutationRequestState
  method?: string
  receipt?: unknown
}): string {
  const { requestId, state, method } = params
  const terminalPrompt = projectTerminalPromptMutation(params)
  if (terminalPrompt) {
    const input =
      state === 'pending'
        ? 'has a pending terminal.send receipt; input may already have reached its recorded terminal'
        : 'has a completed terminal.send RPC receipt'
    const delivery = `Recorded delivery: ${terminalPrompt.recordedDelivery}.`
    const wait =
      state === 'pending' ? 'Wait for the original command when it is still running. ' : ''
    return `Request ${requestId} ${input}. ${delivery} Model consumption and task outcome are unknown. ${wait}Inspect the existing owner's task/result metadata for this request and recorded incarnation before continuing. Do not send a new prompt to resolve this uncertainty.`
  }
  if (state === 'completed') {
    return `Request ${requestId} already took effect${method ? ` (${method})` : ''}. Replaying it with --retry-request ${requestId} returns the recorded outcome and starts nothing new.`
  }
  if (state === 'pending') {
    return `Request ${requestId} was accepted${method ? ` by ${method}` : ''} but its outcome is not recorded yet. The original mutation may still be running, or Orca may have restarted before recording its outcome. Wait for the original command when it is still running; otherwise replay it with --retry-request ${requestId}. Do not issue a fresh mutation.`
  }
  return `No receipt for request ${requestId} under this caller identity. It never reached this Orca runtime, failed before recording anything, or its receipt was pruned. Absent is not proof that nothing happened.`
}
