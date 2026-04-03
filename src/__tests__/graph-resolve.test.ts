import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { extractFromMemory } from '../graph/extract.js';
import { closeDatabase, initDatabase } from '../database/init.js';
import { processExtractionResult } from '../graph/resolve.js';

describe('graph resolve integration', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    closeDatabase();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = undefined;
  });

  it('persists lowercase waiting-on people through resolve', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'shieldcortex-home-'));
    const dbPath = join(tempDir, 'memories.db');
    const db = initDatabase(dbPath);
    const memoryId = db
      .prepare(
        'INSERT INTO memories (type, category, title, content, project, tags) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        'short_term',
        'architecture',
        'Lowercase person regression',
        'bertta103 waiting on jacob before rename.',
        'test-project',
        '[]'
      ).lastInsertRowid as number;

    const extraction = extractFromMemory(
      'Lowercase person regression',
      'bertta103 waiting on jacob before rename.',
      'architecture'
    );

    processExtractionResult(extraction, Number(memoryId));

    const triple = db
      .prepare(
        `
          SELECT s.name AS subject, t.predicate, o.name AS object
          FROM triples t
          JOIN entities s ON s.id = t.subject_id
          JOIN entities o ON o.id = t.object_id
          WHERE t.source_memory_id = ?
        `
      )
      .get(memoryId) as { subject: string; predicate: string; object: string } | undefined;

    expect(triple).toEqual({
      subject: 'bertta103',
      predicate: 'waiting_on',
      object: 'jacob',
    });

    const person = db
      .prepare('SELECT name, type FROM entities WHERE name = ?')
      .get('jacob') as { name: string; type: string } | undefined;

    expect(person).toEqual({ name: 'jacob', type: 'person' });
  });

  it('persists split SR waiting-on targets through resolve', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'shieldcortex-home-'));
    const dbPath = join(tempDir, 'memories.db');
    const db = initDatabase(dbPath);
    const memoryId = db
      .prepare(
        'INSERT INTO memories (type, category, title, content, project, tags) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        'short_term',
        'architecture',
        'SR alias regression',
        'bertta103 waiting on smart receive api and jacob before rename.',
        'test-project',
        '[]'
      ).lastInsertRowid as number;

    const extraction = extractFromMemory(
      'SR alias regression',
      'bertta103 waiting on smart receive api and jacob before rename.',
      'architecture'
    );

    processExtractionResult(extraction, Number(memoryId));

    const triples = db
      .prepare(
        `
          SELECT s.name AS subject, t.predicate, o.name AS object
          FROM triples t
          JOIN entities s ON s.id = t.subject_id
          JOIN entities o ON o.id = t.object_id
          WHERE t.source_memory_id = ?
          ORDER BY o.name
        `
      )
      .all(memoryId) as Array<{ subject: string; predicate: string; object: string }>;

    expect(triples).toEqual([
      { subject: 'bertta103', predicate: 'waiting_on', object: 'Smart Receive API' },
      { subject: 'bertta103', predicate: 'waiting_on', object: 'jacob' },
    ]);

    const jacob = db
      .prepare('SELECT name, type FROM entities WHERE name = ?')
      .get('jacob') as { name: string; type: string } | undefined;

    expect(jacob).toEqual({ name: 'jacob', type: 'person' });
  });
});
