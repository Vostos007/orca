import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { ManagedExecutionLedger } from './managed-execution-ledger'

describe('managed execution ledger', () => {
  let directory: string
  let connections: Database.Database[]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-execution-ledger-'))
    connections = []
  })

  afterEach(() => {
    for (const connection of connections.toReversed()) {
      connection.close()
    }
    rmSync(directory, { recursive: true, force: true })
  })

  function open(): ManagedExecutionLedger {
    const connection = new Database(join(directory, 'admission.sqlite'))
    connections.push(connection)
    return new ManagedExecutionLedger(connection)
  }

  it('enforces both limits across connections and never admits a replay as a new start', () => {
    const a = open()
    const b = open()
    a.setPolicy({ mode: 'enforce', hostLimit: 6, projectLimit: 2 })
    expect(a.reserve('a1', 'project-a').outcome).toBe('reserved')
    expect(b.reserve('a2', 'project-a').outcome).toBe('reserved')
    expect(a.reserve('a3', 'project-a')).toEqual({ outcome: 'refused', capacity: 'project' })
    expect(a.reserve('b1', 'project-b').outcome).toBe('reserved')
    expect(b.reserve('b2', 'project-b').outcome).toBe('reserved')
    expect(a.reserve('c1', 'project-c').outcome).toBe('reserved')
    expect(b.reserve('c2', 'project-c').outcome).toBe('reserved')
    expect(a.reserve('d1', 'project-d')).toEqual({ outcome: 'refused', capacity: 'host' })
    expect(b.reserve('a1', 'project-a')).toEqual({ outcome: 'existing' })
    expect(() => b.reserve('a1', 'project-b')).toThrow(/conflicts/)
    expect(() => b.reserve('new', ' ')).toThrow(/unavailable/)
  })

  it('keeps uncertain reservations across reopen and releases only on matching evidence', () => {
    const a = open()
    a.setPolicy({ mode: 'enforce', hostLimit: 2, projectLimit: 1 })
    expect(a.reserve('uncertain', 'project-a').outcome).toBe('reserved')
    expect(a.reserve('failed-before-spawn', 'project-b').outcome).toBe('reserved')
    connections.pop()?.close()
    const b = open()
    expect(b.reserve('other', 'project-a')).toEqual({ outcome: 'refused', capacity: 'host' })
    expect(b.release('uncertain', { kind: 'confirmed-exit', executionId: 'boot:pid:start' })).toBe(
      false
    )
    expect(b.release('failed-before-spawn', { kind: 'confirmed-not-started' })).toBe(true)
    expect(b.reserve('failed-before-spawn', 'project-b').outcome).toBe('retired')
    expect(b.reserve('other', 'project-a')).toEqual({ outcome: 'refused', capacity: 'project' })
    expect(b.bind('uncertain', 'boot:pid:start')).toBe(true)
    expect(b.bind('uncertain', 'boot:pid:reused')).toBe(false)
    expect(b.release('uncertain', { kind: 'confirmed-not-started' })).toBe(false)
    expect(b.release('uncertain', { kind: 'confirmed-exit', executionId: 'boot:pid:reused' })).toBe(
      false
    )
    expect(b.release('uncertain', { kind: 'confirmed-exit', executionId: 'boot:pid:start' })).toBe(
      true
    )
    expect(b.reserve('other', 'project-a').outcome).toBe('reserved')
  })

  it('records observe-only admissions and reads policy changes without reopening', () => {
    const a = open()
    const b = open()
    expect(a.reserve('one', 'project').outcome).toBe('reserved')
    expect(b.reserve('two', 'project').outcome).toBe('reserved')
    expect(a.reserve('three', 'project')).toEqual({ outcome: 'reserved', wouldRefuse: 'project' })
    b.setPolicy({ mode: 'enforce', hostLimit: 6, projectLimit: 2 })
    expect(a.reserve('four', 'project')).toEqual({ outcome: 'refused', capacity: 'project' })
    b.setPolicy({ mode: 'observe', hostLimit: 6, projectLimit: 2 })
    expect(a.reserve('four', 'project')).toEqual({ outcome: 'reserved', wouldRefuse: 'project' })
  })
})
