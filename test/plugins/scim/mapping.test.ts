import { expect } from 'chai';

import {
  DEFAULT_USER_MAPPING,
  DEFAULT_GROUP_MAPPING,
  ldapToScimUser,
  scimUserToLdap,
  ldapToScimGroup,
  ldapTimeToIso,
  scimGroupToLdap,
  scimPathToLdapAttribute,
  requiredLdapAttributes,
  withExternalId,
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
    it('treats an empty lock attribute as active', () => {
      const user = ldapToScimUser(
        { uid: 'bob', pwdAccountLockedTime: [] },
        DEFAULT_USER_MAPPING,
        userCtx
      );
      expect(user.active).to.be.true;
    });
    it('reads a configured lock attribute', () => {
      const ctx = { ...userCtx, lockAttribute: 'nsAccountLock' };
      expect(
        ldapToScimUser(
          { uid: 'bob', nsAccountLock: 'TRUE' },
          DEFAULT_USER_MAPPING,
          ctx
        ).active
      ).to.be.false;
      // The default attribute must no longer be consulted.
      expect(
        ldapToScimUser(
          { uid: 'bob', pwdAccountLockedTime: '20260101000000Z' },
          DEFAULT_USER_MAPPING,
          ctx
        ).active
      ).to.be.true;
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
    it('reads a fraction of a minute as seconds', () => {
      // RFC 4517: the fraction applies to the smallest unit present.
      expect(ldapTimeToIso('202501011230.5Z')).to.equal('2025-01-01T12:30:30Z');
      expect(ldapTimeToIso('202501011230.25Z')).to.equal(
        '2025-01-01T12:30:15Z'
      );
      expect(ldapTimeToIso('202501011230.505Z')).to.equal(
        '2025-01-01T12:30:30.300Z'
      );
    });
    it('reads a fraction of an hour as minutes and seconds', () => {
      expect(ldapTimeToIso('2025010112.5Z')).to.equal('2025-01-01T12:30:00Z');
      expect(ldapTimeToIso('2025010112.75Z')).to.equal('2025-01-01T12:45:00Z');
      expect(ldapTimeToIso('2025010112.51Z')).to.equal('2025-01-01T12:30:36Z');
    });
    it('never carries a fraction past the hour it was given', () => {
      // 0.99999 of an hour is still inside that hour.
      expect(ldapTimeToIso('2025010123.99999Z')).to.equal(
        '2025-01-01T23:59:59.964Z'
      );
      expect(ldapTimeToIso('202501012359.9999Z')).to.equal(
        '2025-01-01T23:59:59.994Z'
      );
    });
    it('accepts a comma as the decimal separator', () => {
      expect(ldapTimeToIso('20250101123045,5Z')).to.equal(
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

  describe('scimUserToLdap and active', () => {
    it('writes the lock attribute for active=false', () => {
      const { attributes } = scimUserToLdap(
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          active: false,
        },
        DEFAULT_USER_MAPPING,
        userCtx,
        ['top', 'inetOrgPerson']
      );
      expect(attributes.pwdAccountLockedTime).to.equal('000001010000Z');
    });
    it('leaves it out for active=true, absence meaning active', () => {
      const { attributes } = scimUserToLdap(
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          active: true,
        },
        DEFAULT_USER_MAPPING,
        userCtx,
        ['top', 'inetOrgPerson']
      );
      expect(attributes.pwdAccountLockedTime).to.be.undefined;
    });
    it('honours a configured lock attribute and value', () => {
      const { attributes } = scimUserToLdap(
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          active: false,
        },
        DEFAULT_USER_MAPPING,
        { ...userCtx, lockAttribute: 'nsAccountLock', lockValue: 'TRUE' },
        ['top', 'inetOrgPerson']
      );
      expect(attributes.nsAccountLock).to.equal('TRUE');
      expect(attributes.pwdAccountLockedTime).to.be.undefined;
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

  describe('Group externalId', () => {
    it('is not mapped by default', () => {
      expect(DEFAULT_GROUP_MAPPING.entries.some(e => e.scim === 'externalId'))
        .to.be.false;
      // And so it never leaks entryUUID, which is a server value, not the
      // provisioning client's identifier (RFC 7643 section 3.1).
      const group = ldapToScimGroup(
        { cn: 'admins', entryUUID: 'b1e5-…' },
        DEFAULT_GROUP_MAPPING,
        groupCtx
      );
      expect(group.externalId).to.be.undefined;
    });

    it('round-trips through the configured attribute', () => {
      const mapping = withExternalId(DEFAULT_GROUP_MAPPING, 'description');
      const { attributes } = scimGroupToLdap(
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'admins',
          externalId: '00g1emaKYZTWRINFRGETl',
        },
        mapping,
        ['top', 'groupOfNames']
      );
      expect(attributes.description).to.equal('00g1emaKYZTWRINFRGETl');

      const group = ldapToScimGroup(
        { cn: 'admins', description: '00g1emaKYZTWRINFRGETl' },
        mapping,
        groupCtx
      );
      expect(group.externalId).to.equal('00g1emaKYZTWRINFRGETl');
    });

    it('becomes filterable once configured', () => {
      const mapping = withExternalId(DEFAULT_GROUP_MAPPING, 'description');
      expect(scimPathToLdapAttribute('externalId', mapping)).to.equal(
        'description'
      );
      expect(scimPathToLdapAttribute('externalId', DEFAULT_GROUP_MAPPING)).to.be
        .undefined;
    });

    it('leaves a mapping override in charge', () => {
      const overridden = {
        ...DEFAULT_GROUP_MAPPING,
        entries: [
          ...DEFAULT_GROUP_MAPPING.entries,
          { scim: 'externalId', ldap: 'businessCategory' },
        ],
      };
      expect(
        withExternalId(overridden, 'description').entries.find(
          e => e.scim === 'externalId'
        )?.ldap
      ).to.equal('businessCategory');
    });

    it('is a no-op when no attribute is named', () => {
      expect(withExternalId(DEFAULT_GROUP_MAPPING, '')).to.equal(
        DEFAULT_GROUP_MAPPING
      );
      // Whitespace from a config file or environment variable is not a name.
      expect(withExternalId(DEFAULT_GROUP_MAPPING, '   ')).to.equal(
        DEFAULT_GROUP_MAPPING
      );
    });

    it('trims the configured attribute name', () => {
      const entry = withExternalId(
        DEFAULT_GROUP_MAPPING,
        '  description \n'
      ).entries.find(e => e.scim === 'externalId');
      expect(entry?.ldap).to.equal('description');
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
      expect(
        requiredLdapAttributes(DEFAULT_USER_MAPPING, ['nsAccountLock'])
      ).to.include('nsAccountLock');
    });
  });
});
