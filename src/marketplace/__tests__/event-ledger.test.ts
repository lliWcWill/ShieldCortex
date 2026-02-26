/**
 * Event Ledger Tests
 *
 * Tests hash chain integrity, canonical JSON, epoch rotation,
 * and query functionality.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createHash } from 'crypto';
import { initDatabase, closeDatabase, getDatabase } from '../../database/init.js';

// Dynamic imports so the module picks up the in-memory DB
let appendEvent: typeof import('../ledger/event-ledger.js').appendEvent;
let verifyChain: typeof import('../ledger/event-ledger.js').verifyChain;
let rotateChainEpoch: typeof import('../ledger/event-ledger.js').rotateChainEpoch;
let getCurrentEpoch: typeof import('../ledger/event-ledger.js').getCurrentEpoch;
let queryEvents: typeof import('../ledger/event-ledger.js').queryEvents;

beforeAll(async () => {
  initDatabase(':memory:');
  const mod = await import('../ledger/event-ledger.js');
  appendEvent = mod.appendEvent;
  verifyChain = mod.verifyChain;
  rotateChainEpoch = mod.rotateChainEpoch;
  getCurrentEpoch = mod.getCurrentEpoch;
  queryEvents = mod.queryEvents;
});

afterAll(() => {
  closeDatabase();
});

/** Helper: recompute expected hash */
function expectedHash(prevHash: string, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(prevHash + canonicalJson(payload), 'utf-8')
    .digest('hex');
}

/** Mirror of the production canonicalJson for test assertions */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const parts = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

const GENESIS_HASH = '0'.repeat(64);

describe('Event Ledger', () => {
  describe('canonicalJson correctness', () => {
    it('sorts top-level keys', () => {
      expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
    });

    it('sorts nested keys recursively', () => {
      const obj = { b: { z: 1, a: 2 }, a: 'first' };
      expect(canonicalJson(obj)).toBe('{"a":"first","b":{"a":2,"z":1}}');
    });

    it('handles arrays (preserves order)', () => {
      expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    });

    it('handles nested arrays with objects', () => {
      const obj = { items: [{ z: 1, a: 2 }] };
      expect(canonicalJson(obj)).toBe('{"items":[{"a":2,"z":1}]}');
    });

    it('handles null and undefined', () => {
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson(undefined)).toBe('null');
    });

    it('handles deeply nested objects', () => {
      const obj = { c: { b: { a: 1 } } };
      expect(canonicalJson(obj)).toBe('{"c":{"b":{"a":1}}}');
    });
  });

  describe('appendEvent + hash chain integrity', () => {
    it('appends first event with genesis prev_hash', () => {
      const event = appendEvent({
        eventType: 'test:first',
        source: 'unit-test',
        payload: { action: 'create', target: 'alpha' },
      });

      expect(event.id).toBeGreaterThan(0);
      expect(event.sequenceNum).toBe(1);
      expect(event.prevHash).toBe(GENESIS_HASH);
      expect(event.eventHash).toBe(
        expectedHash(GENESIS_HASH, { action: 'create', target: 'alpha' }),
      );
    });

    it('chains three events correctly', () => {
      // Events from previous test are already in chain.
      // Append two more and verify the full chain.
      const e2 = appendEvent({
        eventType: 'test:second',
        source: 'unit-test',
        payload: { step: 2 },
      });

      const e3 = appendEvent({
        eventType: 'test:third',
        source: 'unit-test',
        payload: { step: 3 },
      });

      // e2's prevHash should be e1's eventHash
      expect(e2.sequenceNum).toBe(2);
      expect(e3.prevHash).toBe(e2.eventHash);
      expect(e3.sequenceNum).toBe(3);

      // Verify the full chain
      const broken = verifyChain();
      expect(broken).toBeNull();
    });

    it('detects a tampered event', () => {
      // Tamper with an event in the DB directly
      const db = getDatabase();
      const row = db
        .prepare("SELECT id FROM event_log WHERE event_type = 'test:second' LIMIT 1")
        .get() as { id: number };

      db.prepare("UPDATE event_log SET payload = '{\"step\":999}' WHERE id = ?").run(row.id);

      const broken = verifyChain();
      expect(broken).not.toBeNull();
      expect(broken!.brokenAt).toBe(row.id);

      // Restore the tampered row so subsequent tests aren't affected
      db.prepare(
        `UPDATE event_log SET payload = '${canonicalJson({ step: 2 })}' WHERE id = ?`,
      ).run(row.id);
    });
  });

  describe('epoch rotation', () => {
    it('rotates to a new epoch', () => {
      rotateChainEpoch('epoch-2');
      expect(getCurrentEpoch()).toBe('epoch-2');
    });

    it('new events use the rotated epoch', () => {
      const event = appendEvent({
        eventType: 'test:new-epoch',
        source: 'unit-test',
        payload: { epoch: 'two' },
      });
      expect(event.chainEpoch).toBe('epoch-2');
      expect(event.sequenceNum).toBe(1); // resets in new epoch
      expect(event.prevHash).toBe(GENESIS_HASH); // new chain starts fresh
    });

    it('verifies the new epoch chain independently', () => {
      expect(verifyChain('epoch-2')).toBeNull();
    });
  });

  describe('queryEvents', () => {
    it('queries by event type', () => {
      const results = queryEvents('test:first');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every(e => e.eventType === 'test:first')).toBe(true);
    });

    it('queries by epoch', () => {
      const results = queryEvents(undefined, { epoch: 'epoch-2' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every(e => e.chainEpoch === 'epoch-2')).toBe(true);
    });

    it('respects limit', () => {
      const results = queryEvents(undefined, { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it('returns StoredEvent objects with all fields', () => {
      const results = queryEvents('test:first');
      const event = results[0];
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('timestamp');
      expect(event).toHaveProperty('eventType');
      expect(event).toHaveProperty('source');
      expect(event).toHaveProperty('payload');
      expect(event).toHaveProperty('chainEpoch');
      expect(event).toHaveProperty('sequenceNum');
      expect(event).toHaveProperty('prevHash');
      expect(event).toHaveProperty('eventHash');
    });
  });
});
