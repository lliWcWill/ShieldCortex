import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { closeDatabase, initDatabase } from '../database/init.js';
import { handleGraphQuery } from '../tools/graph.js';

describe('graph tools', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    closeDatabase();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('prefers service entities for bertta hostnames when stale duplicate types exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'shieldcortex-graph-tools-'));
    const db = initDatabase(join(tempDir, 'memories.db'));

    const stalePersonId = Number(
      db.prepare('INSERT INTO entities (name, type, memory_count, aliases) VALUES (?, ?, ?, ?)')
        .run('bertta103', 'person', 14, JSON.stringify(['bertta18']))
        .lastInsertRowid
    );
    const serviceId = Number(
      db.prepare('INSERT INTO entities (name, type, memory_count, aliases) VALUES (?, ?, ?, ?)')
        .run('bertta103', 'service', 8, JSON.stringify([]))
        .lastInsertRowid
    );
    const targetId = Number(
      db.prepare('INSERT INTO entities (name, type, memory_count, aliases) VALUES (?, ?, ?, ?)')
        .run('jacob', 'person', 1, JSON.stringify([]))
        .lastInsertRowid
    );
    const memoryId = Number(
      db.prepare(
        'INSERT INTO memories (type, category, title, content, project, tags) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('short_term', 'architecture', 'graph tool stale duplicate', 'fixture', 'test-project', '[]').lastInsertRowid
    );

    db.prepare('INSERT INTO triples (subject_id, predicate, object_id, source_memory_id) VALUES (?, ?, ?, ?)')
      .run(serviceId, 'waiting_on', targetId, memoryId);

    const response = handleGraphQuery({ entity: 'bertta103', depth: 1 });
    const payload = JSON.parse(response.content[0].text) as {
      entity: { id: number; name: string; type: string };
      connections: Array<{ predicate: string; entity: { name: string } }>;
    };

    expect(payload.entity).toEqual(
      expect.objectContaining({
        id: serviceId,
        name: 'bertta103',
        type: 'service',
      })
    );
    expect(payload.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: 'waiting_on',
          entity: expect.objectContaining({ name: 'jacob' }),
        }),
      ])
    );
    expect(payload.entity.id).not.toBe(stalePersonId);
  });
});
