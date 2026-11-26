import type Database from '../sqlite/sync-database'

export type ManagedExecutionPolicy = {
  mode: 'observe' | 'enforce'
  hostLimit: number
  projectLimit: number
}

type Capacity = 'host' | 'project'

export type ManagedExecutionAdmission =
  | { outcome: 'reserved'; wouldRefuse: Capacity | null }
  | { outcome: 'refused'; capacity: Capacity }
  | { outcome: 'existing' | 'retired' }

export type ManagedExecutionRelease =
  | { kind: 'confirmed-not-started' }
  | { kind: 'confirmed-exit'; executionId: string }

export class ManagedExecutionLedger {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS managed_execution_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('observe', 'enforce')),
        host_limit INTEGER NOT NULL CHECK (host_limit > 0),
        project_limit INTEGER NOT NULL CHECK (project_limit BETWEEN 1 AND host_limit)
      ) STRICT;
      INSERT OR IGNORE INTO managed_execution_policy VALUES (1, 'observe', 6, 2);
      CREATE TABLE IF NOT EXISTS managed_execution_reservations (
        operation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        execution_id TEXT UNIQUE,
        retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS managed_execution_active_project
        ON managed_execution_reservations (project_id) WHERE retired = 0;
    `)
  }

  setPolicy(policy: ManagedExecutionPolicy): void {
    if (!Number.isSafeInteger(policy.hostLimit) || !Number.isSafeInteger(policy.projectLimit)) {
      throw new Error('Managed execution limits must be safe integers')
    }
    this.db
      .prepare(
        'UPDATE managed_execution_policy SET mode = ?, host_limit = ?, project_limit = ? WHERE id = 1'
      )
      .run(policy.mode, policy.hostLimit, policy.projectLimit)
  }

  reserve(
    operationId: string,
    canonicalProjectId: string,
    options: { observeOnly?: boolean } = {}
  ): ManagedExecutionAdmission {
    requireIdentity(operationId)
    requireIdentity(canonicalProjectId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const decision = this.reserveInTransaction(
        operationId,
        canonicalProjectId,
        options.observeOnly === true
      )
      this.db.exec('COMMIT')
      return decision
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }
      throw error
    }
  }

  // Execution identity must already include the provider's host-side incarnation evidence.
  bind(operationId: string, executionId: string): boolean {
    requireIdentity(executionId)
    const result = this.db
      .prepare(
        `UPDATE managed_execution_reservations SET execution_id = ?
         WHERE operation_id = ? AND retired = 0 AND (execution_id IS NULL OR execution_id = ?)`
      )
      .run(executionId, operationId, executionId)
    return Number(result.changes) === 1
  }

  // Caller supplies positive evidence; disconnect, elapsed time and unknown results are not evidence.
  release(operationId: string, proof: ManagedExecutionRelease): boolean {
    const executionId = proof.kind === 'confirmed-exit' ? proof.executionId : null
    if (executionId !== null) {
      requireIdentity(executionId)
    }
    const result = this.db
      .prepare(
        `UPDATE managed_execution_reservations SET retired = 1
         WHERE operation_id = ? AND retired = 0 AND execution_id IS ?`
      )
      .run(operationId, executionId)
    return Number(result.changes) === 1
  }

  private reserveInTransaction(
    operationId: string,
    canonicalProjectId: string,
    observeOnly: boolean
  ): ManagedExecutionAdmission {
    const existing = this.db
      .prepare(
        'SELECT project_id, retired FROM managed_execution_reservations WHERE operation_id = ?'
      )
      .get(operationId)
    if (existing) {
      if (existing.project_id !== canonicalProjectId) {
        throw new Error('Managed execution operation identity conflicts with its canonical project')
      }
      return { outcome: Number(existing.retired) === 1 ? 'retired' : 'existing' }
    }
    const policy = this.db
      .prepare('SELECT mode, host_limit, project_limit FROM managed_execution_policy WHERE id = 1')
      .get()
    if (!policy) {
      throw new Error('Managed execution admission policy is unavailable')
    }
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS host_count, COUNT(CASE WHEN project_id = ? THEN 1 END) AS project_count
         FROM managed_execution_reservations WHERE retired = 0`
      )
      .get(canonicalProjectId)
    const capacity =
      Number(counts?.host_count) >= Number(policy.host_limit)
        ? 'host'
        : Number(counts?.project_count) >= Number(policy.project_limit)
          ? 'project'
          : null
    if (capacity && policy.mode === 'enforce' && !observeOnly) {
      return { outcome: 'refused', capacity }
    }
    this.db
      .prepare(
        'INSERT INTO managed_execution_reservations (operation_id, project_id) VALUES (?, ?)'
      )
      .run(operationId, canonicalProjectId)
    return { outcome: 'reserved', wouldRefuse: capacity }
  }
}

function requireIdentity(value: string): void {
  if (!value.trim()) {
    throw new Error('Managed execution identity is unavailable')
  }
}
