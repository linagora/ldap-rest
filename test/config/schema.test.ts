import { expect } from 'chai';

import { type Schema, schemaAttribute } from '../../src/config/schema';

describe('schemaAttribute', () => {
  const schema = {
    attributes: { cn: { type: 'string' } },
  } as unknown as Schema;

  it('does not take an Object.prototype name for a declared attribute', () => {
    for (const name of [
      'constructor',
      'toString',
      'hasOwnProperty',
      '__proto__',
    ])
      expect(schemaAttribute(schema, name), name).to.be.undefined;
  });

  it('finds an own attribute whatever its case or options', () => {
    expect(schemaAttribute(schema, 'CN;lang-fr')?.[0]).to.equal('cn');
  });
});
