import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../format', () => ({ printResult: vi.fn() }))
vi.mock('../../runtime-client', () => ({
  RuntimeClientError: class extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
}))

import { printResult } from '../../format'
import { ORCHESTRATION_REQUEST_SHOW_HANDLER } from './mutation-request-show-handler'

const call = vi.fn()
const handler = ORCHESTRATION_REQUEST_SHOW_HANDLER['orchestration request-show']

async function run(json = false): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only uses this mocked client's call method.
  await handler({
    flags: new Map([['request', 'request_1']]),
    client: { call },
    cwd: '/tmp/fixture',
    json
  } as never)
}

describe('request-show terminal prompt copy', () => {
  beforeEach(() => {
    call.mockReset()
    vi.mocked(printResult).mockReset()
  })

  it('corrects legacy terminal-send completion copy without issuing another command', async () => {
    const result = {
      requestId: 'request_1',
      state: 'completed',
      method: 'terminal.send',
      interpretation:
        'Request request_1 already took effect. Replaying returns the recorded outcome.'
    }
    call.mockResolvedValue(result)
    await run()
    const args = vi.mocked(printResult).mock.calls[0]
    const text = args[2]?.(result)
    expect(text).toContain('[RPC completed]')
    expect(text).toContain('Recorded delivery: unknown')
    expect(text).toContain('Model consumption and task outcome are unknown')
    expect(text).toContain('existing owner')
    expect(text).not.toContain('Replaying')
    expect(call).toHaveBeenCalledExactlyOnceWith('orchestration.requestShow', {
      request: 'request_1'
    })
  })

  it('renders recorded turn-start evidence while leaving execution unknown', async () => {
    const result = {
      requestId: 'request_1',
      state: 'completed',
      method: 'terminal.send',
      interpretation: 'legacy',
      receipt: {
        send: {
          accepted: true,
          prompt: { requestId: 'request_1', stages: ['input_accepted', 'turn_started'] }
        }
      }
    }
    call.mockResolvedValue(result)
    await run()
    const text = vi.mocked(printResult).mock.calls[0][2]?.(result)
    expect(text).toContain('Recorded delivery: turn_started')
    expect(text).toContain('task outcome are unknown')
  })

  it('keeps unrelated server interpretations and JSON values unchanged', async () => {
    const result = {
      requestId: 'request_1',
      state: 'completed',
      method: 'orchestration.workerStart',
      interpretation: 'server meaning'
    }
    call.mockResolvedValue(result)
    await run(true)
    expect(vi.mocked(printResult).mock.calls[0][0]).toBe(result)
    expect(vi.mocked(printResult).mock.calls[0][1]).toBe(true)
    expect(vi.mocked(printResult).mock.calls[0][2]?.(result)).toContain('server meaning')
  })
})
