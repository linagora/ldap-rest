/**
 * A replace with an empty list clears an attribute, as LDAP itself reads it.
 * The organization and group routes validate each value against the schema:
 * an empty list is no value, refused only for a required attribute. On an
 * add or a creation it adds nothing, and the directory answers a protocol
 * error: it is refused as the client's fault.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { BadRequestError } from '../../../src/lib/errors';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

describe('Empty value lists', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let orgDn: string;
  let groupDn: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async function () {
    this.timeout(20000);
    const base = process.env.DM_LDAP_BASE as string;
    orgDn = `ou=ClearOrg,${process.env.DM_LDAP_TOP_ORGANIZATION as string}`;
    groupDn = `cn=clear-group,${process.env.DM_LDAP_GROUP_BASE || `ou=groups,${base}`}`;

    server = new DM();
    await server.ready;
    server.config.organization_schema =
      './static/schemas/twake/organizations.json';
    server.config.group_schema = './static/schemas/twake/groups.json';
    // Fills the organization path a creation needs
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    const organizations = new LdapOrganizations(server);
    const groups = new LdapGroups(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    await server.registerPlugin('ldapGroups', groups);
    await waitFor(() => Boolean(organizations.schema && groups.schema), {
      what: 'the organizations and groups schemas',
    });
    server.setupErrorMiddleware();
    request = supertest(server.app);

    for (const dn of [groupDn, orgDn])
      await server.ldap.delete(dn).catch(() => undefined);
    await server.ldap.add(orgDn, {
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou: 'ClearOrg',
      twakeDepartmentPath: 'ClearOrg',
      description: 'to clear',
    });
    await server.ldap.add(groupDn, {
      objectClass: ['top', 'groupOfNames', 'twakeGroup'],
      cn: 'clear-group',
      member: server.config.group_dummy_user as string,
      description: 'to clear',
    });
  });

  after(async () => {
    for (const dn of [
      groupDn,
      `cn=clear-new-group,${groupDn.replace(/^[^,]+,/, '')}`,
      `ou=ClearChild,${orgDn}`,
      orgDn,
    ])
      await server?.ldap.delete(dn).catch(() => undefined);
  });

  const description = async (dn: string): Promise<unknown> => {
    const entry = await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['description'] },
      dn
    );
    return (entry as { searchEntries: Record<string, unknown>[] })
      .searchEntries[0].description;
  };

  it('clears an attribute of an organization', async () => {
    const res = await request
      .put(`/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}`)
      .type('json')
      .send({ replace: { description: [] } });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect((await description(orgDn)) ?? []).to.deep.equal([]);
  });

  it('clears an attribute of a group', async () => {
    const res = await request
      .put('/api/v1/ldap/groups/clear-group')
      .type('json')
      .send({ replace: { description: [] } });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect((await description(groupDn)) ?? []).to.deep.equal([]);
  });

  it('refuses an empty list on an add, on every route', async () => {
    const org = await request
      .put(`/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}`)
      .type('json')
      .send({ add: { description: [] } });
    expect(org.status, JSON.stringify(org.body)).to.equal(400);
    expect(org.body.error).to.equal('Attribute "description" has no value');
    let refused: unknown;
    await server.ldap
      .modify(orgDn, { add: { description: [] } })
      .catch(err => (refused = err));
    expect(refused).to.be.instanceOf(BadRequestError);
  });

  it('refuses an empty list on a creation, on every route', async () => {
    let refused: unknown;
    await server.ldap
      .add(`cn=clear-new-group,${groupDn.replace(/^[^,]+,/, '')}`, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'clear-new-group',
        member: server.config.group_dummy_user as string,
        description: [],
      })
      .catch(err => (refused = err));
    expect(refused).to.be.instanceOf(BadRequestError);
    expect((refused as Error).message).to.equal(
      'Attribute "description" has no value'
    );
    const org = await request
      .post('/api/v1/ldap/organizations')
      .type('json')
      .send({ ou: 'ClearChild', parentDn: orgDn, description: [] });
    expect(org.status, JSON.stringify(org.body)).to.equal(400);
    expect(org.body.error).to.equal('Attribute "description" has no value');
  });

  it('still refuses to clear a required attribute', async () => {
    const res = await request
      .put(`/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}`)
      .type('json')
      .send({ replace: { ou: [] } });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.equal('Attribute "ou" is required');
  });
});
