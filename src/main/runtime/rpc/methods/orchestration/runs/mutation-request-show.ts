import { projectTerminalPromptMutation } from '../../../../../../shared/terminal-prompt-mutation-observation'
import {
  describeMutationRequestState,
  type OrchestrationMutationRequestShowResult
} from '../../../../../../shared/orchestration-mutation-request'
import { defineMethod } from '../../../core'
import { RequestShowParams } from '../../../../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'

export const ORCHESTRATION_MUTATION_REQUEST_METHODS = [
  defineMethod({
    name: 'orchestration.requestShow',
    params: RequestShowParams,
    // Why: recovery needs a way to ask whether a mutation landed without mutating
    // again; this reads the durable receipt and never writes one, so it must stay
    // out of ORCHESTRATION_MUTATION_METHODS.
    handler: (
      params,
      { runtime, authenticatedCallerFingerprint }
    ): OrchestrationMutationRequestShowResult => {
      const db = runtime.getOrchestrationDb()
      // Why: receipts are keyed by caller identity; a paired client brings its own
      // fingerprint, a local caller shares the one its mutations were recorded under.
      const callerFingerprint =
        authenticatedCallerFingerprint ?? db.getOrCreateLocalMutationCallerFingerprint()
      const row = db.getMutationReceipt(callerFingerprint, params.request)
      if (!row) {
        return {
          requestId: params.request,
          state: 'absent',
          interpretation: describeMutationRequestState({
            requestId: params.request,
            state: 'absent'
          })
        }
      }
      const receipt = row.receipt ? parseReceipt(row.receipt) : undefined
      const terminalPrompt = projectTerminalPromptMutation({
        requestId: params.request,
        state: row.state,
        method: row.method,
        receipt
      })
      return {
        requestId: params.request,
        state: row.state,
        method: row.method,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.receipt ? { receipt } : {}),
        ...(terminalPrompt ? { terminalPrompt } : {}),
        interpretation: describeMutationRequestState({
          requestId: params.request,
          state: row.state,
          method: row.method,
          receipt
        })
      }
    }
  })
]

function parseReceipt(receipt: string): unknown {
  try {
    return JSON.parse(receipt)
  } catch {
    return undefined
  }
}
