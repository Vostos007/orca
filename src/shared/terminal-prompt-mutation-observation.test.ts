import { describe, expect, it } from 'vitest'
import { projectTerminalPromptMutation } from './terminal-prompt-mutation-observation'
import { describeMutationRequestState } from './orchestration-mutation-request'

const receipt = {
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
const completed = { requestId: 'request_1', state: 'completed' as const, method: 'terminal.send' }

describe('terminal prompt mutation observation', () => {
  it('separates recorded delivery from unknown execution and names the existing owner', () => {
    expect(projectTerminalPromptMutation({ ...completed, receipt })).toEqual({
      scope: 'terminal_input',
      recordedDelivery: 'turn_started',
      modelConsumption: 'unknown',
      taskOutcome: 'unknown',
      nextAction: 'inspect_existing_owner',
      terminal: 'term_fixture',
      processIncarnation: 'fixture-incarnation',
      generation: 4
    })
    expect(receipt.send.prompt.stages).toEqual(['input_accepted', 'turn_started'])
  })

  it('records input-only acceptance without claiming a started turn', () => {
    const inputOnly = {
      send: { ...receipt.send, prompt: { ...receipt.send.prompt, stages: ['input_accepted'] } }
    }
    expect(
      projectTerminalPromptMutation({ ...completed, receipt: inputOnly })?.recordedDelivery
    ).toBe('input_accepted')
  })

  it.each([undefined, null, [], { send: null }, { send: { prompt: { stages: 'turn_started' } } }])(
    'keeps missing or malformed historical evidence unknown: %j',
    (value) => {
      expect(
        projectTerminalPromptMutation({ ...completed, receipt: value })?.recordedDelivery
      ).toBe('unknown')
    }
  )

  it('does not borrow another request receipt or expose its incarnation', () => {
    const mismatched = {
      send: { ...receipt.send, prompt: { ...receipt.send.prompt, requestId: 'other_request' } }
    }
    const result = projectTerminalPromptMutation({ ...completed, receipt: mismatched })
    expect(result?.recordedDelivery).toBe('unknown')
    expect(result).not.toHaveProperty('terminal')
    expect(result).not.toHaveProperty('processIncarnation')
    expect(result).not.toHaveProperty('generation')
  })

  it('does not treat a refused write or a lone turn_started as accepted input', () => {
    expect(
      projectTerminalPromptMutation({
        ...completed,
        receipt: { send: { ...receipt.send, accepted: false } }
      })?.recordedDelivery
    ).toBe('unknown')
    expect(
      projectTerminalPromptMutation({
        ...completed,
        receipt: {
          send: { ...receipt.send, prompt: { ...receipt.send.prompt, stages: ['turn_started'] } }
        }
      })?.recordedDelivery
    ).toBe('unknown')
  })

  it('adds no terminal observation to unrelated methods or absent requests', () => {
    expect(
      projectTerminalPromptMutation({ ...completed, method: 'orchestration.workerStart', receipt })
    ).toBeUndefined()
    expect(
      projectTerminalPromptMutation({ ...completed, state: 'absent', receipt })
    ).toBeUndefined()
  })

  it('never advises a new prompt or replay to prove task completion', () => {
    const text = describeMutationRequestState({ ...completed, receipt })
    expect(text).toContain('completed terminal.send RPC receipt')
    expect(text).toContain('turn_started')
    expect(text).toContain('Model consumption and task outcome are unknown')
    expect(text).toContain('existing owner')
    expect(text).toContain('Do not send a new prompt')
    expect(text).not.toContain('--retry-request')
  })

  it('does not describe a completed refused RPC as a terminal input effect', () => {
    const text = describeMutationRequestState({
      ...completed,
      receipt: { send: { ...receipt.send, accepted: false } }
    })
    expect(text).toContain('completed terminal.send RPC receipt')
    expect(text).toContain('Recorded delivery: unknown')
    expect(text).not.toContain('terminal input effect')
  })

  it('keeps a pending prompt ambiguous and asks to wait for the original command', () => {
    const text = describeMutationRequestState({ ...completed, state: 'pending' })
    expect(text).toContain('may already have reached')
    expect(text).toContain('Wait for the original command')
    expect(text).not.toContain('--retry-request')
  })

  it('preserves other mutation interpretations', () => {
    expect(
      describeMutationRequestState({ ...completed, method: 'orchestration.workerStart' })
    ).toContain('--retry-request request_1')
    expect(describeMutationRequestState({ requestId: 'request_1', state: 'absent' })).toContain(
      'Absent is not proof that nothing happened'
    )
  })

  it('does not include message content or copy arbitrary receipt fields into metadata', () => {
    const result = projectTerminalPromptMutation({
      ...completed,
      receipt: {
        ...receipt,
        message: 'synthetic private body',
        send: { ...receipt.send, text: 'synthetic prompt' }
      }
    })
    expect(JSON.stringify(result)).not.toContain('synthetic')
    expect(result).not.toHaveProperty('message')
    expect(result).not.toHaveProperty('text')
  })
})
