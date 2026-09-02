import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

import type { Schema } from '../../src/config/schema';
import { roleAttribute } from '../../src/config/schema';

const read = (relative: string): Schema =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../../static/schemas', relative),
      'utf-8'
    )
  ) as Schema;

describe('Twake schemas', () => {
  let users: Schema;
  let groups: Schema;
  let organizations: Schema;

  before(() => {
    users = read('twake/users.json');
    groups = read('twake/groups.json');
    organizations = read('twake/organizations.json');
  });

  describe('semantic roles', () => {
    it('should name the organization link and path by role', () => {
      expect(roleAttribute(users, 'organizationLink')).to.equal(
        'twakeDepartmentLink'
      );
      expect(roleAttribute(users, 'organizationPath')).to.equal(
        'twakeDepartmentPath'
      );
    });

    it('should name the lifecycle attributes by role', () => {
      expect(roleAttribute(users, 'accountStatus')).to.equal(
        'twakeAccountStatus'
      );
      expect(roleAttribute(users, 'password')).to.equal('userPassword');
      expect(roleAttribute(users, 'passwordReset')).to.equal('pwdReset');
      expect(roleAttribute(users, 'accountExpiry')).to.equal(
        'twakeDeletionDate'
      );
    });

    it('should name the mail domains of an organization by role', () => {
      expect(roleAttribute(organizations, 'domainLink')).to.equal(
        'twakeDomainLink'
      );
    });
  });

  describe('organization link', () => {
    it('should be a validated DN reference, not a free string', () => {
      expect(users.attributes.twakeDepartmentLink.type).to.equal('pointer');
      expect(users.attributes.twakeDepartmentLink.required).to.be.true;
      expect(groups.attributes.twakeDepartmentLink.type).to.equal('pointer');
    });

    it('should compute the path rather than accept it', () => {
      expect(users.attributes.twakeDepartmentPath.generated).to.be.true;
      expect(groups.attributes.twakeDepartmentPath.generated).to.be.true;
    });
  });

  describe('identifier', () => {
    it('should be derived from the mail address', () => {
      const uid = users.attributes.uid;
      expect(uid.generated).to.be.true;
      expect(uid.generatedFrom?.attribute).to.equal('mail');
      expect(uid.generatedFrom?.onCollision).to.equal('suffix');
    });
  });

  describe('credentials', () => {
    it('should be writable but never returned', () => {
      expect(users.attributes.userPassword.neverReturn).to.be.true;
      expect(users.attributes.pwdReset.neverReturn).to.be.true;
      expect(users.attributes.userPassword.readOnly).to.be.undefined;
    });
  });

  describe('memberships', () => {
    it('should be read-only: they are driven from the group side', () => {
      expect(users.attributes.memberOf.readOnly).to.be.true;
    });
  });

  describe('organization names', () => {
    it('should accept the names real directories carry', () => {
      const pattern = new RegExp(organizations.attributes.ou.test as string);
      for (const name of [
        'Republic of Examplia',
        "Prime Minister's Office",
        'Ministry of Transport & Public Works',
        'Test Org 1',
        'Direction générale',
      ]) {
        expect(pattern.test(name), name).to.be.true;
      }
    });

    it('should still refuse a name that would break a DN or a path', () => {
      const pattern = new RegExp(organizations.attributes.ou.test as string);
      for (const name of ['', ' leading space', 'a\nb', 'a+b']) {
        expect(pattern.test(name), JSON.stringify(name)).to.be.false;
      }
    });
  });

  describe('labels', () => {
    it('should name every attribute a client shows', () => {
      const missing: string[] = [];
      for (const schema of [users, groups, organizations])
        for (const [name, attr] of Object.entries(schema.attributes)) {
          if (name === 'objectClass') continue;
          if (!attr.label) missing.push(name);
        }
      expect(missing).to.deep.equal([]);
    });

    it('should translate those names rather than assume one language', () => {
      // A label the interface cannot translate is the mixed-language screen
      // this replaces, one field at a time.
      const untranslated: string[] = [];
      for (const schema of [users, groups, organizations])
        for (const [name, attr] of Object.entries(schema.attributes)) {
          if (!attr.label) continue;
          if (typeof attr.label === 'string' || !attr.label.fr)
            untranslated.push(name);
        }
      expect(untranslated).to.deep.equal([]);
    });

    it('should name the collections themselves', () => {
      const entity = (users as unknown as { entity?: { label?: unknown } })
        .entity;
      expect(entity?.label).to.deep.equal({
        en: 'Users',
        fr: 'Utilisateurs',
      });
    });
  });

  describe('hints', () => {
    it('should explain every pattern a client can show under a field', () => {
      const missing: string[] = [];
      for (const schema of [users, groups, organizations]) {
        for (const [name, attr] of Object.entries(schema.attributes)) {
          if (name === 'objectClass') continue;
          // A value the server computes is never typed by anyone.
          if (attr.generated) continue;
          const pattern = attr.test || attr.items?.test;
          const hint = attr.hint || attr.items?.hint;
          // A pattern that only rules out control characters needs no
          // explanation; a pattern a user has to satisfy does.
          if (pattern && !hint && !String(pattern).includes('\\r\\n'))
            missing.push(name);
        }
      }
      expect(missing).to.deep.equal([]);
    });
  });
});
