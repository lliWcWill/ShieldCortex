import { extractFromMemory } from '../graph/extract.js';

describe('graph extractor file entity detection', () => {
  test('promotes repeated file relation endpoints deterministically', () => {
    const result = extractFromMemory(
      'Production rollout',
      [
        'template_with_headset.json deployed to bertta103.',
        'ext_data.json deployed to bertta17.',
        'template_with_headset.json deployed to bertta24.',
      ].join(' '),
      'deployment'
    );

    expect(result.entities).toEqual(
      expect.arrayContaining([
        { name: 'template_with_headset.json', type: 'file' },
        { name: 'ext_data.json', type: 'file' },
        { name: 'bertta103', type: 'service' },
        { name: 'bertta17', type: 'service' },
        { name: 'bertta24', type: 'service' },
      ])
    );

    expect(result.triples).toEqual(
      expect.arrayContaining([
        { subject: 'template_with_headset.json', predicate: 'deployed_to', object: 'bertta103' },
        { subject: 'ext_data.json', predicate: 'deployed_to', object: 'bertta17' },
        { subject: 'template_with_headset.json', predicate: 'deployed_to', object: 'bertta24' },
      ])
    );
  });
});
