/**
 * Hash-Chained Event Ledger — tamper-evident, single-writer event log.
 *
 * Each event's hash = SHA-256(prev_hash + canonical_json(payload)).
 * Chain epochs allow rotation without invalidating the full chain.
 *
 * CRITICAL: All inserts MUST go through appendEvent() to maintain chain integrity.
 * Uses withImmediateTransaction() for the insert to prevent concurrent writers.
 */

import { createHash } from 'crypto';
import { getDatabase, withImmediateTransaction } from '../../database/init.js';

/** Deterministic JSON serialization — recursively sorted keys, no whitespace */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const parts = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Compute chain hash: SHA-256(prevHash + canonicalPayload) */
function computeEventHash(prevHash: string, payload: string): string {
  return createHash('sha256')
    .update(prevHash + payload, 'utf-8')
    .digest('hex');
}

export interface EventLogEntry {
  eventType: string;
  source: string;
  payload: Record<string, unknown>;
  chatId?: number;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  traceId?: string;
  parentSpanId?: string;
  spanId?: string;
  policyDecisionId?: string;
  riskScore?: number;
  actorType?: string;
  actorId?: string;
  inputsHash?: string;
  outputsHash?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface StoredEvent extends EventLogEntry {
  id: number;
  timestamp: string;
  chainEpoch: string;
  sequenceNum: number;
  prevHash: string;
  eventHash: string;
}

/** Genesis hash — 64 zeros */
const GENESIS_HASH = '0'.repeat(64);

/** Default chain epoch — rotated via rotateChainEpoch() */
let currentEpoch = 'genesis';
let epochLoadedFromDb = false;

/**
 * Load the current epoch from the DB so we resume the correct chain
 * after a process restart instead of resetting to 'genesis'.
 */
function loadCurrentEpoch(): string {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT chain_epoch FROM event_log ORDER BY id DESC LIMIT 1').get() as { chain_epoch: string } | undefined;
    return row?.chain_epoch ?? 'genesis';
  } catch {
    return 'genesis';
  }
}

/**
 * Get the current chain head (last event's hash and sequence number).
 * Returns genesis values if the chain is empty.
 */
