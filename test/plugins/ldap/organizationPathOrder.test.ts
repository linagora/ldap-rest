/**
 * An organization path reads from the root down, the entry's own name last,
 * and stops below the top organization — a top-level organization's path is
 * its own name. That is what the directories this serves actually hold.
 *
 * `enterpriseRules` computes it and `organizations.checkDeptPath` validates
 * it. They used to disagree on the order, and regular plugins load through
 * `Promise.all`, so which one saw the value first was a race: in the losing
 * order every organization creation was refused, top-level ones included.
 * Both registration orders are exercised here.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Organization paths', function () {
  let base: string;
  let topOrg: string;
  let previousOrgSchema: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(() => {
    base = process.env.DM_LDAP_BASE as string;
    topOrg = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    previousOrgSchema = process.env.DM_ORGANIZATION_SCHEMA;
  });

  after(() => {
    if (previousOrgSchema)
      process.env.DM_ORGANIZATION_SCHEMA = previousOrgSchema;
  });

  const serve = async (
    rulesFirst: boolean
  ): Promise<{ server: DM; request: ReturnType<typeof supertest> }> => {
    process.env.DM_ORGANIZATION_SCHEMA =
      './static/schemas/twake/organizations.json';
    const server = new DM();
    await server.ready;
    if (rulesFirst)
      await server.registerPlugin(
        'ldapEnterpriseRules',
        new LdapEnterpriseRules(server)
      );
    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    // The organization schema is read asynchronously, and the rules bind to
    // the entity only once it is there.
    for (let i = 0; i < 50 && !organizations.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    if (!rulesFirst)
      await server.registerPlugin(
        'ldapEnterpriseRules',
        new LdapEnterpriseRules(server)
      );
    server.setupErrorMiddleware();
    return { server, request: supertest(server.app) };
  };

  for (const rulesFirst of [true, false]) {
    describe(
      rulesFirst ? 'rules registered first' : 'organizations first',
      () => {
        let server: DM;
        let request: ReturnType<typeof supertest>;
        const parent = `PathOrder${rulesFirst ? 'A' : 'B'}`;
        const child = `${parent}Child`;

        before(async () => {
          ({ server, request } = await serve(rulesFirst));
        });

        after(async () => {
          for (const dn of [
            `ou=${child},ou=${parent},${topOrg}`,
            `ou=${parent},${topOrg}`,
          ])
            await server.ldap.delete(dn).catch(() => undefined);
        });

        const read = async (dn: string) => {
          const res = (await server.ldap.search(
            { paged: false, scope: 'base', filter: '(objectClass=*)' },
            dn
          )) as { searchEntries: Record<string, unknown>[] };
          return res.searchEntries[0]?.twakeDepartmentPath;
        };

        it('should give a top-level organization its own name', async () => {
          const res = await request
            .post('/api/v1/ldap/organizations')
            .type('json')
            .send({ ou: parent, parentDn: topOrg });
          expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);
          expect(await read(`ou=${parent},${topOrg}`)).to.equal(parent);
        });

        it('should put the parent first and its own name last', async () => {
          const res = await request
            .post('/api/v1/ldap/organizations')
            .type('json')
            .send({ ou: child, parentDn: `ou=${parent},${topOrg}` });
          expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);
          expect(await read(`ou=${child},ou=${parent},${topOrg}`)).to.equal(
            `${parent} / ${child}`
          );
        });
      }
    );
  }
});
