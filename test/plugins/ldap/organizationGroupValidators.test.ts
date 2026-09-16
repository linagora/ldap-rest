/**
 * The organization and group routes validate with validators of their own,
 * which had fallen behind the flat one:
 *
 * - organizations read neither `items.branch` nor `items.type: pointer`, so a
 *   domain link to a DN outside the domains branch, or to no entry at all,
 *   was stored — and the organization lost its mail-domain restriction;
 * - groups compared a pointer's branch as a text suffix;
 * - both answered a refused value with a plain Error, which reaches the client
 *   as a 500, and organizations refused with a 500 the string an existing
 *   client still sends for an attribute the schema turned into an array.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapGroups from '../../../src/plugins/ldap/groups';
import type { SearchResult } from 'ldapts';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Organization and group validators', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let orgDn: string;
  let previousOrgSchema: string | undefined;
  let previousGroupSchema: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    orgDn = `ou=ValidatorsOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    previousOrgSchema = process.env.DM_ORGANIZATION_SCHEMA;
    previousGroupSchema = process.env.DM_GROUP_SCHEMA;
    process.env.DM_ORGANIZATION_SCHEMA =
      './static/schemas/twake/organizations.json';
    process.env.DM_GROUP_SCHEMA = './static/schemas/twake/groups.json';
    server = new DM();
    await server.ready;
    await server.ldap
      .add(orgDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'ValidatorsOrg',
        twakeDepartmentPath: 'ValidatorsOrg',
      })
      .catch(() => undefined);

    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    const groups = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', groups);
    for (let i = 0; i < 50 && (!organizations.schema || !groups.schema); i++)
      await new Promise(r => setTimeout(r, 100));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    await server.ldap.delete(orgDn).catch(() => undefined);
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('DM_ORGANIZATION_SCHEMA', previousOrgSchema);
    restore('DM_GROUP_SCHEMA', previousGroupSchema);
  });

  const putOrg = (body: object) =>
    request
      .put(`/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}`)
      .type('json')
      .send(body);

  const stored = async (attr: string): Promise<unknown> => {
    const res = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: [attr] },
      orgDn
    )) as SearchResult;
    return res.searchEntries[0]?.[attr];
  };

  describe('an array of pointers on an organization', () => {
    it('should refuse a DN outside the declared branch', async () => {
      const res = await putOrg({
        replace: { twakeDomainLink: [`ou=evil,${base}`] },
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/within allowed branches/);
      expect([await stored('twakeDomainLink')].flat()).to.not.include(
        `ou=evil,${base}`
      );
    });

    it('should refuse a DN inside the branch naming no entry', async () => {
      const res = await putOrg({
        replace: {
          twakeDomainLink: [`dc=missing,ou=domains,ou=nomenclature,${base}`],
        },
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/non-existent DN/);
    });

    it('should refuse the same on a creation', async () => {
      const res = await request
        .post('/api/v1/ldap/organizations')
        .type('json')
        .send({
          ou: 'ValidatorsChild',
          parentDn: orgDn,
          twakeDomainLink: [`ou=evil,${base}`],
        });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
    });

    it('should refuse a manager outside the users branch', async () => {
      const res = await putOrg({
        replace: { twakeManagerLink: [`cn=admins,ou=groups,${base}`] },
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
    });

    it('should accept an existing domain', async () => {
      const domain = `dc=example,ou=domains,ou=nomenclature,${base}`;
      const res = await putOrg({ replace: { twakeDomainLink: [domain] } });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await stored('twakeDomainLink')).to.equal(domain);
    });
  });

  describe('a value an organization cannot take', () => {
    it('should accept a single value for a multi-valued attribute', async () => {
      const res = await putOrg({
        replace: { telephoneNumber: '+1234567890' },
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await stored('telephoneNumber')).to.equal('+1234567890');
    });

    it('should answer 400, not 500, to an attribute the schema does not know', async () => {
      const res = await putOrg({ replace: { notAnAttribute: 'x' } });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
    });

    it('should answer 400, not 500, to several values for a single one', async () => {
      const res = await putOrg({
        replace: { facsimileTelephoneNumber: ['+1', '+2'] },
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
    });
  });

  describe('an array on a group', () => {
    it('should not check element types an array declares no pattern for', async () => {
      // Groups checked element types alongside `items.test` only; checking
      // them for every array would tighten what the route accepts, unasked.
      const groups = server.loadedPlugins['ldapGroups'] as LdapGroups;
      const saved = groups.schema;
      groups.schema = {
        strict: false,
        attributes: {
          tags: { type: 'array', items: { type: 'string' } },
          codes: { type: 'array', items: { type: 'string', test: '^\\d+$' } },
        },
      };
      try {
        expect(
          await groups._validateOneChange('tags', [1 as unknown as string])
        ).to.be.true;
        try {
          await groups._validateOneChange('codes', [1 as unknown as string]);
          expect.fail('an element of the wrong type passed a pattern check');
        } catch (e) {
          expect((e as Error).message).to.match(/must be of type string/);
        }
      } finally {
        groups.schema = saved;
      }
    });
  });

  describe('a pointer on a group', () => {
    it('should compare the branch RDN by RDN, and answer 400', async () => {
      // Ends with the branch as text, but its parent is `xou=twakeListType`
      const res = await request
        .put('/api/v1/ldap/groups/validatorsgroup')
        .type('json')
        .send({
          replace: {
            businessCategory: `cn=openList,xou=twakeListType,ou=nomenclature,${base}`,
          },
        });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/within allowed branches/);
    });
  });
});
