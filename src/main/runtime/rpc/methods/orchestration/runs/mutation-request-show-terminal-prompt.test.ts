import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_MUTATION_REQUEST_METHODS } from './mutation-request-show'

const method = ORCHESTRATION_MUTATION_REQUEST_METHODS[0]
const accepted = {
  send: {
    accepted: true,
    handle: 'term_fixture',
    prompt: {
      requestId: 'request_1',
      stages: ['input_accepted', 'turn_started'],
      processIncarnation: 'fixture-incarnation',
      generation: 4
    }
  }
}

function show(
  state: 'pending' | 'completed',
  receipt: string | null,
  fingerprint = 'fixture-caller'
) {
  const row = {
    state,
    method: 'terminal.send',
    receipt,
    created_at: 'fixture-created',
    updated_at: 'fixture-updated'
  }
  const getMutationReceipt = vi.fn(() => row)
  const db = { getMutationReceipt }
  const runtime = { getOrchestrationDb: () => db }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read-only handler uses only getOrchestrationDb/getMutationReceipt; the paired caller identity is explicit.
  const result = method.handler({ request: 'request_1' }, {
    runtime,
    authenticatedCallerFingerprint: fingerprint
  } as never)
  return { result, getMutationReceipt, row }
}

describe('read-only terminal prompt request receipt', () => {
  it('adds metadata to an old receipt without changing its state, payload or caller fence', () => {
    const { result, getMutationReceipt, row } = show('completed', JSON.stringify(accepted))
    expect(result.state).toBe('completed')
    expect(result.receipt).toEqual(accepted)
    expect(result.terminalPrompt).toMatchObject({
      scope: 'terminal_input',
      recordedDelivery: 'turn_started',
      modelConsumption: 'unknown',
      taskOutcome: 'unknown',
      nextAction: 'inspect_existing_owner',
      terminal: 'term_fixture',
      processIncarnation: 'fixture-incarnation',
      generation: 4
    })
    expect(getMutationReceipt).toHaveBeenCalledExactlyOnceWith('fixture-caller', 'request_1')
    expect(row.receipt).toBe(JSON.stringify(accepted))
  })

  it('keeps malformed historical receipts and missing pending evidence unknown', () => {
    for (const receipt of ['not json', null]) {
      const { result } = show('pending', receipt)
      expect(result.state).toBe('pending')
      expect(result.terminalPrompt?.recordedDelivery).toBe('unknown')
      expect(result.interpretation).toContain('Wait for the original command')
      expect(result.interpretation).not.toContain('--retry-request')
    }
  })
})
