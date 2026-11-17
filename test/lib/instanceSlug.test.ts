import { expect } from 'chai';

import { instanceSlug, numberedSlug } from '../../src/lib/instanceProviders';

describe('instanceSlug', () => {
  for (const [value, slug] of [
    ['janedoe', 'janedoe'],
    ['Jane.Doe', 'janedoe'],
    ['jane.doe_stg', 'janedoestg'],
    ['jane@acme.com', 'janeacmecom'],
    ['Foo.Bar-1', 'foobar-1'],
    ['-jane-', 'jane'],
    ['jane_-', 'jane'],
    ['a'.repeat(40), 'a'.repeat(30)],
    [`${'a'.repeat(29)}-b`, 'a'.repeat(29)],
    ['___', ''],
    ['é', ''],
  ])
    it(`turns ${JSON.stringify(value)} into ${JSON.stringify(slug)}`, () => {
      expect(instanceSlug(value)).to.equal(slug);
    });

  it('reduces a long run of dashes in linear time', () => {
    const value = `a${'-'.repeat(200_000)}b`;
    const start = process.hrtime.bigint();
    expect(instanceSlug(value)).to.equal('a');
    expect(instanceSlug(value, false)).to.equal('ab');
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsed).to.be.below(50);
  });
});

describe('instanceSlug without dashes', () => {
  for (const [value, slug] of [
    ['jean-claude.dusse', 'jeanclaudedusse'],
    ['Foo.Bar-1', 'foobar1'],
    ['-jane-', 'jane'],
    ['a-'.repeat(20), 'a'.repeat(20)],
  ])
    it(`turns ${JSON.stringify(value)} into ${JSON.stringify(slug)}`, () => {
      expect(instanceSlug(value, false)).to.equal(slug);
    });
});

describe('numberedSlug', () => {
  for (const [slug, n, numbered] of [
    ['jeanclaude', 2, 'jeanclaude2'],
    ['jeanclaude', 12, 'jeanclaude12'],
    ['a'.repeat(30), 2, `${'a'.repeat(29)}2`],
    ['a'.repeat(30), 99, `${'a'.repeat(28)}99`],
  ] as [string, number, string][])
    it(`numbers ${slug} ${n} as ${numbered}`, () => {
      expect(numberedSlug(slug, n)).to.equal(numbered);
    });
});
