import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { gitExecFileAsync } from '../git/runner'
import { ManagedExecutionLedger } from '../runtime/managed-execution-ledger'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import Database from '../sqlite/sync-database'
import type { ProviderProcessLaunch } from './provider-process-launch'

const OBSERVATION_PATH = 'ORCA_MANAGED_EXECUTION_OBSERVATION_DB'

function databasePath(): string | undefined {
  const path = process.env[OBSERVATION_PATH]
  return process.platform !== 'win32' && path && isAbsolute(path) ? path : undefined
}

export async function prepareProviderReservationObservation(
  cwd: string | undefined,
  spawnToken: string
): Promise<ProviderProcessLaunch['reservationObservation']> {
  if (!databasePath()) {
    return undefined
  }
  try {
    if (!cwd || !isAbsolute(cwd)) {
      throw new Error('No host working directory')
    }
    const result = await gitExecFileAsync(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd,
        timeout: 1500
      }
    )
    const common = result.stdout.trimEnd()
    if (!isAbsolute(common)) {
      throw new Error('No absolute common Git directory')
    }
    const projectId = digest(await realpath(common))
    return { spawnToken, projectId }
  } catch {
    console.warn('[managed-execution] project could not be resolved; start not observed')
    return undefined
  }
}

export function beginProviderReservationObservation(
  observation: ProviderProcessLaunch['reservationObservation']
): { spawned(pid: number): void; exited(processless: boolean): void } | undefined {
  const path = databasePath()
  if (!path || !observation) {
    return undefined
  }
  const operationId = digest(observation.spawnToken)
  let reserved = false
  let executionId: string | undefined
  const write = (phase: string, action: (ledger: ManagedExecutionLedger) => void): void => {
    try {
      const directory = lstatSync(dirname(path))
      if (
        !directory.isDirectory() ||
        directory.uid !== process.getuid?.() ||
        directory.mode & 0o077
      ) {
        throw new Error('Observation database must be in a private host-owned directory')
      }
      const db = new Database(path, { timeout: 100, fileMustExist: phase !== 'reservation' })
      try {
        hardenSqliteDatabaseFiles(path)
        action(new ManagedExecutionLedger(db))
      } finally {
        db.close()
      }
    } catch {
      console.warn(`[managed-execution] provider observation failed: ${phase}`)
    }
  }
  write('reservation', (ledger) => {
    const decision = ledger.reserve(operationId, observation.projectId, { observeOnly: true })
    if (decision.outcome === 'reserved') {
      reserved = true
      if (decision.wouldRefuse) {
        console.info(
          `[managed-execution] observed provider start over ${decision.wouldRefuse} limit`
        )
      }
    } else {
      console.warn('[managed-execution] provider observation encountered an existing operation')
    }
  })
  if (!reserved) {
    return undefined
  }
  return {
    spawned(pid) {
      write('bind', (ledger) => {
        const identity = `${pid}:${randomUUID()}`
        if (!ledger.bind(operationId, identity)) {
          throw new Error('Reservation no longer bindable')
        }
        executionId = identity
      })
    },
    exited(processless) {
      if (!executionId && !processless) {
        return
      }
      write('release', (ledger) => {
        if (
          !ledger.release(
            operationId,
            executionId
              ? { kind: 'confirmed-exit', executionId }
              : { kind: 'confirmed-not-started' }
          )
        ) {
          throw new Error('Reservation exit could not be matched')
        }
      })
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
