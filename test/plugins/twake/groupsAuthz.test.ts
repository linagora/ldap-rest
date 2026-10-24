/**
 * The organization group routes answer what the caller may know.
 *
 * They used to read the directory as the server: any caller the
 * authentication plugins let in listed another organization's groups and
 * their members' profiles, and could probe which names, users and
 * memberships exist there through the routes' answers. They read as the
 * caller, and judge a write before looking for anything.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import AuthzDynamic from '../../../src/plugins/auth/authzDynamic';
import { ssha } from '../../../src/plugins/auth/authzDynamicHash';
import TwakeGroups from '../../../src/plugins/twake/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

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

describe('Twake group routes and the caller', function () {
  // The outsider administers another organization; the reader may read
  // acme and write nothing; the admin may do everything
  const OUTSIDER = 'tgz.outsider';
  const READER = 'tgz.reader';
  const ADMIN = 'tgz.admin';
  // May read acme, but not its users, or not its groups
  const NO_USERS = 'tgz.nousers';
  // Manages acme's groups, and only reads the organization
  const MANAGER = 'tgz.manager';
  // Writes acme's groups, and reads none of its users
  const BLIND_MANAGER = 'tgz.blindmanager';
  const NO_GROUPS = 'tgz.nogroups';
  /** Writes the groups and reads none of them */
  const WRITE_ONLY = 'tgz.writeonly';
  let orgs: string;
  const orgDn = (org: string): string => `ou=${org},${orgs}`;
  const users = (org: string): string => `ou=users,${orgDn(org)}`;
  const groupBase = (org: string): string => `ou=groups,${orgDn(org)}`;
  const GROUP = 'tgz-group';
  const OTHER = 'tgz-other';
  const MEMBER = 'tgz-alice';
  let plain: DM;
  let request: ReturnType<typeof supertest>;
  const previous: Record<string, string | undefined> = {};

  const route = (org: string, rest = ''): string =>
    `/api/v1/organizations/${org}/groups${rest}`;
  const as = (user: string) => ({ 'X-Test-User': user });
  const linkOf = async (dn: string): Promise<unknown> =>
    (
      (await plain.ldap.search(
        { paged: false, scope: 'base', attributes: ['twakeDepartmentLink'] },
        dn
      )) as { searchEntries: Record<string, unknown>[] }
    ).searchEntries[0]?.twakeDepartmentLink;
  const ou = (dn: string, extra = {}): Promise<unknown> =>
    plain.ldap
      .add(dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
        ...extra,
      })
      .catch(() => undefined);

  /** The organization branches of the test, and plain groupOfNames attributes */
  const twakeConfig = (): Record<string, unknown> => ({
    twake_group_base: `ou=groups,ou={org},${orgs}`,
    twake_group_user_base: `ou=users,ou={org},${orgs}`,
    twake_group_organization_dn: `ou={org},${orgs}`,
    twake_group_organization_status_attribute: 'description',
    // groupOfNames attributes, so the test needs no extra schema
    twake_group_display_name_attribute: 'o',
    twake_group_color_attribute: 'businessCategory',
    twake_group_created_at_attribute: 'ou',
    twake_lifecycle_deleted_attribute: 'employeeType',
    twake_lifecycle_deleted_value: 'deleted',
    group_class: ['top', 'groupOfNames'],
    group_schema: '',
  });

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    orgs = `ou=tgz-orgs,${process.env.DM_LDAP_BASE}`;
    for (const k of [
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
    ])
      previous[k] = process.env[k];
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [OUTSIDER]: {
          [orgDn('mine')]: { read: true, write: true, delete: true },
        },
        [READER]: {
          [orgDn('acme')]: { read: true, write: false, delete: false },
        },
        [ADMIN]: { [orgs]: { read: true, write: true, delete: true } },
        // The narrower branch first: an entry below both takes the rule of
        // the first branch holding it
        [BLIND_MANAGER]: {
          [users('acme')]: { read: false, write: false, delete: false },
          [groupBase('acme')]: { read: true, write: true, delete: true },
          [orgDn('acme')]: { read: true, write: false, delete: false },
        },
        [MANAGER]: {
          [groupBase('acme')]: { read: true, write: true, delete: true },
          [orgDn('acme')]: { read: true, write: false, delete: false },
        },
        [NO_USERS]: {
          [users('acme')]: { read: false, write: false, delete: false },
          [orgDn('acme')]: { read: true, write: false, delete: false },
        },
        [WRITE_ONLY]: {
          [groupBase('acme')]: { read: false, write: true, delete: false },
          [orgDn('acme')]: { read: true, write: false, delete: false },
        },
        [NO_GROUPS]: {
          [groupBase('acme')]: { read: false, write: false, delete: false },
          [orgDn('acme')]: { read: true, write: false, delete: false },
        },
      },
      groups: {},
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';

    plain = new DM();
    await plain.ready;
    await ou(orgs);
    for (const org of ['acme', 'mine']) {
      await ou(orgDn(org));
      await ou(users(org));
      await ou(groupBase(org));
    }
    await ou(orgDn('gone'), { description: 'deleted' });
    await plain.ldap
      .add(`uid=${MEMBER},${users('acme')}`, {
        objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
        cn: MEMBER,
        sn: 'Doe',
        givenName: 'Alice',
        uid: MEMBER,
        mail: `${MEMBER}@acme.example.org`,
      })
      .catch(() => undefined);
    await plain.ldap
      .add(`cn=${GROUP},${groupBase('acme')}`, {
        objectClass: ['top', 'groupOfNames'],
        cn: GROUP,
        o: 'Taken name',
        member: `uid=${MEMBER},${users('acme')}`,
      })
      .catch(() => undefined);
    await plain.ldap
      .add(`cn=${OTHER},${groupBase('acme')}`, {
        objectClass: ['top', 'groupOfNames'],
        cn: OTHER,
        o: 'Other name',
        member: `uid=${MEMBER},${users('acme')}`,
      })
      .catch(() => undefined);

    const server = new DM();
    Object.assign(server.config, twakeConfig());
    await server.ready;
    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('core/twake/groups', new TwakeGroups(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    // Groups created by a test that went wrong, then the fixtures
    for (const org of ['acme', 'mine']) {
      try {
        const { searchEntries } = (await plain.ldap.search(
          { paged: false, scope: 'one', attributes: ['1.1'] },
          groupBase(org)
        )) as { searchEntries: { dn: string }[] };
        for (const { dn } of searchEntries)
          await plain.ldap.delete(dn).catch(() => undefined);
      } catch {
        /* not there */
      }
    }
    await plain.ldap
      .delete(`uid=${MEMBER},${users('acme')}`)
      .catch(() => undefined);
    for (const org of ['acme', 'mine'])
      for (const dn of [users(org), groupBase(org), orgDn(org)])
        await plain.ldap.delete(dn).catch(() => undefined);
    for (const dn of [orgDn('gone'), orgs])
      await plain.ldap.delete(dn).catch(() => undefined);
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  /** The answers, which must not tell one case from the other */
  const sameAnswers = (responses: supertest.Response[]): void => {
    expect(
      new Set(responses.map(r => `${r.status} ${JSON.stringify(r.body)}`)).size,
      responses.map(r => `${r.status} ${JSON.stringify(r.body)}`).join(' | ')
    ).to.equal(1);
  };

  it("answers another organization's routes as for one that is not there", async () => {
    for (const [method, rest, body] of [
      ['get', '', undefined],
      ['get', `/${GROUP}`, undefined],
      ['get', `/${GROUP}/members`, undefined],
      ['post', '', { name: 'Taken name' }],
      ['post', `/${GROUP}/members`, { usernames: [MEMBER] }],
    ] as [string, string, object | undefined][]) {
      const answers: supertest.Response[] = [];
      for (const org of ['acme', 'tgz-nowhere', 'gone']) {
        const call = (
          request as unknown as Record<string, (url: string) => supertest.Test>
        )
          [method](route(org, rest))
          .set(as(OUTSIDER));
        answers.push(await (body ? call.send(body) : call));
      }
      expect(answers[0].status, `${method} ${rest}`).to.equal(404);
      sameAnswers(answers);
    }
    // The admin is told the truth
    const gone = await request.get(route('gone')).set(as(ADMIN));
    expect(gone.status).to.equal(410);
    const listed = await request.get(route('acme')).set(as(ADMIN));
    expect(listed.body.groups.map((g: { id: string }) => g.id)).to.include(
      GROUP
    );
  });

  it('lets a reader of the organization read its groups and members', async () => {
    const group = await request.get(route('acme', `/${GROUP}`)).set(as(READER));
    expect(group.status, JSON.stringify(group.body)).to.equal(200);
    const members = await request
      .get(route('acme', `/${GROUP}/members`))
      .set(as(READER));
    expect(members.status).to.equal(200);
    expect(members.body.members[0]).to.include({ uid: MEMBER });
  });

  it('lists a member the caller cannot read by its uid only', async () => {
    const res = await request
      .get(route('acme', `/${GROUP}/members`))
      .set(as(NO_USERS));
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body.members).to.deep.equal([{ uid: MEMBER }]);
  });

  it('gives no group to a caller who cannot read them', async () => {
    const group = await request
      .get(route('acme', `/${GROUP}`))
      .set(as(NO_GROUPS));
    expect(group.status, JSON.stringify(group.body)).to.equal(404);
    const members = await request
      .get(route('acme', `/${GROUP}/members`))
      .set(as(NO_GROUPS));
    expect(members.status).to.equal(404);
    const list = await request.get(route('acme')).set(as(NO_GROUPS));
    expect(JSON.stringify(list.body)).to.not.include(GROUP);
  });

  it('refuses a reader a creation before saying the name is taken', async () => {
    sameAnswers([
      await request
        .post(route('acme'))
        .set(as(READER))
        .send({ name: 'Taken name' }),
      await request
        .post(route('acme'))
        .set(as(READER))
        .send({ name: 'Free name' }),
    ]);
    const taken = await request
      .post(route('acme'))
      .set(as(READER))
      .send({ name: 'Taken name' });
    expect(taken.status).to.equal(403);
    const admin = await request
      .post(route('acme'))
      .set(as(ADMIN))
      .send({ name: 'Taken name' });
    expect(admin.status).to.equal(409);
  });

  it('refuses a reader a rename before saying the name is taken', async () => {
    // Another group's name
    const res = await request
      .patch(route('acme', `/${OTHER}`))
      .set(as(READER))
      .send({ name: 'Taken name' });
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
    const admin = await request
      .patch(route('acme', `/${OTHER}`))
      .set(as(ADMIN))
      .send({ name: 'Taken name' });
    expect(admin.status).to.equal(409);
  });

  it('sees a name taken by a group the writer cannot read', async () => {
    // The uniqueness check is the server's: the whole branch, whoever asks
    const res = await request
      .patch(route('acme', `/${OTHER}`))
      .set(as(WRITE_ONLY))
      .send({ name: 'Taken name' });
    expect(res.status, JSON.stringify(res.body)).to.equal(409);
  });

  it('refuses a reader to add members, whether they are there or not', async () => {
    const answers: supertest.Response[] = [];
    for (const [cn, usernames] of [
      [GROUP, [MEMBER]],
      [GROUP, ['tgz-nobody']],
      ['tgz-nogroup', [MEMBER]],
    ] as [string, string[]][])
      answers.push(
        await request
          .post(route('acme', `/${cn}/members`))
          .set(as(READER))
          .send({ usernames })
      );
    expect(answers[0].status, JSON.stringify(answers[0].body)).to.equal(403);
    sameAnswers(answers);
  });
  it('tells a manager who cannot read the users none of them exists', async () => {
    const answers: supertest.Response[] = [];
    for (const user of [MEMBER, 'tgz-nobody'])
      answers.push(
        await request
          .post(route('acme', `/${OTHER}/members`))
          .set(as(BLIND_MANAGER))
          .send({ usernames: [user] })
      );
    expect(answers[0].status, JSON.stringify(answers[0].body)).to.equal(404);
    sameAnswers(answers);
    // Nothing added
    const group = await request.get(route('acme', `/${OTHER}`)).set(as(ADMIN));
    expect(group.body.members).to.deep.equal([MEMBER]);
  });

  it('leaves a group unlinked when no model judges by attachment, for a manager of the groups branch to create', async () => {
    const res = await request
      .post(route('acme'))
      .set(as(MANAGER))
      .send({ name: 'Managed group' });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect(
      await linkOf(`cn=${res.body.id},${groupBase('acme')}`)
    ).to.deep.equal([]);
  });

  // A model judging entries by their organization link: a group carrying
  // none would be every administrator's
  describe('judged by attachment', () => {
    let server: DM;
    let attached: ReturnType<typeof supertest>;

    before(async function () {
      this.timeout(20000);
      server = new DM();
      Object.assign(server.config, twakeConfig(), {
        authz_filter_attached_entries: true,
      });
      await server.ready;
      await server.registerPlugin('testAuth', new TestAuthPlugin(server));
      await server.registerPlugin('core/twake/groups', new TwakeGroups(server));
      await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
      server.setupErrorMiddleware();
      attached = supertest(server.app);
    });

    it('links a group made through the routes, and hides it from another organization', async () => {
      const created = await attached
        .post(route('acme'))
        .set(as(ADMIN))
        .send({ name: 'Linked group' });
      expect(created.status, JSON.stringify(created.body)).to.equal(201);
      const dn = `cn=${created.body.id},${groupBase('acme')}`;
      expect(await linkOf(dn)).to.equal(orgDn('acme'));

      const one = await attached
        .get(route('acme', `/${created.body.id}`))
        .set(as(OUTSIDER));
      expect(one.status, JSON.stringify(one.body)).to.equal(404);
      const list = await attached.get(route('acme')).set(as(OUTSIDER));
      expect(JSON.stringify(list.body)).to.not.include(created.body.id);
    });

    it('links a group written without the routes, and moves its link with it', async () => {
      const cn = 'tgz-hooked';
      const dn = `cn=${cn},${groupBase('acme')}`;
      await server.ldap.add(dn, {
        objectClass: ['top', 'groupOfNames'],
        cn,
        o: 'Hooked',
        member: `uid=${MEMBER},${users('acme')}`,
      });
      expect(await linkOf(dn)).to.equal(orgDn('acme'));

      const moved = `cn=${cn},${groupBase('mine')}`;
      await server.ldap.move(dn, moved);
      await waitFor(async () => (await linkOf(moved)) === orgDn('mine'), {
        what: 'the moved group to follow its organization',
      });
    });

    it('refuses to link a group elsewhere, or to unlink it', async () => {
      const dn = `cn=tgz-relinked,${groupBase('acme')}`;
      await server.ldap.add(dn, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'tgz-relinked',
        member: `uid=${MEMBER},${users('acme')}`,
      });
      for (const changes of [
        { replace: { twakeDepartmentLink: orgDn('mine') } },
        { delete: ['twakeDepartmentLink'] },
        { replace: { twakeDepartmentLink: [] } },
      ]) {
        let refused: unknown;
        await server.ldap.modify(dn, changes).catch(err => (refused = err));
        expect(
          (refused as { statusCode?: number })?.statusCode,
          JSON.stringify(changes)
        ).to.equal(400);
      }
      expect(await linkOf(dn)).to.equal(orgDn('acme'));
      // Its own organization, spelled otherwise, is no change of owner
      await server.ldap.modify(dn, {
        replace: { twakeDepartmentLink: orgDn('acme').toUpperCase() },
      });
    });

    it('refuses a group linked to another organization than its branch', async () => {
      let refused: unknown;
      await server.ldap
        .add(`cn=tgz-elsewhere,${groupBase('acme')}`, {
          objectClass: ['top', 'groupOfNames', 'twakeGroup'],
          cn: 'tgz-elsewhere',
          member: `uid=${MEMBER},${users('acme')}`,
          twakeDepartmentLink: orgDn('mine'),
        })
        .catch(err => (refused = err));
      expect((refused as { statusCode?: number })?.statusCode).to.equal(400);
    });
  });
  // A plugin judging every read made for the request, the server's own
  // included: creating a group must not need any read beyond the caller's
  describe('with a token of authzDynamic', () => {
    const TOKEN = 'tgz-token-value';
    let tokens: string;
    let dynamic: ReturnType<typeof supertest>;

    before(async function () {
      this.timeout(20000);
      tokens = `ou=tgz-tokens,${process.env.DM_LDAP_BASE}`;
      previous.DM_AUTHZ_DYNAMIC_BASE = process.env.DM_AUTHZ_DYNAMIC_BASE;
      process.env.DM_AUTHZ_DYNAMIC_BASE = tokens;
      await ou(tokens);
      await plain.ldap.delete(`cn=tgz-app,${tokens}`).catch(() => undefined);
      await plain.ldap.add(`cn=tgz-app,${tokens}`, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'tgz-app',
        sn: 'tgz-app',
        userPassword: ssha(TOKEN),
        description: JSON.stringify({
          tenant: 'tgz-app',
          bases: [{ dn: orgs, read: true, write: true, delete: true }],
        }),
      });
      const server = new DM();
      Object.assign(server.config, twakeConfig());
      await server.ready;
      const plugin = new AuthzDynamic(server);
      await server.registerPlugin('authzDynamic', plugin);
      await server.registerPlugin('core/twake/groups', new TwakeGroups(server));
      await plugin.reload();
      server.setupErrorMiddleware();
      dynamic = supertest(server.app);
    });

    after(async () => {
      await plain.ldap.delete(`cn=tgz-app,${tokens}`).catch(() => undefined);
      await plain.ldap.delete(tokens).catch(() => undefined);
    });

    it('creates a group', async () => {
      for (const name of ['Token group', 'Token group 2']) {
        const res = await dynamic
          .post(route('acme'))
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ name });
        expect(res.status, JSON.stringify(res.body)).to.equal(201);
      }
    });
  });
});
