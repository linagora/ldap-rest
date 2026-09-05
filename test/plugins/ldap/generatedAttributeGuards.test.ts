/**
 * Two ways a `generated` attribute can go wrong quietly.
 *
 * A schema marks an attribute required *and* generated, so a client may not
 * send it and a hook fills it after validation. That bargain only holds if the
 * hook is there — and if the value it fills is held to the same rules a
 * submitted value would meet.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Generated attributes', function () {
  let base: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(() => {
    base = process.env.DM_LDAP_BASE as string;
  });

  const serve = async (
    schema: string,
    withRules: boolean
  ): Promise<{ server: DM; request: ReturnType<typeof supertest> }> => {
    const server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [schema];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    // A plugin carrying the `consistency` role but filling none of these:
    // the exemption must turn on the capability, not on the role.
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    if (withRules)
      await server.registerPlugin(
        'ldapEnterpriseRules',
        new LdapEnterpriseRules(server)
      );
    server.setupErrorMiddleware();
    return { server, request: supertest(server.app) };
  };

  describe('with nothing loaded to fill them', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    let deptDn: string;

    before(async () => {
      deptDn = `ou=GuardsOrg,${base}`;
      ({ server, request } = await serve(
        './static/schemas/twake/users.json',
        false
      ));
      await server.ldap
        .add(deptDn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'GuardsOrg',
          twakeDepartmentPath: 'GuardsOrg',
        })
        .catch(() => undefined);
    });

    after(async () => {
      await server.ldap
        .delete(`uid=guards.user,ou=users,${base}`)
        .catch(() => undefined);
      await server.ldap.delete(deptDn).catch(() => undefined);
    });

    it('should refuse the creation rather than write an incomplete entry', async () => {
      // Without `core/ldap/enterpriseRules`, nothing fills the path or the
      // status. Exempting them would store an entry missing two attributes
      // its own schema calls required — and the client cannot supply them
      // either, since a generated attribute is refused as input.
      const res = await request.post('/api/v1/ldap/users').type('json').send({
        cn: 'Guards User',
        sn: 'User',
        mail: 'guards.user@example.com',
        twakeDepartmentLink: deptDn,
        employeeNumber: 'GEN0001',
        givenName: 'Test',
        displayName: 'Test Person',
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/is required/);
    });
  });

  describe('on the routes that validate for themselves', function () {
    // Organizations and groups have their own validator instead of the flat
    // one, and both shipped schemas mark the organization path required *and*
    // generated. Exempting it whatever is loaded wrote an entry missing the
    // path its own schema demands — and no client could repair it afterwards,
    // since a generated attribute is refused as input.
    let server: DM;
    let request: ReturnType<typeof supertest>;
    let groups: LdapGroups;
    let orgDn: string;
    let childDn: string;
    let groupDn: string;

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
    });

    before(async () => {
      server = new DM();
      await server.ready;
      server.config.organization_schema =
        './static/schemas/twake/organizations.json';
      server.config.group_schema = './static/schemas/twake/groups.json';
      const organizations = new LdapOrganizations(server);
      groups = new LdapGroups(server);
      await server.registerPlugin('ldapOrganizations', organizations);
      await server.registerPlugin('ldapGroups', groups);
      // Both schemas are read asynchronously; without waiting, the validators
      // return early and the test proves nothing.
      for (let i = 0; i < 50 && !(organizations.schema && groups.schema); i++)
        await new Promise(r => setTimeout(r, 100));
      server.setupErrorMiddleware();
      request = supertest(server.app);
      const topOrg = process.env.DM_LDAP_TOP_ORGANIZATION as string;
      orgDn = `ou=SelfGuardsOrg,${topOrg}`;
      childDn = `ou=SelfGuardsChild,${orgDn}`;
      groupDn = `cn=selfguardsgrp,${groups.base}`;
      await server.ldap
        .add(orgDn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'SelfGuardsOrg',
          twakeDepartmentPath: 'SelfGuardsOrg',
        })
        .catch(() => undefined);
    });

    after(async () => {
      for (const dn of [groupDn, childDn, orgDn])
        await server.ldap.delete(dn).catch(() => undefined);
    });

    it('should refuse an organization whose path nothing will fill', async () => {
      const res = await request
        .post('/api/v1/ldap/organizations')
        .type('json')
        .send({ ou: 'SelfGuardsChild', parentDn: orgDn });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/twakeDepartmentPath/);
    });

    it('should refuse a group whose path nothing will fill', async () => {
      try {
        await groups.addGroup('selfguardsgrp', [], {
          twakeDepartmentLink: orgDn,
        });
        expect.fail('Should have refused the creation');
      } catch (e) {
        expect((e as Error).message).to.match(/twakeDepartmentPath/);
      }
    });
  });

  describe('when the schema default points nowhere', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;

    before(async () => {
      ({ server, request } = await serve(
        './test/fixtures/schemas/danglingPointerDefault.json',
        true
      ));
    });

    after(async () => {
      await server.ldap
        .delete(`uid=dangling.user,ou=users,${base}`)
        .catch(() => undefined);
    });

    it('should refuse it, as it refuses the same value from a client', async () => {
      const res = await request
        .post('/api/v1/ldap/danglingUsers')
        .type('json')
        .send({ uid: 'dangling.user', cn: 'Dangling User', sn: 'User' });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/points to a non-existent entry/);
    });
  });

  describe('when the schema default is an array of pointers to nowhere', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;

    before(async () => {
      ({ server, request } = await serve(
        './test/fixtures/schemas/danglingPointerArrayDefault.json',
        true
      ));
    });

    after(async () => {
      await server.ldap
        .delete(`uid=dangling.array.user,ou=users,${base}`)
        .catch(() => undefined);
    });

    it('should refuse it, the same as a single dangling pointer default', async () => {
      const res = await request
        .post('/api/v1/ldap/danglingArrayUsers')
        .type('json')
        .send({
          uid: 'dangling.array.user',
          cn: 'Dangling Array User',
          sn: 'User',
        });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/points to a non-existent entry/);
    });
  });
});
