import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnCodexAppServerConnection } from '../codex/codex-app-server-connection'
import type { CodexAppServerConnection } from '../codex/app-server/codex-app-server-connection-types'
import { gitExecFileAsync } from '../git/runner'
import { ManagedExecutionLedger } from '../runtime/managed-execution-ledger'
import Database from '../sqlite/sync-database'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { prepareProviderReservationObservation } from './provider-reservation-observer'

describe.skipIf(process.platform === 'win32')('provider reservation launcher integration', () => {
  let directory: string | undefined
  const connections: CodexAppServerConnection[] = []

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()))
    vi.unstubAllEnvs()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  it('observes aliased projects, leaves probes out, and retains slots until child exit', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-provider-reservations-'))
    const repo = join(directory, 'repo')
    const alias = join(directory, 'alias')
    const dbPath = join(directory, 'reservations.sqlite')
    vi.stubEnv('ORCA_MANAGED_EXECUTION_OBSERVATION_DB', dbPath)
    await gitExecFileAsync(['init', repo], { cwd: directory })
    symlinkSync(repo, alias)

    const db = new Database(dbPath, { timeout: 100 })
    try {
      const ledger = new ManagedExecutionLedger(db)
      ledger.setPolicy({ mode: 'enforce', hostLimit: 2, projectLimit: 1 })
      const first = await prepareProviderReservationObservation(repo, 'operation-one')
      const second = await prepareProviderReservationObservation(alias, 'operation-two')
      expect(first?.projectId).toBeTruthy()
      expect(second?.projectId).toBe(first?.projectId)

      const launch = {
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        cwd: repo
      }
      const firstConnection = await spawnCodexAppServerConnection({
        ...launch,
        reservationObservation: first
      })
      connections.push(firstConnection)
      connections.push(
        await spawnCodexAppServerConnection({ ...launch, reservationObservation: second })
      )
      connections.push(await spawnCodexAppServerConnection(launch))
      const rows = () =>
        db.prepare('SELECT execution_id, retired FROM managed_execution_reservations').all()
      expect(rows().map((row) => row.retired)).toEqual([0, 0])
      expect(rows().every((row) => row.execution_id !== null)).toBe(true)
      expect(await firstConnection.close()).toBe(true)
      expect(
        rows()
          .map((row) => row.retired)
          .sort()
      ).toEqual([0, 1])
      expect(await connections[1].close()).toBe(true)
      expect(rows().map((row) => row.retired)).toEqual([1, 1])

      const failed = await prepareProviderReservationObservation(repo, 'operation-abnormal')
      const child = spawnManagedProviderProcess(
        { ...launch, args: ['-e', 'process.exit(9)'], reservationObservation: failed },
        { site: 'provider-reservation-integration' }
      )
      await child.exitPromise
      expect(child.exitStatus?.code).toBe(9)
      expect(rows().filter((row) => row.retired === 0)).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
