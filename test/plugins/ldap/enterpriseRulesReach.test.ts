/**
 * Two ways the enterprise rules stopped applying without saying so:
 *
 * - a DN written with a space after a comma addresses the same entry, but the
 *   entity was matched on the DN's text, so every rule was skipped for it;
 * - the mail-domain rule read the domain name from an option and never from
 *   the `domainName` role, so a deployment naming that attribute otherwise
 *   had every address accepted.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import type { AttributesList } from '../../../src/lib/ldapActions';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Enterprise rules reach every spelling and every naming', function () {
  let base: string;
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let orgDn: string;
  let domainDn: string;
  let previousOrgSchema: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    orgDn = `ou=ReachRoleOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    // Under the branch the organization schema declares for domain links, but
    // named through `description`: no `associatedDomain` to fall back on.
    domainDn = `dc=reachrole,ou=domains,ou=nomenclature,${base}`;

    previousOrgSchema = process.env.DM_ORGANIZATION_SCHEMA;
    process.env.DM_ORGANIZATION_SCHEMA =
      './static/schemas/twake/organizations.json';
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/reachUsers.json',
      './test/fixtures/schemas/roleNamedDomains.json',
    ];

    for (const [dn, attrs] of [
      [
        domainDn,
        {
          objectClass: ['top', 'domain'],
          dc: 'reachrole',
          description: 'reachrole.example',
        },
      ],
      [
        orgDn,
        {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'ReachRoleOrg',
          twakeDepartmentPath: 'ReachRoleOrg',
          twakeDomainLink: domainDn,
        },
      ],
    ] as [string, AttributesList][])
      await server.ldap.add(dn, attrs).catch(() => undefined);

    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    for (let i = 0; i < 50 && !organizations.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const uid of ['reach.date', 'reach.inside', 'reach.outside'])
      await server.ldap
        .delete(`uid=${uid},ou=users,${base}`)
        .catch(() => undefined);
    for (const dn of [orgDn, domainDn])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousOrgSchema === undefined)
      delete process.env.DM_ORGANIZATION_SCHEMA;
    else process.env.DM_ORGANIZATION_SCHEMA = previousOrgSchema;
  });

  const create = (uid: string, mail: string) =>
    request
      .post('/api/v1/ldap/reachUsers')
      .type('json')
      .send({
        uid,
        cn: `Reach ${uid}`,
        sn: 'Reach',
        mail,
        twakeDepartmentLink: orgDn,
      });

  describe('a DN with a space after a comma', () => {
    before(async () => {
      const res = await create('reach.date', 'reach.date@reachrole.example');
      expect(res.status, JSON.stringify(res.body)).to.equal(201);
    });

    it('should be refused a past date, as the plain spelling is', async () => {
      const past = { replace: { twakeDeletionDate: '20200101000000Z' } };
      const plain = await request
        .put('/api/v1/ldap/reachUsers/reach.date')
        .type('json')
        .send(past);
      expect(plain.status, 'plain spelling').to.equal(400);

      const spaced = await request
        .put(
          `/api/v1/ldap/reachUsers/${encodeURIComponent(`uid=reach.date, ou=users,${base}`)}`
        )
        .type('json')
        .send(past);
      expect(spaced.status, JSON.stringify(spaced.body)).to.equal(400);
      expect(spaced.body.error).to.match(/not be earlier than today/);
    });
  });

  describe('a domain named through the domainName role', () => {
    it('should accept an address in that domain', async () => {
      const res = await create(
        'reach.inside',
        'reach.inside@reachrole.example'
      );
      expect(res.status, JSON.stringify(res.body)).to.equal(201);
    });

    it('should refuse an address outside it', async () => {
      const res = await create(
        'reach.outside',
        'reach.outside@elsewhere.example'
      );
      expect(res.status, JSON.stringify(res.body)).to.equal(409);
      expect(res.body.error).to.match(/reachrole\.example/);
    });
  });
});
