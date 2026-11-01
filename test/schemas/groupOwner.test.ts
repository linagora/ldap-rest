import * as fs from 'fs';
import * as path from 'path';

import { expect } from 'chai';

import type { Schema } from '../../src/config/schema';

const base = 'dc=example,dc=com';

const pattern = (relative: string, name: string): RegExp => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../../static/schemas', relative),
      'utf-8'
    )
  ) as Schema;
  const test = schema.attributes[name].items?.test as string;
  return new RegExp(test.replace(/__LDAP_BASE__/g, base));
};

for (const file of ['twake/groups.json', 'standard/groups.json']) {
  describe(`${file} owner`, () => {
    it('should accept an account anywhere under the base, as a member is', () => {
      const owner = pattern(file, 'owner');
      expect(owner.test(`uid=jane,ou=users,${base}`)).to.equal(true);
      expect(owner.test(`cn=admins,${base}`)).to.equal(true);
      expect(pattern(file, 'member').source).to.equal(owner.source);
    });

    it('should refuse a DN outside the base', () => {
      const owner = pattern(file, 'owner');
      expect(owner.test('uid=jane,ou=users,dc=other,dc=org')).to.equal(false);
      expect(owner.test('jane')).to.equal(false);
    });
  });
}
