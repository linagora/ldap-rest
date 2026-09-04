/**
 * The rules were enforced on the flat entity routes and nowhere else. Each of
 * these exercises a way round them: another plugin's route, another verb, or a
 * change that touches the link without touching the value the link scopes.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import type { AttributesList } from '../../../src/lib/ldapActions';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Rules reach the other routes too', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let mainOrgDn: string;
  let listsOrgDn: string;
  let noPathOrgDn: string;
  let previousOrgSchema: string | undefined;
  let previousGroupSchema: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    mainOrgDn = `ou=ReachMain,ou=organization,${base}`;
    listsOrgDn = `ou=ReachLists,ou=organization,${base}`;
    noPathOrgDn = `ou=ReachNoPath,ou=organization,${base}`;

    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    previousOrgSchema = process.env.DM_ORGANIZATION_SCHEMA;
    previousGroupSchema = process.env.DM_GROUP_SCHEMA;
    process.env.DM_ORGANIZATION_SCHEMA =
      './static/schemas/twake/organizations.json';
    process.env.DM_GROUP_SCHEMA = './static/schemas/twake/groups.json';
    server = new DM();
    await server.ready;

    const domain = (dc: string) =>
      `dc=${dc},ou=domains,ou=nomenclature,${base}`;
    for (const [dn, attrs] of [
      [
        mainOrgDn,
        {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'ReachMain',
          twakeDepartmentPath: 'ReachMain',
          twakeDomainLink: domain('example'),
        },
      ],
      [
        listsOrgDn,
        {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'ReachLists',
          twakeDepartmentPath: 'ReachLists',
          twakeDomainLink: domain('lists'),
        },
      ],
      // Deliberately without a path: nothing can be derived from it.
      [
        noPathOrgDn,
        {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'ReachNoPath',
        },
      ],
    ] as [string, Record<string, unknown>][])
      await server.ldap.add(dn, attrs as AttributesList).catch(() => undefined);

    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    const groups = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', groups);
    for (let i = 0; i < 50 && !groups.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [
      `uid=reach.user,ou=users,${base}`,
      `cn=reachdup,${server.config.ldap_group_base as string}`,
      mainOrgDn,
      listsOrgDn,
      noPathOrgDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousOrgSchema)
      process.env.DM_ORGANIZATION_SCHEMA = previousOrgSchema;
    if (previousGroupSchema) process.env.DM_GROUP_SCHEMA = previousGroupSchema;
  });

  const createUser = () =>
    request.post('/api/v1/ldap/users').type('json').send({
      cn: 'Reach User',
      sn: 'User',
      mail: 'reach.user@example.com',
      twakeDepartmentLink: mainOrgDn,
    });

  it('should refuse a group mail already held, with the status the rule chose', async () => {
    await createUser().expect(201);
    const res = await request.post('/api/v1/ldap/groups').type('json').send({
      cn: 'reachdup',
      mail: 'reach.user@example.com',
      twakeDepartmentLink: mainOrgDn,
    });
    expect(res.status, JSON.stringify(res.body)).to.equal(409);
    expect(res.body.error).to.match(/already used/);
  });

  it('should re-check the stored mail when a move changes the organization', async () => {
    const res = await request
      .post('/api/v1/ldap/users/reach.user/move')
      .type('json')
      .send({ targetOrgDn: listsOrgDn });
    expect(res.status, JSON.stringify(res.body)).to.be.oneOf([400, 409]);
    expect(res.body.error).to.match(/domain/i);
  });

  it('should refuse a link whose organization has no path to give', async () => {
    const res = await request
      .post('/api/v1/ldap/users/reach.user/move')
      .type('json')
      .send({ targetOrgDn: noPathOrgDn });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/cannot be computed|has no /);
  });

  it('should refuse a client-supplied organization path on PUT', async () => {
    const res = await request
      .put(`/api/v1/ldap/organizations/${encodeURIComponent(listsOrgDn)}`)
      .type('json')
      .send({ replace: { twakeDepartmentPath: 'ReachMain' } });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/computed by the server/);
  });
});
