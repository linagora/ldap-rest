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
});
