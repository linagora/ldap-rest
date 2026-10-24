/**
 * A caller who may not make a write is refused before the route looks in
 * the directory as the server.
 *
 * These routes checked, before writing, whether an entry was there, which
 * organization held it, whether a pointer led somewhere — and answered
 * what they found: 404, 409, 400, even 200. The write itself was refused
 * later, if ever reached. A caller with no right learned, one request at a
 * time, what the directory holds where they cannot read. Judged first, they
 * get the same 403 whether the entry is there or not.
 *
 * The routes that find an entry across branches and then answer about it
 * (the James quota, the app accounts) answer 404 for an entry the caller
 * cannot read, as for one that is not there.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';
import nock from 'nock';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import ExternalUsersInGroups from '../../../src/plugins/ldap/externalUsersInGroups';
import TwakeTombstone from '../../../src/plugins/twake/tombstone';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import AppAccountsApi from '../../../src/plugins/twake/appAccountsApi';
import AppAccountsConsistency from '../../../src/plugins/twake/appAccountsConsistency';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

/** Authentication reduced to a header, so the test is about authorization */
class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-test-user'];
    if (typeof user === 'string' && user) {
      req.user = user;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  }
}

describe('Authorization before the checks that read the directory', function () {
  // The outsider administers an organization of their own, and nothing
  // else; the admin may do everything, so the route's own answers show.
  const OUTSIDER = 'abc.outsider';
  const ADMIN = 'abc.admin';
  const HOLDER = 'abc.holder';
  const GROUP = 'abc-group';
  let base: string;
  let users: string;
  let groups: string;
  let ownOrg: string;
  let otherOrg: string;
  let holderDn: string;
  let groupDn: string;
  let plain: DM;
  const previous: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    users = `ou=users,${base}`;
    groups = process.env.DM_LDAP_GROUP_BASE as string;
    // Under the top organization, where an organization link may point
    const top = process.env.DM_LDAP_TOP_ORGANIZATION || base;
    ownOrg = `ou=AbcOwnOrg,${top}`;
    otherOrg = `ou=AbcOtherOrg,${top}`;
    holderDn = `uid=${HOLDER},${users}`;
    groupDn = `cn=${GROUP},${groups}`;
    for (const k of [
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
    ])
      previous[k] = process.env[k];
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [OUTSIDER]: { [ownOrg]: { read: true, write: true, delete: true } },
        [ADMIN]: { [base]: { read: true, write: true, delete: true } },
      },
      groups: {},
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';

    // Setup and cleanup go through a server with no plugin
    plain = new DM();
    await plain.ready;
    for (const [dn, ou] of [
      [ownOrg, 'AbcOwnOrg'],
      [otherOrg, 'AbcOtherOrg'],
    ])
      await plain.ldap
        .add(dn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou,
          twakeDepartmentPath: ou,
        })
        .catch(() => undefined);
  });

  after(async () => {
    for (const dn of [ownOrg, otherOrg])
      await plain.ldap.delete(dn).catch(() => undefined);
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  // An account and a group of the other organization
  beforeEach(async () => {
    for (const dn of [groupDn, holderDn])
      await plain.ldap.delete(dn).catch(() => undefined);
    await plain.ldap.add(holderDn, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: HOLDER,
      cn: HOLDER,
      sn: 'Holder',
      givenName: 'Abc',
      displayName: 'Abc Holder',
      mail: `${HOLDER}@test.org`,
      employeeNumber: 'ABC001',
      twakeDepartmentLink: otherOrg,
      twakeDepartmentPath: 'AbcOtherOrg',
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
      twakeDeliveryMode: [
        `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
      ],
    });
    await plain.ldap.add(groupDn, {
      objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
      cn: GROUP,
      member: holderDn,
      twakeDepartmentLink: otherOrg,
      twakeDepartmentPath: 'AbcOtherOrg',
    });
  });

  afterEach(async () => {
    for (const dn of [groupDn, holderDn])
      await plain.ldap.delete(dn).catch(() => undefined);
  });

  const exists = async (dn: string): Promise<boolean> => {
    try {
      await plain.ldap.search(
        { paged: false, scope: 'base', attributes: ['1.1'] },
        dn
      );
      return true;
    } catch {
      return false;
    }
  };

  /** The refusals, which must not tell an entry there from one that is not */
  const sameAnswers = (bodies: unknown[]): void => {
    expect(new Set(bodies.map(body => JSON.stringify(body))).size).to.equal(1);
  };

  describe('writes', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    const external = () =>
      `mail=abc.probe@partner.org,${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;

    before(async function () {
      this.timeout(20000);
      server = new DM();
      await server.ready;
      Object.assign(server.config, {
        ldap_flat_schema: ['./static/schemas/twake/users.json'],
        group_schema: '',
        twake_lifecycle_deleted_attribute: 'employeeType',
        twake_lifecycle_deleted_value: 'deleted',
        twake_lifecycle_deleted_at_attribute: 'roomNumber',
        twake_tombstone_dn: [`^uid=[^,]+,${users}$`],
      });
      await server.registerPlugin('testAuth', new TestAuthPlugin(server));
      await server.registerPlugin(
        'ldapFlatGeneric',
        new LdapFlatGeneric(server)
      );
      await server.registerPlugin('ldapGroups', new LdapGroups(server));
      await server.registerPlugin(
        'externalUsersInGroups',
        new ExternalUsersInGroups(server)
      );
      await server.registerPlugin(
        'ldapOrganizations',
        new LdapOrganizations(server)
      );
      await server.registerPlugin(
        'core/twake/tombstone',
        new TwakeTombstone(server)
      );
      // Last: the judgement does not depend on the order plugins load in
      await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
      server.setupErrorMiddleware();
      request = supertest(server.app);
    });

    afterEach(async () => {
      await plain.ldap.delete(external()).catch(() => undefined);
    });

    const as = (user: string) => ({ 'X-Test-User': user });

    it('refuses a rename the same way whether the entry is there or not', async () => {
      const bodies: unknown[] = [];
      for (const id of [HOLDER, 'abc.nobody']) {
        const res = await request
          .post(`/api/v1/ldap/users/${id}/rename`)
          .set(as(OUTSIDER))
          .send({ newId: 'abc.renamed' });
        expect(res.status, `${id}: ${JSON.stringify(res.body)}`).to.equal(403);
        bodies.push(res.body);
      }
      sameAnswers(bodies);
      // Allowed, the caller gets the route's own answer
      const res = await request
        .post('/api/v1/ldap/users/abc.nobody/rename')
        .set(as(ADMIN))
        .send({ newId: 'abc.renamed' });
      expect(res.status).to.equal(404);
    });

    it('refuses a creation before saying where its pointer leads', async () => {
      const res = await request
        .post('/api/v1/ldap/users')
        .set(as(OUTSIDER))
        .send({
          givenName: 'Abc',
          sn: 'Probe',
          displayName: 'Abc Probe',
          mail: 'abc.probe@test.org',
          employeeNumber: 'ABC002',
          twakeDepartmentLink: `ou=AbcNowhere,${base}`,
        });
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
    });

    it('refuses a group move the same way whether the group is there or not', async () => {
      const bodies: unknown[] = [];
      for (const cn of [GROUP, 'abc-nogroup']) {
        const res = await request
          .post(`/api/v1/ldap/groups/${cn}/move`)
          .set(as(OUTSIDER))
          .send({ targetOrgDn: otherOrg });
        expect(res.status, `${cn}: ${JSON.stringify(res.body)}`).to.equal(403);
        bodies.push(res.body);
      }
      sameAnswers(bodies);
    });

    it('judges a group with the default attributes it is written with', async () => {
      // A default organization link puts every new group in the outsider's
      // organization: judged without it, the creation was refused
      const saved = server.config.group_default_attributes;
      const savedClass = server.config.group_class;
      server.config.group_default_attributes = { twakeDepartmentLink: ownOrg };
      // A class allowing the link, which a default does not bring
      server.config.group_class = ['top', 'groupOfNames', 'twakeStaticGroup'];
      try {
        const res = await request
          .post('/api/v1/ldap/groups')
          .set(as(OUTSIDER))
          .send({ cn: 'abc-defaultgroup' });
        expect(res.status, JSON.stringify(res.body)).to.be.within(200, 201);
      } finally {
        server.config.group_default_attributes = saved;
        server.config.group_class = savedClass;
        await plain.ldap
          .delete(`cn=abc-defaultgroup,${groups}`)
          .catch(() => undefined);
      }
    });

    it('creates no external member for a group the caller may not create', async () => {
      const res = await request
        .post('/api/v1/ldap/groups')
        .set(as(OUTSIDER))
        .send({ cn: 'abc-newgroup', member: [external()] });
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(await exists(external())).to.equal(false);
    });

    it('refuses an organization move the same way whether it is there or not', async () => {
      const bodies: unknown[] = [];
      for (const dn of [otherOrg, `ou=AbcNowhere,${base}`]) {
        const res = await request
          .post(`/api/v1/ldap/organizations/${encodeURIComponent(dn)}/move`)
          .set(as(OUTSIDER))
          .send({ targetOrgDn: ownOrg });
        expect(res.status, `${dn}: ${JSON.stringify(res.body)}`).to.equal(403);
        bodies.push(res.body);
      }
      sameAnswers(bodies);
    });

    it('refuses to erase a tombstone before saying whether there is one', async () => {
      const bodies: unknown[] = [];
      for (const dn of [holderDn, `uid=abc.nobody,${users}`]) {
        const res = await request
          .post('/api/v1/twake/tombstones/erase')
          .set(as(OUTSIDER))
          .send({ dn });
        expect(res.status, `${dn}: ${JSON.stringify(res.body)}`).to.equal(403);
        bodies.push(res.body);
      }
      sameAnswers(bodies);
      const res = await request
        .post('/api/v1/twake/tombstones/erase')
        .set(as(ADMIN))
        .send({ dn: holderDn });
      expect(res.status).to.equal(404);
    });
  });

  describe('reads across branches', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    const applicative = () => `ou=abcapplicative,${base}`;
    const webadmin =
      process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000';

    before(async function () {
      this.timeout(20000);
      await plain.ldap
        .add(applicative(), {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'abcapplicative',
        })
        .catch(() => undefined);
      server = new DM();
      await server.ready;
      Object.assign(server.config, {
        applicative_account_base: applicative(),
        mail_attribute: 'mail',
      });
      await server.registerPlugin('testAuth', new TestAuthPlugin(server));
      await server.registerPlugin('onLdapChange', new OnLdapChange(server));
      await server.registerPlugin('ldapGroups', new LdapGroups(server));
      await server.registerPlugin('james', new James(server));
      await server.registerPlugin(
        'appAccountsConsistency',
        new AppAccountsConsistency(server)
      );
      await server.registerPlugin('appAccountsApi', new AppAccountsApi(server));
      await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
      server.setupErrorMiddleware();
      request = supertest(server.app);
      nock.enableNetConnect('127.0.0.1');
      nock(webadmin)
        .persist()
        .get(`/quota/users/${HOLDER}@test.org`)
        .reply(200, { global: {}, user: { size: 1000 } });
    });

    after(async () => {
      nock.cleanAll();
      // Back to the default, which the files after this one rely on
      nock.enableNetConnect();
      await plain.ldap.delete(applicative()).catch(() => undefined);
    });

    it('answers a quota of an account the caller cannot read as of none', async () => {
      const res = await request
        .get(`/api/v1/users/${HOLDER}/quota-usage`)
        .set('X-Test-User', OUTSIDER)
        .set('Accept', 'application/json');
      expect(res.status, JSON.stringify(res.body)).to.equal(404);
      expect(res.body).to.not.have.property('user');

      const allowed = await request
        .get(`/api/v1/users/${HOLDER}/quota-usage`)
        .set('X-Test-User', ADMIN)
        .set('Accept', 'application/json');
      expect(allowed.status, JSON.stringify(allowed.body)).to.equal(200);
    });

    it('refuses to create or delete an app account before saying it is there', async () => {
      const created = await request
        .post(`/api/v1/users/${HOLDER}@test.org/app-accounts`)
        .set('X-Test-User', OUTSIDER)
        .set('Accept', 'application/json')
        .send({ name: 'probe' });
      expect(created.status, JSON.stringify(created.body)).to.equal(404);
      expect(created.body).to.not.have.property('pwd');

      const bodies: unknown[] = [];
      for (const uid of ['abc_test_org_c00000001', 'abc_nobody']) {
        const res = await request
          .delete(`/api/v1/users/${HOLDER}@test.org/app-accounts/${uid}`)
          .set('X-Test-User', OUTSIDER)
          .set('Accept', 'application/json');
        expect(res.status, `${uid}: ${JSON.stringify(res.body)}`).to.equal(403);
        bodies.push(res.body);
      }
      sameAnswers(bodies);
    });

    it('answers the app accounts of an account the caller cannot read as of none', async () => {
      const res = await request
        .get(`/api/v1/users/${HOLDER}@test.org/app-accounts`)
        .set('X-Test-User', OUTSIDER)
        .set('Accept', 'application/json');
      expect(res.status, JSON.stringify(res.body)).to.equal(404);

      const allowed = await request
        .get(`/api/v1/users/${HOLDER}@test.org/app-accounts`)
        .set('X-Test-User', ADMIN)
        .set('Accept', 'application/json');
      expect(allowed.status, JSON.stringify(allowed.body)).to.equal(200);
    });
  });
  describe('a generated identifier', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    let dir: string;

    // The Twake users schema, refusing a collision instead of suffixing it
    before(async function () {
      this.timeout(20000);
      const schema = JSON.parse(
        readFileSync('./static/schemas/twake/users.json', 'utf8')
      ) as { attributes: Record<string, { generatedFrom?: object }> };
      schema.attributes.uid.generatedFrom = {
        ...schema.attributes.uid.generatedFrom,
        onCollision: 'error',
      };
      dir = mkdtempSync(join(tmpdir(), 'abc-schema-'));
      writeFileSync(join(dir, 'users.json'), JSON.stringify(schema));
      server = new DM();
      await server.ready;
      server.config.ldap_flat_schema = [join(dir, 'users.json')];
      await server.registerPlugin('testAuth', new TestAuthPlugin(server));
      await server.registerPlugin(
        'ldapFlatGeneric',
        new LdapFlatGeneric(server)
      );
      await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
      server.setupErrorMiddleware();
      request = supertest(server.app);
    });

    after(() => rmSync(dir, { recursive: true, force: true }));

    const create = (user: string): Promise<supertest.Response> =>
      request
        .post('/api/v1/ldap/users')
        .set('X-Test-User', user)
        .send({
          givenName: 'Abc',
          sn: 'Probe',
          displayName: 'Abc Probe',
          // Derives the holder's uid
          mail: `${HOLDER}@other.test.org`,
          employeeNumber: 'ABC003',
          twakeDepartmentLink: otherOrg,
        });

    it('refuses a creation before saying the derived name is taken', async () => {
      const res = await create(OUTSIDER);
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      const allowed = await create(ADMIN);
      expect(allowed.status, JSON.stringify(allowed.body)).to.equal(409);
    });
  });
});
