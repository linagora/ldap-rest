/**
 * The schema guards held on the flat routes and leaked on the others:
 *
 * - a `neverReturn` attribute came back from an organization's subnodes, which
 *   serve other entities' entries;
 * - a computed attribute could be deleted through the organizations and
 *   groups routes, which did not hand the `delete` keys to the guard;
 * - a computed attribute spelt in another case slipped past the guard, which
 *   looked names up verbatim though LDAP folds case.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import {
  assertClientMaySet,
  modifiedAttributeNames,
  schemaAttribute,
  type Schema,
} from '../../../src/config/schema';
import type { SearchResult } from 'ldapts';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Schema guards on every route', function () {
  describe('attribute lookup', () => {
    const schema: Schema = {
      strict: false,
      attributes: {
        twakeDepartmentPath: { type: 'string', generated: true },
        memberOf: { type: 'array', readOnly: true },
        cn: { type: 'string' },
      },
    };

    it('should find an attribute whatever its case and options', () => {
      expect(schemaAttribute(schema, 'TWAKEDEPARTMENTPATH')?.[0]).to.equal(
        'twakeDepartmentPath'
      );
      expect(schemaAttribute(schema, 'memberof;x-opt')?.[0]).to.equal(
        'memberOf'
      );
      expect(schemaAttribute(schema, 'unknown')).to.be.undefined;
    });

    it('should refuse a computed attribute spelt in another case', () => {
      expect(() =>
        assertClientMaySet(schema, ['TWAKEDEPARTMENTPATH'])
      ).to.throw(/computed by the server/);
      expect(() => assertClientMaySet(schema, ['MEMBEROF'])).to.throw(
        /read-only/
      );
      expect(() => assertClientMaySet(schema, ['CN'])).to.not.throw();
    });

    it('should count deleted attributes, in both delete forms', () => {
      expect(
        modifiedAttributeNames({
          add: { a: 'x' },
          replace: { b: 'y' },
          delete: ['c'],
        })
      ).to.deep.equal(['a', 'b', 'c']);
      expect(modifiedAttributeNames({ delete: { d: null } })).to.deep.equal([
        'd',
      ]);
    });
  });

  describe('over the API', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    let base: string;
    let orgDn: string;
    let groupCn: string;
    let previousOrgSchema: string | undefined;
    let previousGroupSchema: string | undefined;
    let previousFlatSchema: string | undefined;
    const uid = 'guards.user';

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
    });

    before(async () => {
      base = process.env.DM_LDAP_BASE as string;
      orgDn = `ou=GuardsOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
      groupCn = 'guardsgroup';

      previousFlatSchema = process.env.DM_LDAP_FLAT_SCHEMA;
      previousOrgSchema = process.env.DM_ORGANIZATION_SCHEMA;
      previousGroupSchema = process.env.DM_GROUP_SCHEMA;
      process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
      process.env.DM_ORGANIZATION_SCHEMA =
        './static/schemas/twake/organizations.json';
      process.env.DM_GROUP_SCHEMA = './static/schemas/twake/groups.json';
      server = new DM();
      await server.ready;

      await server.ldap
        .add(orgDn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'GuardsOrg',
          twakeDepartmentPath: 'GuardsOrg',
        })
        .catch(() => undefined);

      await server.registerPlugin(
        'ldapFlatGeneric',
        new LdapFlatGeneric(server)
      );
      const organizations = new LdapOrganizations(server);
      await server.registerPlugin('ldapOrganizations', organizations);
      const groups = new LdapGroups(server);
      await server.registerPlugin('ldapGroups', groups);
      for (let i = 0; i < 50 && (!groups.schema || !organizations.schema); i++)
        await new Promise(r => setTimeout(r, 100));
      await server.registerPlugin(
        'ldapEnterpriseRules',
        new LdapEnterpriseRules(server)
      );
      server.setupErrorMiddleware();
      request = supertest(server.app);

      await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send({
          cn: 'Guards User',
          sn: 'User',
          givenName: 'Guards',
          displayName: 'Guards User',
          employeeNumber: 'GRD0001',
          mail: `${uid}@example.com`,
          twakeDepartmentLink: orgDn,
          userPassword: 'S3cret-value',
        })
        .expect(201);
    });

    after(async () => {
      await server.ldap
        .delete(`uid=${uid},ou=users,${base}`)
        .catch(() => undefined);
      await server.ldap
        .delete(`cn=${groupCn},${server.config.ldap_group_base as string}`)
        .catch(() => undefined);
      await server.ldap.delete(orgDn).catch(() => undefined);
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore('DM_LDAP_FLAT_SCHEMA', previousFlatSchema);
      restore('DM_ORGANIZATION_SCHEMA', previousOrgSchema);
      restore('DM_GROUP_SCHEMA', previousGroupSchema);
    });

    const path = async (): Promise<unknown> => {
      const res = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['twakeDepartmentPath'] },
        orgDn
      )) as SearchResult;
      return res.searchEntries[0]?.twakeDepartmentPath;
    };

    describe('neverReturn', () => {
      it('should keep a password out of an organization subnodes', async () => {
        const res = await request
          .get(
            `/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}/subnodes`
          )
          .set('Accept', 'application/json');
        expect(res.status).to.equal(200);
        const user = (res.body as Record<string, unknown>[]).find(
          entry => entry.uid === uid
        );
        expect(user, 'the linked user is listed').to.exist;
        expect(user).to.not.have.property('userPassword');
      });

      it('should keep it out of a subnodes search too', async () => {
        const res = await request
          .get(
            `/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}/subnodes/search?q=${uid}`
          )
          .set('Accept', 'application/json');
        expect(res.status).to.equal(200);
        const user = (res.body as Record<string, unknown>[]).find(
          entry => entry.uid === uid
        );
        expect(user, 'the linked user is found').to.exist;
        expect(user).to.not.have.property('userPassword');
      });

      it('should still have written it', async () => {
        const raw = (await server.ldap.search(
          { paged: false, scope: 'base', attributes: ['userPassword'] },
          `uid=${uid},ou=users,${base}`
        )) as SearchResult;
        expect(raw.searchEntries[0]).to.have.property('userPassword');
      });
    });

    describe('deleting a computed attribute', () => {
      for (const [label, body] of [
        ['by name', { delete: ['twakeDepartmentPath'] }],
        ['by name, in another case', { delete: ['TWAKEDEPARTMENTPATH'] }],
        ['in the object form', { delete: { twakeDepartmentPath: null } }],
        [
          'in the object form, with an empty value',
          {
            delete: { twakeDepartmentPath: '' },
          },
        ],
      ] as [string, object][]) {
        it(`should be refused on an organization ${label}`, async () => {
          const res = await request
            .put(`/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}`)
            .type('json')
            .send(body);
          expect(res.status).to.equal(400);
          expect(await path()).to.equal('GuardsOrg');
        });
      }

      it('should be refused on a group', async () => {
        const res = await request
          .put(`/api/v1/ldap/groups/${groupCn}`)
          .type('json')
          .send({ delete: { TWAKEDEPARTMENTPATH: null } });
        expect(res.status).to.equal(400);
        expect(res.body.error).to.match(/computed by the server/);
      });
    });

    describe('setting a computed attribute in another case', () => {
      it('should be refused on an organization', async () => {
        const res = await request
          .put(`/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}`)
          .type('json')
          .send({ replace: { TWAKEDEPARTMENTPATH: 'Fake / Path' } });
        expect(res.status).to.equal(400);
        expect(res.body.error).to.match(/computed by the server/);
        expect(await path()).to.equal('GuardsOrg');
      });

      it('should be refused on a group', async () => {
        const res = await request
          .put(`/api/v1/ldap/groups/${groupCn}`)
          .type('json')
          .send({ replace: { TWAKEDEPARTMENTPATH: 'Fake / Path' } });
        expect(res.status).to.equal(400);
        expect(res.body.error).to.match(/computed by the server/);
      });
    });
  });
});
