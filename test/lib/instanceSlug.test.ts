import { expect } from 'chai';

import { instanceSlug } from '../../src/lib/instanceProviders';

describe('instanceSlug', () => {
  for (const [value, slug] of [
    ['janedoe', 'janedoe'],
    ['Jane.Doe', 'janedoe'],
    ['jane.doe_stg', 'janedoestg'],
    ['jane@acme.com', 'janeacmecom'],
    ['Foo.Bar-1', 'foobar-1'],
    ['-jane-', 'jane'],
    ['jane_-', 'jane'],
    ['___', ''],
    ['é', ''],
  ])
    it(`turns ${JSON.stringify(value)} into ${JSON.stringify(slug)}`, () => {
      expect(instanceSlug(value)).to.equal(slug);
    });

  it('trims a long run of dashes in linear time', () => {
    const value = `a${'-'.repeat(200_000)}b`;
    const start = process.hrtime.bigint();
    expect(instanceSlug(value)).to.equal(value);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    // A quadratic trim takes seconds at this length, a linear one well under
    // a millisecond
    expect(elapsed).to.be.below(50);
    expect(instanceSlug(`a${'-'.repeat(200_000)}`)).to.equal('a');
  });
});
