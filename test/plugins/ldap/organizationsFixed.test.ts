/**
 * A `fixed` schema attribute is set by the server and refused in a change on
 * the flat routes and on groups. Organizations enforced neither: a fixed
 * attribute could be set on creation and changed afterwards.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { SearchResult } from 'ldapts';

import { DM } from '../../../src/bin';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Fixed attributes on organizations', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let orgDn: string;
  let previousSchema: string | undefined;
  const route = '/api/v1/ldap/organizations';
  const fixedClasses = ['top', 'organizationalUnit', 'twakeDepartment'];

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    orgDn = `ou=FixedOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    previousSchema = process.env.DM_ORGANIZATION_SCHEMA;
    process.env.DM_ORGANIZATION_SCHEMA =
      './test/fixtures/schemas/fixedOrganizations.json';
    server = new DM();
    await server.ready;
    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    for (let i = 0; i < 50 && !organizations.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    expect(organizations.schema?.attributes.objectClass?.fixed).to.be.true;
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(() => {
    if (previousSchema === undefined) delete process.env.DM_ORGANIZATION_SCHEMA;
    else process.env.DM_ORGANIZATION_SCHEMA = previousSchema;
  });

  afterEach(async () => {
    await server.ldap.delete(orgDn).catch(() => undefined);
  });

  const storedClasses = async (): Promise<unknown> => {
    const result = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['objectClass'] },
      orgDn
    )) as SearchResult;
    return result.searchEntries[0]?.objectClass;
  };

  it('writes a fixed attribute as the schema says on a creation', async () => {
    const res = await request
      .post(route)
      .send({ ou: 'FixedOrg', objectClass: ['top', 'organizationalUnit'] });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(await storedClasses()).to.have.members(fixedClasses);
  });

  describe('on a change', () => {
    beforeEach(async () => {
      await server.ldap.add(orgDn, {
        objectClass: fixedClasses,
        ou: 'FixedOrg',
      });
    });

    for (const changes of [
      { replace: { objectClass: ['top', 'organizationalUnit'] } },
      { add: { objectClass: 'extensibleObject' } },
      { delete: ['objectClass'] },
      { delete: { objectClass: ['twakeDepartment'] } },
    ]) {
      it(`refuses ${JSON.stringify(changes)}`, async () => {
        const res = await request
          .put(`${route}/${encodeURIComponent(orgDn)}`)
          .send(changes);
        expect(res.status, JSON.stringify(res.body)).to.equal(400);
        expect(res.body.error).to.match(/objectClass.*fixed/);
        expect(await storedClasses()).to.have.members(fixedClasses);
      });
    }

    it('still accepts a change to another attribute', async () => {
      const res = await request
        .put(`${route}/${encodeURIComponent(orgDn)}`)
        .send({ replace: { description: 'Changed' } });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
    });
  });
});
