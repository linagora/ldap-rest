import { expect } from 'chai';

import {
  DEFAULT_USER_MAPPING,
  DEFAULT_GROUP_MAPPING,
  ldapToScimUser,
  scimUserToLdap,
  ldapToScimGroup,
  ldapTimeToIso,
  scimPathToLdapAttribute,
  requiredLdapAttributes,
  type MappingContext,
} from '../../../src/plugins/scim/mapping';

const userCtx: MappingContext = {
  idAttribute: 'rdn',
  rdnAttribute: 'uid',
  resourceType: 'User',
  baseUrl: 'https://example.test',
  scimPrefix: '/scim/v2',
};

const groupCtx: MappingContext = {
  ...userCtx,
  rdnAttribute: 'cn',
  resourceType: 'Group',
};

describe('SCIM mapping', () => {
  describe('ldapToScimUser', () => {
    it('maps inetOrgPerson attributes to SCIM User', () => {
      const user = ldapToScimUser(
        {
          uid: 'alice',
          cn: 'Alice Doe',
          sn: 'Doe',
          givenName: 'Alice',
          displayName: 'Alice D.',
          mail: 'alice@example.com',
          mailAlternateAddress: ['alice.doe@corp.com', 'ad@corp.com'],
          createTimestamp: '20250101000000Z',
          modifyTimestamp: '20250202000000Z',
        },
        DEFAULT_USER_MAPPING,
        userCtx
      );
      expect(user.id).to.equal('alice');
      expect(user.userName).to.equal('alice');
      expect(user.displayName).to.equal('Alice D.');
      expect(user.name).to.deep.equal({
        familyName: 'Doe',
        givenName: 'Alice',
        formatted: 'Alice Doe',
      });
      expect(user.emails).to.deep.equal([
        { value: 'alice@example.com', primary: true },
        { value: 'alice.doe@corp.com' },
        { value: 'ad@corp.com' },
      ]);
      expect(user.active).to.be.true;
      expect(user.meta?.resourceType).to.equal('User');
      expect(user.meta?.location).to.equal(
        'https://example.test/scim/v2/Users/alice'
      );
      expect(user.meta?.created).to.equal('2025-01-01T00:00:00Z');
      expect(user.meta?.lastModified).to.equal('2025-02-02T00:00:00Z');
    });
    it('marks locked accounts as active=false', () => {
      const user = ldapToScimUser(
        { uid: 'bob', pwdAccountLockedTime: '20260101000000Z' },
        DEFAULT_USER_MAPPING,
        userCtx
      );
      expect(user.active).to.be.false;
    });
  });

  describe('ldapTimeToIso', () => {
    it('converts a GeneralizedTime to an xsd:dateTime', () => {
      expect(ldapTimeToIso('20250101123045Z')).to.equal('2025-01-01T12:30:45Z');
    });
    it('keeps a fraction of a second as milliseconds', () => {
      expect(ldapTimeToIso('20250101123045.123Z')).to.equal(
        '2025-01-01T12:30:45.123Z'
      );
      expect(ldapTimeToIso('20250101123045.5Z')).to.equal(
        '2025-01-01T12:30:45.500Z'
      );
    });
    it('converts a numeric offset', () => {
      expect(ldapTimeToIso('20250101123045+0200')).to.equal(
        '2025-01-01T12:30:45+02:00'
      );
      expect(ldapTimeToIso('20250101123045-05')).to.equal(
        '2025-01-01T12:30:45-05:00'
      );
    });
    it('defaults the omitted minutes and seconds', () => {
      expect(ldapTimeToIso('2025010112Z')).to.equal('2025-01-01T12:00:00Z');
      expect(ldapTimeToIso('202501011230Z')).to.equal('2025-01-01T12:30:00Z');
    });
    it('assumes UTC when no zone is given', () => {
      expect(ldapTimeToIso('20250101123045')).to.equal('2025-01-01T12:30:45Z');
    });
    it('passes through a value that is not a GeneralizedTime', () => {
      expect(ldapTimeToIso('2025-01-01T12:30:45Z')).to.equal(
        '2025-01-01T12:30:45Z'
      );
      expect(ldapTimeToIso('nonsense')).to.equal('nonsense');
      expect(ldapTimeToIso('20251301123045Z')).to.equal('20251301123045Z');
    });
    it('returns undefined for a missing value', () => {
      expect(ldapTimeToIso(undefined)).to.be.undefined;
      expect(ldapTimeToIso('')).to.be.undefined;
    });
  });

  describe('scimUserToLdap', () => {
    it('converts SCIM User to LDAP attributes', () => {
      const { rdn, attributes } = scimUserToLdap(
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          name: {
            familyName: 'Doe',
            givenName: 'Alice',
            formatted: 'Alice Doe',
          },
          displayName: 'Alice',
          emails: [
            { value: 'alice@example.com', primary: true },
            { value: 'ad@corp.com' },
          ],
        },
        DEFAULT_USER_MAPPING,
        userCtx,
        ['top', 'inetOrgPerson', 'person']
      );
      expect(rdn).to.equal('alice');
      // Per default mapping, userName → uid, so it is populated here too.
      expect(attributes.uid).to.equal('alice');
      expect(attributes.sn).to.equal('Doe');
      expect(attributes.givenName).to.equal('Alice');
      expect(attributes.cn).to.equal('Alice Doe');
      expect(attributes.mail).to.equal('alice@example.com');
      expect(attributes.mailAlternateAddress).to.deep.equal(['ad@corp.com']);
      expect(attributes.objectClass).to.deep.equal([
        'top',
        'inetOrgPerson',
        'person',
      ]);
    });
    it('fills defaults cn and sn when missing', () => {
      const { attributes } = scimUserToLdap(
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'ghost',
        },
        DEFAULT_USER_MAPPING,
        userCtx,
        ['top', 'inetOrgPerson']
      );
      expect(attributes.cn).to.equal('ghost');
      expect(attributes.sn).to.equal('ghost');
    });
  });

  describe('ldapToScimGroup', () => {
    it('maps groupOfNames to SCIM Group', () => {
      const g = ldapToScimGroup(
        {
          cn: 'admins',
          member: [
            'uid=alice,ou=users,dc=example,dc=com',
            'uid=bob,ou=users,dc=example,dc=com',
          ],
        },
        DEFAULT_GROUP_MAPPING,
        groupCtx
      );
      expect(g.id).to.equal('admins');
      expect(g.displayName).to.equal('admins');
      expect(g.members).to.have.lengthOf(2);
      expect(g.members?.[0].value).to.equal(
        'uid=alice,ou=users,dc=example,dc=com'
      );
    });
    it('member resolver translates DN → SCIM ref', () => {
      const g = ldapToScimGroup(
        {
          cn: 'ops',
          member: ['uid=alice,ou=users,dc=example,dc=com'],
        },
        DEFAULT_GROUP_MAPPING,
        groupCtx,
        dn => {
          const rdnValue = /^uid=([^,]+)/.exec(dn)?.[1];
          return rdnValue ? { value: rdnValue, type: 'User' } : undefined;
        }
      );
      expect(g.members?.[0]).to.deep.equal({ value: 'alice', type: 'User' });
    });
  });

  describe('scimPathToLdapAttribute', () => {
    it('resolves simple attribute', () => {
      expect(
        scimPathToLdapAttribute('userName', DEFAULT_USER_MAPPING)
      ).to.equal('uid');
    });
    it('resolves sub-attribute', () => {
      expect(
        scimPathToLdapAttribute('name.familyName', DEFAULT_USER_MAPPING)
      ).to.equal('sn');
    });
    it('resolves multi-valued primary', () => {
      expect(
        scimPathToLdapAttribute('emails.value', DEFAULT_USER_MAPPING)
      ).to.equal('mail');
    });
    it('returns undefined for unknown path', () => {
      expect(scimPathToLdapAttribute('unknown.attr', DEFAULT_USER_MAPPING)).to
        .be.undefined;
    });
  });

  describe('requiredLdapAttributes', () => {
    it('collects all LDAP attrs used by the mapping', () => {
      const attrs = requiredLdapAttributes(DEFAULT_USER_MAPPING);
      expect(attrs).to.include('uid');
      expect(attrs).to.include('sn');
      expect(attrs).to.include('mail');
      expect(attrs).to.include('mailAlternateAddress');
      expect(attrs).to.include('entryUUID');
      expect(attrs).to.include('createTimestamp');
    });
  });
});
