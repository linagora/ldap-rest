import { expect } from 'chai';

import {
  CLOUDERY_SLUG_MAX_LENGTH,
  COZY_SLUG_MAX_LENGTH,
  instanceSlug,
  numberedSlug,
} from '../../src/lib/instanceProviders';

const cloudery = { maxLength: CLOUDERY_SLUG_MAX_LENGTH };

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
    [`-${'a'.repeat(30)}`, 'a'.repeat(30)],
    ['___', ''],
    ['é', ''],
  ])
    it(`turns ${JSON.stringify(value)} into ${JSON.stringify(slug)}`, () => {
      expect(instanceSlug(value, cloudery)).to.equal(slug);
    });

  it('cuts a slug to the provider’s length', () => {
    const value = `${'a'.repeat(40)}-${'b'.repeat(40)}`;
    expect(instanceSlug(value, { maxLength: COZY_SLUG_MAX_LENGTH })).to.equal(
      `${'a'.repeat(40)}-${'b'.repeat(22)}`
    );
    expect(instanceSlug(value, { maxLength: 41 })).to.equal('a'.repeat(40));
  });

  it('trims a long run of dashes in linear time', () => {
    const value = `a${'-'.repeat(200_000)}b`;
    const uncut = { maxLength: Infinity };
    const start = process.hrtime.bigint();
    expect(instanceSlug(value, uncut)).to.equal(value);
    expect(instanceSlug(value, cloudery)).to.equal('a');
    expect(instanceSlug(value, { ...uncut, dashes: false })).to.equal('ab');
    expect(instanceSlug(`a${'-'.repeat(200_000)}`, uncut)).to.equal('a');
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    // A quadratic trim takes seconds at this length, a linear one well under
    // a millisecond
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
      expect(instanceSlug(value, { ...cloudery, dashes: false })).to.equal(
        slug
      );
    });
});

describe('numberedSlug', () => {
  for (const [slug, n, maxLength, numbered] of [
    ['jeanclaude', 2, 30, 'jeanclaude2'],
    ['jeanclaude', 12, 30, 'jeanclaude12'],
    ['a'.repeat(30), 2, 30, `${'a'.repeat(29)}2`],
    ['a'.repeat(30), 99, 30, `${'a'.repeat(28)}99`],
    ['a'.repeat(30), 2, 63, `${'a'.repeat(30)}2`],
    ['a'.repeat(63), 12, 63, `${'a'.repeat(61)}12`],
  ] as [string, number, number, string][])
    it(`numbers ${slug} ${n} as ${numbered} within ${maxLength}`, () => {
      expect(numberedSlug(slug, n, maxLength)).to.equal(numbered);
    });
});
