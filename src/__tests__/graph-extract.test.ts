import { describe, expect, it } from '@jest/globals';

import { extractFromMemory } from '../graph/extract.js';

describe('graph extractor', () => {
  it('extracts direct uses relationships from normal prose', () => {
    const result = extractFromMemory(
      'bertta103 uses TrendScope',
      'bertta103 uses TrendScope and FutureDial.',
      'architecture'
    );

    expect(result.triples).toContainEqual({
      subject: 'bertta103',
      predicate: 'uses',
      object: 'TrendScope',
    });
  });

  it('keeps multi-word dependency names intact', () => {
    const result = extractFromMemory(
      'USB-C headset rollout blocked',
      'bertta103 depends on Smart Receive API.',
      'architecture'
    );

    expect(result.triples).toContainEqual({
      subject: 'bertta103',
      predicate: 'depends_on',
      object: 'Smart Receive API',
    });
  });

  it('extracts rollout-style blocked by relationships', () => {
    const result = extractFromMemory(
      'USB-C headset rollout on bertta103 blocked by Smart Receive API',
      'template_with_headset.json deployed to bertta103, but rollout blocked by Smart Receive API.',
      'architecture'
    );

    expect(result.triples).toContainEqual({
      subject: 'USB-C headset rollout',
      predicate: 'blocked_by',
      object: 'Smart Receive API',
    });
  });

  it('extracts deployed to relationships for files and machines', () => {
    const result = extractFromMemory(
      'Production deployment note',
      'template_with_headset.json deployed to bertta103.',
      'architecture'
    );

    expect(result.triples).toContainEqual({
      subject: 'template_with_headset.json',
      predicate: 'deployed_to',
      object: 'bertta103',
    });
  });

  it('extracts waiting on relationships from rollout notes', () => {
    const result = extractFromMemory(
      'USB-C headset ext_data context',
      'Matt is waiting on Smart Receive API readiness before renaming template_with_headset.json.',
      'architecture'
    );

    expect(result.triples).toContainEqual({
      subject: 'Matt',
      predicate: 'waiting_on',
      object: 'Smart Receive API readiness',
    });
  });

  it('strips filler prefixes from sloppy waiting-on notes', () => {
    const result = extractFromMemory(
      'sloppy rollout note',
      'i think Walter says bertta103 is waiting on Jacob for Smart Receive API before renaming template_with_headset.json to template.json.',
      'architecture'
    );

    expect(result.triples).toContainEqual({
      subject: 'bertta103',
      predicate: 'waiting_on',
      object: 'Jacob',
    });
    expect(result.triples).not.toContainEqual({
      subject: 'Walter says bertta103',
      predicate: 'waiting_on',
      object: 'Jacob for Smart Receive API before',
    });
  });

  it('strips maybe and not sure prefixes from sloppy waiting-on notes', () => {
    const result = extractFromMemory(
      'sloppy rollout note',
      'maybe not sure Dana says bertta17 is waiting on Taylor for rollout cleanup.',
      'architecture'
    );

    expect(result.triples).toContainEqual({
      subject: 'bertta17',
      predicate: 'waiting_on',
      object: 'Taylor',
    });
  });

  it('extracts every deployed-to target from a comma-separated rollout', () => {
    const result = extractFromMemory(
      'rollout batch',
      'template_with_headset.json deployed to bertta103, bertta17, bertta24.',
      'architecture'
    );

    expect(result.triples).toEqual(
      expect.arrayContaining([
        { subject: 'template_with_headset.json', predicate: 'deployed_to', object: 'bertta103' },
        { subject: 'template_with_headset.json', predicate: 'deployed_to', object: 'bertta17' },
        { subject: 'template_with_headset.json', predicate: 'deployed_to', object: 'bertta24' },
      ])
    );
  });

  it('keeps Smart Receive API canonical in sloppy notes', () => {
    const result = extractFromMemory(
      'entity smoke',
      'Walter says bertta103 waiting on Smart Receive API and Jacob. Smart Receive API blocked headset rename.',
      'architecture'
    );

    expect(result.entities).toEqual(
      expect.arrayContaining([
        { name: 'Smart Receive API', type: 'service' },
        { name: 'Jacob', type: 'person' },
        { name: 'bertta103', type: 'service' },
      ])
    );
    expect(result.entities).not.toEqual(
      expect.arrayContaining([
        { name: 'Receive', type: 'tool' },
        { name: 'Smart Receive API and Jacob', type: 'service' },
      ])
    );
  });

  it('splits waiting-on targets joined with and into separate triples', () => {
    const result = extractFromMemory(
      'waiting note',
      'bertta103 is waiting on Smart Receive API and Jacob before headset rename.',
      'architecture'
    );

    expect(result.triples).toEqual(
      expect.arrayContaining([
        { subject: 'bertta103', predicate: 'waiting_on', object: 'Smart Receive API' },
        { subject: 'bertta103', predicate: 'waiting_on', object: 'Jacob' },
      ])
    );
  });

  it('canonicalizes SR API aliases to Smart Receive API', () => {
    const result = extractFromMemory(
      'alias note',
      'bertta103 waiting on SR API before rename.',
      'architecture'
    );

    expect(result.entities).toEqual(
      expect.arrayContaining([
        { name: 'Smart Receive API', type: 'service' },
      ])
    );
    expect(result.entities).not.toContainEqual({ name: 'SR', type: 'tool' });
    expect(result.entities).not.toContainEqual({ name: 'SR API', type: 'service' });
    expect(result.triples).toContainEqual({
      subject: 'bertta103',
      predicate: 'waiting_on',
      object: 'Smart Receive API',
    });
  });

  it('canonicalizes Smart Receive dependency aliases to Smart Receive API', () => {
    const result = extractFromMemory(
      'dependency alias note',
      'bertta103 depends on Smart Receive.',
      'architecture'
    );

    expect(result.entities).toEqual(
      expect.arrayContaining([
        { name: 'Smart Receive API', type: 'service' },
      ])
    );
    expect(result.triples).toContainEqual({
      subject: 'bertta103',
      predicate: 'depends_on',
      object: 'Smart Receive API',
    });
  });
});
