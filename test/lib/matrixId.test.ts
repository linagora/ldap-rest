import { expect } from 'chai';

import { matrixId } from '../../src/lib/instanceProviders';

describe('matrixId', () => {
  for (const [mail, id] of [
    ['uid@twake.app', '@uid:twake.app'],
    ['khaled@khaled.com', '@khaled:khaled.com'],
    ['Jane.Doe@Acme.COM', '@jane.doe:acme.com'],
    ['"a@b"@acme.com', '@"a@b":acme.com'],
  ])
    it(`turns ${mail} into ${id}`, () => {
      expect(matrixId(mail)).to.equal(id);
    });

  for (const mail of [
    '',
    'jane',
    '@acme.com',
    'jane@',
    'jane doe@acme.com',
    '"a:b"@acme.com',
    'jane@acme.com\n',
    `${'a'.repeat(250)}@acme.com`,
  ])
    it(`gives none for ${JSON.stringify(mail)}`, () => {
      expect(matrixId(mail)).to.equal(undefined);
    });
});
