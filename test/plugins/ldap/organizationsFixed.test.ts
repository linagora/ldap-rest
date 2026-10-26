/**
 * A `fixed` schema attribute is the server's: on a creation it takes its
 * default, `objectClass` the configured classes, whatever the request
 * carried, and a change naming it answers 400, as on the flat routes.
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
  const previousSchema = process.env.DM_ORGANIZATION_SCHEMA;
  const route = '/api/v1/ldap/organizations';
  const configuredClasses = ['top', 'organizationalUnit', 'twakeDepartment'];

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    orgDn = `ou=FixedOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    process.env.DM_ORGANIZATION_SCHEMA =
      './test/fixtures/schemas/fixedOrganizations.json';
    server = new DM();
    await server.ready;
    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    for (let i = 0; i < 50 && !organizations.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    expect(organizations.schema?.attributes.objectClass?.fixed).to.be.true;
    expect(server.config.ldap_organization_class).to.deep.equal(
      configuredClasses
    );
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

  const stored = async (): Promise<Record<string, unknown>> => {
    const result = (await server.ldap.search(
      {
        paged: false,
        scope: 'base',
        attributes: ['objectClass', 'businessCategory'],
      },
      orgDn
    )) as SearchResult;
    return result.searchEntries[0] as Record<string, unknown>;
  };

  it('writes a fixed attribute as the schema says, and the configured classes, on a creation', async () => {
    const res = await request.post(route).send({
      ou: 'FixedOrg',
      objectClass: ['top', 'organizationalUnit', 'extensibleObject'],
      businessCategory: 'other',
    });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    const entry = await stored();
    expect(entry.objectClass).to.have.members(configuredClasses);
    expect(entry.businessCategory).to.equal('department');
  });

  describe('on a change', () => {
    beforeEach(async () => {
      await server.ldap.add(orgDn, {
        objectClass: configuredClasses,
        ou: 'FixedOrg',
        businessCategory: 'department',
      });
    });

    for (const changes of [
      { replace: { objectClass: ['top', 'organizationalUnit'] } },
      { add: { objectClass: 'extensibleObject' } },
      { delete: ['objectClass'] },
      { delete: { objectClass: ['twakeDepartment'] } },
      { replace: { businessCategory: 'other' } },
    ]) {
      it(`refuses ${JSON.stringify(changes)}`, async () => {
        const res = await request
          .put(`${route}/${encodeURIComponent(orgDn)}`)
          .send(changes);
        expect(res.status, JSON.stringify(res.body)).to.equal(400);
        expect(res.body.error).to.match(
          /(objectClass|businessCategory).*fixed/
        );
        const entry = await stored();
        expect(entry.objectClass).to.have.members(configuredClasses);
        expect(entry.businessCategory).to.equal('department');
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
