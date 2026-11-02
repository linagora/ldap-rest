import { expect } from 'chai';

import { createEntityRegistry } from '../../src/lib/entities';
import type { Schema } from '../../src/config/schema';

const schema = (attribute: string): Schema =>
  ({
    strict: false,
    attributes: { [attribute]: { type: 'string', neverReturn: true } },
  }) as unknown as Schema;

describe('Entity registry', () => {
  it('keeps two entities sharing a singular name but not a collection', () => {
    const registry = createEntityRegistry();
    registry.register({
      name: 'user',
      pluralName: 'users',
      base: 'ou=users,dc=example,dc=com',
      mainAttribute: 'uid',
      kind: 'flat',
      source: { schema: schema('userPassword') },
    });
    registry.register({
      name: 'user',
      pluralName: 'externalUsers',
      base: 'ou=external,dc=example,dc=com',
      mainAttribute: 'uid',
      kind: 'flat',
      source: { schema: schema('externalPassword') },
    });

    expect(registry.all().map(entity => entity.pluralName)).to.deep.equal([
      'users',
      'externalUsers',
    ]);
    expect(
      registry.schemas().map(entity => Object.keys(entity?.attributes ?? {}))
    ).to.deep.equal([['userPassword'], ['externalPassword']]);
  });

  it('replaces an entity claiming the same collection', () => {
    const registry = createEntityRegistry();
    const declaration = {
      name: 'user',
      pluralName: 'users',
      base: 'ou=users,dc=example,dc=com',
      mainAttribute: 'uid',
      kind: 'flat' as const,
      source: { schema: schema('userPassword') },
    };
    registry.register(declaration);
    registry.register({
      ...declaration,
      base: 'ou=people,dc=example,dc=com',
    });

    expect(registry.all()).to.have.length(1);
    expect(registry.all()[0].base).to.equal('ou=people,dc=example,dc=com');
  });
});
