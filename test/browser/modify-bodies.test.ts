/**
 * The bundled editors PUT the entry as the form holds it, and the routes
 * take only `add`, `replace` and `delete`: they send what changed, as a
 * `replace`.
 */
import { expect } from 'chai';
import nock from 'nock';

import { changedAttributes } from '../../src/browser/shared/utils/form';
import { UserApiClient } from '../../src/browser/ldap-user-editor/api/UserApiClient';
import { GroupApiClient } from '../../src/browser/ldap-group-editor/api/GroupApiClient';
import { UnitApiClient } from '../../src/browser/ldap-unit-editor/api/UnitApiClient';

describe('Browser editors, modify bodies', () => {
  describe('changedAttributes', () => {
    const original = {
      dn: 'uid=alice,ou=users,dc=example,dc=com',
      uid: 'alice',
      cn: 'Alice',
      mail: ['a@example.com', 'alice@example.com'],
      mailQuotaSize: '1000',
      description: 'old',
    };

    it('keeps only what changed', () => {
      expect(
        changedAttributes(original, {
          ...original,
          cn: 'Alice Smith',
        })
      ).to.deep.equal({ cn: 'Alice Smith' });
    });

    it('never sends the DN', () => {
      expect(
        changedAttributes(original, { ...original, dn: 'uid=x,dc=example' })
      ).to.deep.equal({});
    });

    it('reads a number and its text as the same value', () => {
      expect(
        changedAttributes(original, { ...original, mailQuotaSize: 1000 })
      ).to.deep.equal({});
    });

    it('ignores the order of a multi-valued attribute', () => {
      expect(
        changedAttributes(original, {
          ...original,
          mail: ['alice@example.com', 'a@example.com'],
        })
      ).to.deep.equal({});
    });

    it('clears an attribute emptied in the form', () => {
      expect(
        changedAttributes(original, { ...original, description: '' })
      ).to.deep.equal({ description: [] });
    });

    it('sends an attribute the entry did not have', () => {
      expect(
        changedAttributes(original, { ...original, mobile: '+33600000000' })
      ).to.deep.equal({ mobile: '+33600000000' });
    });
  });

  describe('API clients', () => {
    const baseUrl = 'http://editors.test';
    afterEach(() => nock.cleanAll());

    const expectReplace = (path: string) =>
      nock(baseUrl)
        .put(path, body => {
          expect(body).to.deep.equal({ replace: { cn: 'x' } });
          return true;
        })
        .reply(200, { success: true });

    it('sends a replace for a user', async () => {
      const scope = expectReplace('/api/v1/ldap/users/alice');
      await new UserApiClient(baseUrl).updateUser('alice', { cn: 'x' });
      expect(scope.isDone()).to.equal(true);
    });

    it('sends a replace for a group', async () => {
      const scope = expectReplace('/api/v1/ldap/groups/staff');
      await new GroupApiClient(baseUrl).updateGroup('staff', { cn: 'x' });
      expect(scope.isDone()).to.equal(true);
    });

    it('sends a replace for an organizational unit', async () => {
      const dn = 'ou=Sales,dc=example,dc=com';
      const scope = expectReplace(
        `/api/v1/ldap/organizations/${encodeURIComponent(dn)}`
      );
      await new UnitApiClient(baseUrl).updateUnit(dn, { cn: 'x' });
      expect(scope.isDone()).to.equal(true);
    });
  });
});
