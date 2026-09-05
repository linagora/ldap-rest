/**
 * Three rules that stopped applying quietly, each because of what they took
 * for granted about the deployment.
 *
 * A uniqueness constraint naming an extra branch used to have its own branch
 * *replaced* by it; a lifecycle date was compared against the server's local
 * midnight while the directory stores UTC; and the path of a new organization
 * was built from its parent even when that parent is the top organization
 * itself. The shipped schemas, a UTC server and a freshly seeded tree hide all
 * three — the directories this serves do not.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapEnterpriseRules, {
  parseDirectoryDate,
  startOfUtcDay,
} from '../../../src/plugins/ldap/enterpriseRules';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Enterprise rules: what the checks actually cover', function () {
  let base: string;
  let server: DM;
  let request: ReturnType<typeof supertest>;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    server = new DM();
    await server.ready;
    // A schema whose uniqueness names one neighbouring branch and nothing
    // else, which is what the constraint documents: an *extra* branch.
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/scopedUsers.json',
    ];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const uid of ['scoped.one', 'scoped.two', 'scoped.date'])
      await server.ldap
        .delete(`uid=${uid},ou=users,${base}`)
        .catch(() => undefined);
  });

  describe('uniqueness when the schema declares an extra branch', () => {
    const create = (uid: string, mail: string) =>
      request
        .post('/api/v1/ldap/scopedUsers')
        .type('json')
        .send({ uid, cn: `Scoped ${uid}`, sn: 'Scoped', mail });

    it("should still refuse a duplicate inside the entity's own branch", async () => {
      // The extra branch used to replace the entity's base, so the search
      // never looked where the entries live: both users were accepted with
      // the same address, and the constraint enforced nothing at all.
      const first = await create('scoped.one', 'scoped.shared@example.com');
      expect(first.status, JSON.stringify(first.body)).to.equal(201);
      const second = await create('scoped.two', 'scoped.shared@example.com');
      expect(second.status, JSON.stringify(second.body)).to.equal(409);
      expect(second.body.error).to.match(/already used/);
    });
  });

  describe('a lifecycle date on a server west of UTC', () => {
    let previousTz: string | undefined;
    const pad = (n: number): string => String(n).padStart(2, '0');
    // What the console stores for a day someone picked: a date, midnight UTC.
    const directoryDate = (day: Date): string =>
      `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}000000Z`;

    before(async () => {
      const res = await request
        .post('/api/v1/ldap/scopedUsers')
        .type('json')
        .send({
          uid: 'scoped.date',
          cn: 'Scoped Date',
          sn: 'Scoped',
          mail: 'scoped.date@example.com',
        });
      expect(res.status, JSON.stringify(res.body)).to.equal(201);
    });

    beforeEach(() => {
      previousTz = process.env.TZ;
      // Node reads TZ at every date operation, so the whole request runs as
      // if the server stood west of UTC — where local midnight comes *after*
      // the value the console stored for a date picked today. One hour is
      // enough, and small enough that the server is still on today's UTC date
      // whatever hour the suite runs at (except in the first hour of a UTC
      // day, where no offset west leaves the two dates equal and the old
      // comparison happened to be right).
      process.env.TZ = 'Etc/GMT+1';
    });

    afterEach(() => {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    });

    it('should take today from UTC, not from the local day', () => {
      const now = new Date('2026-09-05T18:00:00Z');
      const today = parseDirectoryDate('20260905000000Z') as Date;
      // What the comparison used to be on a server five hours west: local
      // midnight is 05:00 UTC, hours after the value the console stored.
      expect(today.getTime()).to.be.below(Date.parse('2026-09-05T05:00:00Z'));
      expect(today.getTime()).to.equal(startOfUtcDay(now));
      // The rule still means what it says: yesterday is in the past.
      const yesterday = parseDirectoryDate('20260904000000Z') as Date;
      expect(yesterday.getTime()).to.be.below(startOfUtcDay(now));
    });

    it('should accept the date a console stored for today', async () => {
      const res = await request
        .put('/api/v1/ldap/scopedUsers/scoped.date')
        .type('json')
        .send({ replace: { twakeDeletionDate: directoryDate(new Date()) } });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
    });

    it('should still refuse yesterday', async () => {
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
      const res = await request
        .put('/api/v1/ldap/scopedUsers/scoped.date')
        .type('json')
        .send({ replace: { twakeDeletionDate: directoryDate(yesterday) } });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/not be earlier than today/);
    });
  });

  describe('the path of an organization created under a migrated top', () => {
    let orgServer: DM;
    let orgRequest: ReturnType<typeof supertest>;
    let previousOrgSchema: string | undefined;
    let topDn: string;
    let childDn: string;

    before(async () => {
      topDn = `ou=MigratedTop,ou=organization,${base}`;
      childDn = `ou=MigratedChild,${topDn}`;
      previousOrgSchema = process.env.DM_ORGANIZATION_SCHEMA;
      process.env.DM_ORGANIZATION_SCHEMA =
        './static/schemas/twake/organizations.json';
      orgServer = new DM();
      await orgServer.ready;
      orgServer.config.ldap_top_organization = topDn;
      // A directory migrated from the old convention: the top organization
      // carries a path of its own, which no organization below it may repeat.
      await orgServer.ldap
        .add(topDn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'MigratedTop',
          twakeDepartmentPath: 'MigratedTop',
        })
        .catch(() => undefined);
      const organizations = new LdapOrganizations(orgServer);
      await orgServer.registerPlugin('ldapOrganizations', organizations);
      // The organization schema is read asynchronously, and the rules bind to
      // the entity only once it is there.
      for (let i = 0; i < 50 && !organizations.schema; i++)
        await new Promise(r => setTimeout(r, 100));
      await orgServer.registerPlugin(
        'ldapEnterpriseRules',
        new LdapEnterpriseRules(orgServer)
      );
      orgServer.setupErrorMiddleware();
      orgRequest = supertest(orgServer.app);
    });

    after(async () => {
      for (const dn of [childDn, topDn])
        await orgServer.ldap.delete(dn).catch(() => undefined);
      if (previousOrgSchema === undefined)
        delete process.env.DM_ORGANIZATION_SCHEMA;
      else process.env.DM_ORGANIZATION_SCHEMA = previousOrgSchema;
    });

    it("should not start with the top organization's own name", async () => {
      const res = await orgRequest
        .post('/api/v1/ldap/organizations')
        .type('json')
        .send({ ou: 'MigratedChild', parentDn: topDn });
      expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);
      const stored = (await orgServer.ldap.search(
        { paged: false, scope: 'base', filter: '(objectClass=*)' },
        childDn
      )) as { searchEntries: Record<string, unknown>[] };
      expect(stored.searchEntries[0]).to.have.property(
        'twakeDepartmentPath',
        'MigratedChild'
      );
    });
  });
});