function getChainHead(epoch: string): { prevHash: string; sequenceNum: number } {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT event_hash, sequence_num FROM event_log
       WHERE chain_epoch = ? ORDER BY sequence_num DESC LIMIT 1`,
    )
    .get(epoch) as { event_hash: string; sequence_num: number } | undefined;

  if (!row) {
    return { prevHash: GENESIS_HASH, sequenceNum: 0 };
  }
  return { prevHash: row.event_hash, sequenceNum: row.sequence_num };
}

/**
 * Append an event to the hash-chained ledger.
 * Uses IMMEDIATE transaction to ensure single-writer serialization.
 */
export function appendEvent(entry: EventLogEntry): StoredEvent {
  // Lazily load the epoch from DB on first call after process restart
  if (!epochLoadedFromDb) {
    currentEpoch = loadCurrentEpoch();
    epochLoadedFromDb = true;
  }

  return withImmediateTransaction(() => {
    const db = getDatabase();
    const timestamp = new Date().toISOString();
    const canonicalPayload = canonicalJson(entry.payload);

    // Get chain head
    const head = getChainHead(currentEpoch);
    const sequenceNum = head.sequenceNum + 1;
    const eventHash = computeEventHash(head.prevHash, canonicalPayload);

    const stmt = db.prepare(`
      INSERT INTO event_log (
        timestamp, event_type, source, payload,
        chat_id, session_id, task_id, run_id,
        trace_id, parent_span_id, span_id,
        policy_decision_id, risk_score,
        actor_type, actor_id,
        inputs_hash, outputs_hash,
        duration_ms, tokens_in, tokens_out, cost_usd,
        chain_epoch, sequence_num, prev_hash, event_hash
      ) VALUES (
        @timestamp, @event_type, @source, @payload,
        @chat_id, @session_id, @task_id, @run_id,
        @trace_id, @parent_span_id, @span_id,
        @policy_decision_id, @risk_score,
        @actor_type, @actor_id,
        @inputs_hash, @outputs_hash,
        @duration_ms, @tokens_in, @tokens_out, @cost_usd,
        @chain_epoch, @sequence_num, @prev_hash, @event_hash
      )
    `);

    const result = stmt.run({
      timestamp,
      event_type: entry.eventType,
      source: entry.source,
      payload: canonicalPayload,
      chat_id: entry.chatId ?? null,
      session_id: entry.sessionId ?? null,
      task_id: entry.taskId ?? null,
      run_id: entry.runId ?? null,
      trace_id: entry.traceId ?? null,
      parent_span_id: entry.parentSpanId ?? null,
      span_id: entry.spanId ?? null,
      policy_decision_id: entry.policyDecisionId ?? null,
      risk_score: entry.riskScore ?? null,
      actor_type: entry.actorType ?? null,
      actor_id: entry.actorId ?? null,
      inputs_hash: entry.inputsHash ?? null,
      outputs_hash: entry.outputsHash ?? null,
      duration_ms: entry.durationMs ?? null,
      tokens_in: entry.tokensIn ?? null,
      tokens_out: entry.tokensOut ?? null,
      cost_usd: entry.costUsd ?? null,
      chain_epoch: currentEpoch,
      sequence_num: sequenceNum,
      prev_hash: head.prevHash,
      event_hash: eventHash,
    });

    return {
      id: Number(result.lastInsertRowid),
      timestamp,
      ...entry,
      chainEpoch: currentEpoch,
      sequenceNum,
      prevHash: head.prevHash,
      eventHash,
    };
  });
}

/**
 * Verify chain integrity for a given epoch.
 * Returns the first broken link, or null if the chain is valid.
 */
export function verifyChain(
  epoch?: string,
): { brokenAt: number; expected: string; actual: string } | null {
  const db = getDatabase();
  const targetEpoch = epoch ?? currentEpoch;

  const events = db
    .prepare(
      `SELECT id, payload, prev_hash, event_hash, sequence_num
       FROM event_log WHERE chain_epoch = ?
       ORDER BY sequence_num ASC`,
    )
    .all(targetEpoch) as {
    id: number;
    payload: string;
    prev_hash: string;
    event_hash: string;
    sequence_num: number;
  }[];

  let expectedPrevHash = GENESIS_HASH;

  for (const event of events) {
    // Verify prev_hash links to previous event's hash
    if (event.prev_hash !== expectedPrevHash) {
      return {
        brokenAt: event.id,
        expected: expectedPrevHash,
        actual: event.prev_hash,
      };
    }

    // Verify event_hash is correct
    const recomputed = computeEventHash(event.prev_hash, event.payload);
    if (event.event_hash !== recomputed) {
      return {
        brokenAt: event.id,
        expected: recomputed,
        actual: event.event_hash,
      };
    }

    expectedPrevHash = event.event_hash;
  }

  return null;
}

/**
 * Rotate to a new chain epoch. The previous epoch is sealed.
 */
export function rotateChainEpoch(newEpoch: string): void {
  currentEpoch = newEpoch;
  epochLoadedFromDb = true;
}

/**
 * Get the current chain epoch.
 */
export function getCurrentEpoch(): string {
  return currentEpoch;
}

/**
 * Query events by type, with optional epoch and limit.
 */
export function queryEvents(
  eventType?: string,
  options?: { epoch?: string; limit?: number; offset?: number },
): StoredEvent[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (eventType) {
    conditions.push('event_type = @event_type');
    params.event_type = eventType;
  }

  if (options?.epoch) {
    conditions.push('chain_epoch = @epoch');
    params.epoch = options.epoch;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  const rows = db
    .prepare(
      `SELECT * FROM event_log ${where}
       ORDER BY id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as Record<string, unknown>[];

  return rows.map(mapRowToStoredEvent);
}

function mapRowToStoredEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    eventType: row.event_type as string,
    source: row.source as string,
    payload: JSON.parse(row.payload as string) as Record<string, unknown>,
    chatId: (row.chat_id as number | null) ?? undefined,
    sessionId: (row.session_id as string | null) ?? undefined,
    taskId: (row.task_id as string | null) ?? undefined,
    runId: (row.run_id as string | null) ?? undefined,
    traceId: (row.trace_id as string | null) ?? undefined,
    parentSpanId: (row.parent_span_id as string | null) ?? undefined,
    spanId: (row.span_id as string | null) ?? undefined,
    policyDecisionId: (row.policy_decision_id as string | null) ?? undefined,
    riskScore: (row.risk_score as number | null) ?? undefined,
    actorType: (row.actor_type as string | null) ?? undefined,
    actorId: (row.actor_id as string | null) ?? undefined,
    inputsHash: (row.inputs_hash as string | null) ?? undefined,
    outputsHash: (row.outputs_hash as string | null) ?? undefined,
    durationMs: (row.duration_ms as number | null) ?? undefined,
    tokensIn: (row.tokens_in as number | null) ?? undefined,
    tokensOut: (row.tokens_out as number | null) ?? undefined,
    costUsd: (row.cost_usd as number | null) ?? undefined,
    chainEpoch: row.chain_epoch as string,
    sequenceNum: row.sequence_num as number,
    prevHash: row.prev_hash as string,
    eventHash: row.event_hash as string,
  };
}
