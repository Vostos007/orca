export type TerminalPromptMutationObservation = {
  scope: 'terminal_input'
  recordedDelivery: 'unknown' | 'input_accepted' | 'turn_started'
  modelConsumption: 'unknown'
  taskOutcome: 'unknown'
  nextAction: 'inspect_existing_owner'
  terminal?: string
  processIncarnation?: string
  generation?: number
}

export function projectTerminalPromptMutation(params: {
  requestId: string
  state: 'completed' | 'pending' | 'absent'
  method?: string
  receipt?: unknown
}): TerminalPromptMutationObservation | undefined {
  if (params.method !== 'terminal.send' || params.state === 'absent') {
    return undefined
  }
  const receipt = isRecord(params.receipt) ? params.receipt : undefined
  const send = isRecord(receipt?.send) ? receipt.send : undefined
  const prompt = isRecord(send?.prompt) ? send.prompt : undefined
  const matchesRequest = prompt !== undefined && prompt.requestId === params.requestId
  const stages = matchesRequest && Array.isArray(prompt.stages) ? prompt.stages : []
  const accepted = send?.accepted === true && stages.includes('input_accepted')
  return {
    scope: 'terminal_input',
    recordedDelivery: accepted
      ? stages.includes('turn_started')
        ? 'turn_started'
        : 'input_accepted'
      : 'unknown',
    modelConsumption: 'unknown',
    taskOutcome: 'unknown',
    nextAction: 'inspect_existing_owner',
    ...(matchesRequest && typeof send?.handle === 'string' ? { terminal: send.handle } : {}),
    ...(matchesRequest && typeof prompt.processIncarnation === 'string'
      ? { processIncarnation: prompt.processIncarnation }
      : {}),
    ...(matchesRequest &&
    typeof prompt.generation === 'number' &&
    Number.isSafeInteger(prompt.generation) &&
    prompt.generation >= 0
      ? { generation: prompt.generation }
      : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
