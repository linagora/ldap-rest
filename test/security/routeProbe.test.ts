/**
 * What every route tells a caller without rights (#386).
 *
 * The disclosures fixed in #381, #383 and #384 were found one route at a
 * time: a route checking the directory as the server, then answering what
 * it found, or returning data it read as the server. This walks every route
 * the server registers, with a representative configuration, as a caller
 * administering another organization only, under each authorization model:
 *
 * - a route naming a target is called on one that exists where the caller
 *   holds nothing, and on one that does not exist: both answers must be the
 *   same, status and body, the names asked for aside;
 * - no answer, listings included, may carry what was read from the
 *   targets: their secret marker.
 *
 * Bulk import names its targets in the rows of a file, not in a path: its
 * routes are listed here, and its rows probed by `bulkImportAuthz`.
 *
 * An administrator holding everything is probed too, and must see the
 * difference: the probe does find one where there is one.
 *
 * A route answering differently on purpose is listed in the model's
 * `allowed`, with its reason. A route this test cannot place fails, so that
 * a new one is looked at.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../src/bin';
import AuthBase, { type DmRequest } from '../../src/lib/auth/base';
import type DmPlugin from '../../src/abstract/plugin';
import type { Role } from '../../src/abstract/plugin';
import type { SearchResult } from '../../src/lib/ldapActions';
import AuthzPerBranch from '../../src/plugins/auth/authzPerBranch';
import AuthzLinid1 from '../../src/plugins/auth/authzLinid1';
import AuthzScope from '../../src/plugins/auth/authzScope';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapOrganizations from '../../src/plugins/ldap/organizations';
import LdapGroups from '../../src/plugins/ldap/groups';
import LdapBulkImport from '../../src/plugins/ldap/bulkImport';
import LdapAccountLifecycle from '../../src/plugins/ldap/accountLifecycle';
import LdapPasswordPolicy from '../../src/plugins/ldap/passwordPolicy';
import LdapRaw from '../../src/plugins/ldap/raw';
import OnLdapChange from '../../src/plugins/ldap/onChange';
import Scim from '../../src/plugins/scim/scim';
import TwakeGroups from '../../src/plugins/twake/groups';
import TwakeSpaces from '../../src/plugins/twake/spaces';
import AppAccountsConsistency from '../../src/plugins/twake/appAccountsConsistency';
import AppAccountsApi from '../../src/plugins/twake/appAccountsApi';
import James from '../../src/plugins/twake/james';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';

/** Authentication reduced to a header */
class TestAuth extends AuthBase {
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

const ADMIN = 'probe.admin';
const CALLER = 'probe.caller';
/** In every value the targets carry that the caller must never read */
const SECRET = 'probesecret';

/** The two values of a route parameter: a target there, one not there */
interface Pair {
  there: string;
  absent: string;
}

/** An authorization model, as the probe needs it */
interface Model {
  name: string;
  plugin: new (server: DM) => DmPlugin;
  /** Environment configuring it, given the parent of the organizations */
  env: (orgs: string, base: string) => Record<string, string>;
  /** Routes answering otherwise under it on purpose: `METHOD path` → why */
  allowed: Record<string, string>;
  /**
   * Whether every administrator reads which organizations exist: the
   * organization routes are then probed in one that exists, on what it
   * holds.
   */
  publicOrganizations?: boolean;
}

const MODELS: Model[] = [
  {
    name: 'authzPerBranch',
    plugin: AuthzPerBranch,
    env: (orgs, base) => ({
      DM_AUTHZ_PER_BRANCH_CONFIG: JSON.stringify({
        default: { read: false, write: false, delete: false },
        users: {
          [ADMIN]: { [base]: { read: true, write: true, delete: true } },
          [CALLER]: {
            [`ou=probemine,${orgs}`]: { read: true, write: true, delete: true },
          },
        },
        groups: {},
      }),
      DM_AUTHZ_PER_BRANCH_CACHE_TTL: '60',
    }),
    allowed: {},
  },
  {
    name: 'authzLinid1',
    plugin: AuthzLinid1,
    env: () => ({}),
    publicOrganizations: true,
    allowed: {
      // What carries no link is in transit, every administrator's (#387):
      // the organizations, their spaces, the password policies
      ...Object.fromEntries(
        [
          'GET /api/v1/ldap/organizations/:dn',
          'GET /api/v1/ldap/organizations/:dn/subnodes',
          'GET /api/v1/ldap/organizations/:dn/subnodes/search',
          'GET /api/v1/ldap/organizations/:dn/search',
        ].map(route => [
          route,
          'an organization carries no link: every administrator reads it',
        ])
      ),
      ...Object.fromEntries(
        [
          'GET /api/v1/organizations/:id/spaces/:spaceId',
          'GET /api/v1/organizations/:id/spaces/:spaceId/members',
          'GET /api/v1/organizations/:id/spaces/:spaceId/groups',
          'PATCH /api/v1/organizations/:id/spaces/:spaceId',
          'DELETE /api/v1/organizations/:id/spaces/:spaceId',
          'POST /api/v1/organizations/:id/spaces/:spaceId/members',
          'PATCH /api/v1/organizations/:id/spaces/:spaceId/members/:userId',
          'DELETE /api/v1/organizations/:id/spaces/:spaceId/members/:userId',
          'POST /api/v1/organizations/:id/spaces/:spaceId/groups',
          'PATCH /api/v1/organizations/:id/spaces/:spaceId/groups/:groupId',
          'DELETE /api/v1/organizations/:id/spaces/:spaceId/groups/:groupId',
        ].map(route => [
          route,
          'a space carries no link: every administrator reads it',
        ])
      ),
      ...Object.fromEntries(
        [
          'GET /api/v1/password-policies/:cn',
          'PATCH /api/v1/password-policies/:cn',
          'DELETE /api/v1/password-policies/:cn',
        ].map(route => [
          route,
          'a password policy carries no link: every administrator reads it',
        ])
      ),
    },
  },
];

for (const model of MODELS)
  describe(`What every route tells a caller without rights, under ${model.name}`, function () {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    let base: string;
    let orgs: string;
    const previous: Record<string, string | undefined> = {};
    const ENV = [
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
      'DM_LDAP_FLAT_SCHEMA',
      'DM_TWAKE_GROUP_BASE',
      'DM_TWAKE_GROUP_USER_BASE',
      'DM_TWAKE_GROUP_ORGANIZATION_DN',
      'DM_TWAKE_SPACE_BASE',
      'DM_APPLICATIVE_ACCOUNT_BASE',
      'DM_AUTHZ_GLOBAL_ORGANIZATION',
      'DM_BULK_IMPORT_SCHEMAS',
    ];
    let dir: string;

    let params: (path: string) => Record<string, Pair> | null;
    let spaceId: string | undefined;

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    });

    before(async function () {
      this.timeout(60000);
      base = process.env.DM_LDAP_BASE as string;
      const top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
      orgs = `ou=probeorgs,${top}`;
      const org = (name: string): string => `ou=${name},${orgs}`;
      const theirs = org('probetheirs');
      for (const k of ENV) previous[k] = process.env[k];
      dir = mkdtempSync(join(tmpdir(), 'probe-'));
      const bulkSchema = join(dir, 'users.json');
      writeFileSync(
        bulkSchema,
        JSON.stringify({
          base: `ou=users,${base}`,
          mainAttribute: 'uid',
          properties: {
            objectClass: {
              type: 'array',
              fixed: true,
              default: ['top', 'inetOrgPerson', 'twakeWhitePages'],
            },
            uid: { type: 'string', required: true },
            cn: { type: 'string', required: true },
            sn: { type: 'string', required: true },
            twakeDepartmentLink: {
              type: 'string',
              role: ['organizationLink'],
            },
          },
        })
      );
      Object.assign(process.env, {
        DM_BULK_IMPORT_SCHEMAS: `users:${bulkSchema}`,
        ...model.env(orgs, base),
        DM_LDAP_FLAT_SCHEMA:
          './static/schemas/twake/users.json,./static/schemas/example/positions.json',
        DM_TWAKE_GROUP_BASE: `ou=groups,ou={org},${orgs}`,
        DM_TWAKE_GROUP_USER_BASE: `ou=users,ou={org},${orgs}`,
        DM_TWAKE_GROUP_ORGANIZATION_DN: `ou={org},${orgs}`,
        DM_TWAKE_SPACE_BASE: `ou=spaces,ou={org},${orgs}`,
        DM_APPLICATIVE_ACCOUNT_BASE: `ou=probeapplicative,${base}`,
        DM_AUTHZ_GLOBAL_ORGANIZATION: orgs,
      });

      server = new DM();
      await server.ready;
      await wipe();
      const add = (dn: string, entry: Record<string, unknown>) =>
        server.ldap.add(dn, entry as never);
      const department = (dn: string, admins: string[]) =>
        add(dn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: /^ou=([^,]+)/.exec(dn)![1],
          twakeDepartmentPath: /^ou=([^,]+)/.exec(dn)![1],
          ...(admins.length ? { twakeLocalAdminLink: admins } : {}),
        });
      const ou = (dn: string) =>
        add(dn, {
          objectClass: ['top', 'organizationalUnit'],
          ou: /^ou=([^,]+)/.exec(dn)![1],
        });
      const person = (uid: string, at: string, link: string, secret = true) =>
        add(`uid=${uid},${at}`, {
          objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
          uid,
          cn: secret ? `Probe ${SECRET} ${uid}` : uid,
          sn: secret ? SECRET : uid,
          ...(secret ? { mail: `${uid}@${SECRET}.example` } : {}),
          twakeDepartmentLink: link,
        });

      // The callers, as the models that resolve them read them
      const adminDn = `uid=${ADMIN},ou=users,${base}`;
      const callerDn = `uid=${CALLER},ou=users,${base}`;
      await ou(`ou=probeapplicative,${base}`);
      await department(orgs, [adminDn]);
      await department(org('probemine'), [callerDn]);
      await department(theirs, []);
      for (const name of ['probemine', 'probetheirs'])
        for (const sub of ['users', 'groups', 'spaces'])
          await ou(`ou=${sub},${org(name)}`);
      await person(ADMIN, `ou=users,${base}`, orgs, false);
      await person(CALLER, `ou=users,${base}`, org('probemine'), false);

      // Targets in the shared branches, attached to the other organization
      await person('probe-them', `ou=users,${base}`, theirs);
      await add(`cn=probe-them-group,ou=groups,${base}`, {
        objectClass: ['top', 'twakeStaticGroup'],
        cn: 'probe-them-group',
        member: [`uid=probe-them,ou=users,${base}`],
        description: SECRET,
        twakeDepartmentLink: theirs,
      });
      // And in the other organization's own branches
      await person('probe-tuser', `ou=users,${theirs}`, theirs);
      await add(`cn=probe-tgroup,ou=groups,${theirs}`, {
        objectClass: ['top', 'twakeStaticGroup'],
        cn: 'probe-tgroup',
        o: `Probe ${SECRET} Group`,
        member: [`uid=probe-tuser,ou=users,${theirs}`],
        twakeDepartmentLink: theirs,
      });

      for (const [name, Plugin] of [
        ['testAuth', TestAuth],
        [model.name, model.plugin],
        ['authzScope', AuthzScope],
        ['onLdapChange', OnLdapChange],
        ['ldapFlatGeneric', LdapFlatGeneric],
        ['ldapOrganizations', LdapOrganizations],
        ['ldapGroups', LdapGroups],
        ['ldapBulkImport', LdapBulkImport],
        ['ldapAccountLifecycle', LdapAccountLifecycle],
        ['ldapPasswordPolicy', LdapPasswordPolicy],
        ['ldapRaw', LdapRaw],
        ['scim', Scim],
        ['twakeGroups', TwakeGroups],
        ['twakeSpaces', TwakeSpaces],
        ['appAccountsConsistency', AppAccountsConsistency],
        ['appAccountsApi', AppAccountsApi],
        ['james', James],
      ] as [string, new (s: DM) => DmPlugin][])
        await server.registerPlugin(name, new Plugin(server));
      server.setupErrorMiddleware();
      request = supertest(server.app);

      // Through the routes, as the administrator: the plugins' own formats.
      // A space carries no link, so it holds no secret: under a model
      // judging by link, its name is every administrator's to read.
      const admin = (path: string, body: object) =>
        request.post(path).set('X-Test-User', ADMIN).type('json').send(body);
      await admin('/api/v1/password-policies', {
        cn: 'probepolicy',
        pwdMinLength: 8,
      });
      const space = await admin('/api/v1/organizations/probetheirs/spaces', {
        name: 'Probe space',
        members: [{ username: 'probe-tuser', role: 'admin' }],
      });
      spaceId = (space.body as { id?: string }).id;

      const dnPair = (there: string): Pair => ({
        there,
        absent: there.replace(/^([a-z]+)=[^,]+/i, '$1=probe-absent'),
      });
      const user = { there: 'probe-them', absent: 'probe-absent' };
      const group = { there: 'probe-them-group', absent: 'probe-absent' };
      params = (path): Record<string, Pair> | null => {
        // A description of the API, which names no entry
        if (/^\/scim\/v2\/(ResourceTypes|Schemas)\/:/.test(path)) return {};
        if (path.startsWith('/api/v1/password-policies/:cn'))
          return { cn: { there: 'probepolicy', absent: 'probe-absent' } };
        if (path.startsWith('/api/v1/organizations/:id'))
          return {
            id: {
              there: 'probetheirs',
              absent: model.publicOrganizations ? 'probetheirs' : 'probeabsent',
            },
            groupId: { there: 'probe-tgroup', absent: 'probe-absent' },
            spaceId: {
              there: spaceId ?? 'probe-tspace',
              absent: 'probe-absent',
            },
            userId: { there: 'probe-tuser', absent: 'probe-absent' },
          };
        if (path.startsWith('/api/v1/ldap/organizations/:dn'))
          return { dn: dnPair(theirs) };
        if (path.startsWith('/api/v1/ldap/raw/'))
          return { dn: dnPair(`uid=probe-them,ou=users,${base}`) };
        if (path.startsWith('/api/v1/ldap/groups/:cn'))
          return {
            cn: group,
            member: dnPair(`uid=probe-them,ou=users,${base}`),
          };
        if (path.startsWith('/api/v1/ldap/users/:id')) return { id: user };
        if (path.startsWith('/api/v1/ldap/positions/:id'))
          return { id: { there: 'probe-them', absent: 'probe-absent' } };
        if (path.startsWith('/api/v1/users/:id')) return { id: user };
        if (path.startsWith('/api/v1/users/:user'))
          return {
            user,
            uid: { there: 'probe-them', absent: 'probe-absent' },
          };
        if (path.startsWith('/scim/v2/Users/:id')) return { id: user };
        if (path.startsWith('/scim/v2/Groups/:id')) return { id: group };
        return null;
      };
    });

    /** Everything this test wrote: the probe tree, and the entries named */
    const wipe = async (): Promise<void> => {
      const doomed: string[] = [];
      for (const branch of [orgs, `ou=probeapplicative,${base}`])
        try {
          const found = (await server.ldap.search(
            { paged: false, scope: 'sub', attributes: ['1.1'] },
            branch
          )) as SearchResult;
          doomed.push(...found.searchEntries.map(e => String(e.dn)));
        } catch {
          // Not there
        }
      doomed.push(
        `uid=probe-them,ou=users,${base}`,
        `cn=probe-them-group,ou=groups,${base}`,
        `uid=${ADMIN},ou=users,${base}`,
        `uid=${CALLER},ou=users,${base}`,
        `cn=probepolicy,${base}`
      );
      // The deepest first
      doomed.sort((a, b) => b.split(',').length - a.split(',').length);
      for (const dn of doomed)
        await server.ldap.delete(dn).catch(() => undefined);
    };

    after(async () => {
      await wipe();
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(previous))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    });

    /** Every registered route, as `METHOD path` */
    const routes = (): [string, string][] => {
      const stack =
        (
          server.app as unknown as {
            router?: {
              stack: {
                route?: { path: string; methods: Record<string, boolean> };
              }[];
            };
          }
        ).router?.stack ?? [];
      const out: [string, string][] = [];
      for (const layer of stack)
        if (layer.route)
          for (const method of Object.keys(layer.route.methods))
            out.push([method.toUpperCase(), layer.route.path]);
      return out;
    };

    /** A plausible body, so the call gets past the shape checks */
    const bodyFor = (method: string, path: string): unknown => {
      if (method === 'GET' || method === 'DELETE') return undefined;
      if (path.startsWith('/scim/'))
        return method === 'PATCH'
          ? {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
              Operations: [{ op: 'replace', path: 'displayName', value: 'x' }],
            }
          : {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName: 'probe-them',
              displayName: 'x',
            };
      if (path.endsWith('/status')) return { state: 'disabled' };
      if (path.endsWith('/password')) return { password: 'Probe-Passw0rd!' };
      if (path.endsWith('/password-policy')) return { policy: 'probepolicy' };
      if (path.endsWith('/unlock')) return {};
      if (path.endsWith('/move'))
        return { targetOrgDn: `ou=probemine,${orgs}` };
      if (path.startsWith('/api/v1/ldap/groups/:cn/rename'))
        return { newCn: 'probe-renamed' };
      if (path.endsWith('/rename')) return { newId: 'probe-renamed' };
      if (path.startsWith('/api/v1/ldap/groups/:cn/members'))
        return { member: [`uid=probe-them,ou=users,${base}`] };
      if (
        path.endsWith('/members/:userId') ||
        path.endsWith('/groups/:groupId')
      )
        return path.includes('/spaces') ? { role: 'viewer' } : { name: 'x' };
      if (path.endsWith('/members'))
        return { usernames: ['probe-tuser'], role: 'viewer' };
      if (path.endsWith('/spaces/:spaceId/groups'))
        return { groupIds: ['probe-tgroup'], role: 'viewer' };
      if (path.endsWith('/spaces'))
        return {
          name: 'probe-name',
          members: [{ username: 'probe-tuser', role: 'admin' }],
        };
      if (path.startsWith('/api/v1/organizations/'))
        return { name: 'probe-name' };
      if (path.startsWith('/api/v1/password-policies/'))
        return { pwdMinLength: 10 };
      if (method === 'PUT' || method === 'PATCH')
        return { replace: { description: 'x' } };
      return { name: 'probe-name', description: 'x' };
    };

    const fill = (path: string, values: Record<string, string>): string =>
      path.replace(/:([A-Za-z]+)/g, (_m, name: string) =>
        encodeURIComponent(values[name] ?? `probe-${name}`)
      ) + (path.endsWith('/search') ? '?q=probe' : '');

    /** An answer with the names asked for taken out */
    const neutral = (
      res: supertest.Response,
      asked: Record<string, string>
    ): string => {
      let text = JSON.stringify({ status: res.status, body: res.body });
      for (const value of Object.values(asked).sort(
        (a, b) => b.length - a.length
      ))
        text = text.split(value).join('<asked>');
      return text;
    };

    const call = (
      method: string,
      path: string,
      body: unknown,
      who = CALLER
    ): Promise<supertest.Response> => {
      const verb = method.toLowerCase() as 'get';
      const req = request[verb](path).set('X-Test-User', who);
      return (
        body === undefined ? req : req.type('json').send(body as object)
      ) as never;
    };

    /**
     * Call every route naming a target twice as `who`, on a target there and
     * on one that is not: the routes answering differently, and the ones
     * this test cannot place.
     *
     * @param who the caller
     * @param only the methods to call
     */
    const probe = async (
      who: string,
      only?: string[]
    ): Promise<{ differing: string[]; unplaced: string[] }> => {
      const differing: string[] = [];
      const unplaced: string[] = [];
      for (const [method, path] of routes()) {
        if (!path.includes(':')) continue;
        if (only && !only.includes(method)) continue;
        const key = `${method} ${path}`;
        if (who === CALLER && model.allowed[key]) continue;
        const pairs = params(path);
        if (!pairs) {
          unplaced.push(key);
          continue;
        }
        const there = Object.fromEntries(
          Object.entries(pairs).map(([k, v]) => [k, v.there])
        );
        const absent = Object.fromEntries(
          Object.entries(pairs).map(([k, v]) => [k, v.absent])
        );
        const body = bodyFor(method, path);
        const a = await call(method, fill(path, there), body, who);
        const b = await call(method, fill(path, absent), body, who);
        const left = neutral(a, there);
        const right = neutral(b, absent);
        if (left !== right)
          differing.push(`${key}\n    there:  ${left}\n    absent: ${right}`);
        else if (String(JSON.stringify(a.body)).includes(SECRET))
          differing.push(`${key} answered a secret: ${JSON.stringify(a.body)}`);
      }
      return { differing, unplaced };
    };

    it('tells the targets apart for a caller who may read them', async function () {
      // The probe sees a difference where there is one: an administrator
      // reading the targets gets them, and a 404 for the others
      this.timeout(120000);
      const { differing } = await probe(ADMIN, ['GET']);
      for (const route of [
        'GET /api/v1/ldap/users/:id',
        'GET /api/v1/ldap/groups/:cn',
        'GET /api/v1/ldap/raw/entry/:dn',
        'GET /api/v1/organizations/:id/groups/:groupId',
      ])
        expect(
          differing.some(line => line.startsWith(`${route}\n`)),
          route
        ).to.equal(true);
    });

    it('answers alike whether a target it may not touch is there or not', async function () {
      this.timeout(120000);
      const { differing, unplaced } = await probe(CALLER);
      expect(unplaced, 'routes this test cannot place').to.deep.equal([]);
      expect(differing, differing.join('\n')).to.deep.equal([]);
    });

    /** A search asks for the targets, under the whole tree */
    const listQuery = (path: string): string =>
      path === '/api/v1/ldap/raw/search'
        ? `?base=${encodeURIComponent(base)}&scope=sub&filter=${encodeURIComponent('(uid=probe-*)')}`
        : '';

    it('lists the targets to a caller who may read them', async () => {
      const path = '/api/v1/ldap/raw/search';
      const res = await call('GET', path + listQuery(path), undefined, ADMIN);
      expect(String(JSON.stringify(res.body))).to.include(SECRET);
    });

    it('answers no listing with what it may not read', async function () {
      this.timeout(60000);
      const leaking: string[] = [];
      for (const [method, path] of routes()) {
        if (method !== 'GET' || path.includes(':')) continue;
        const res = await call(method, path + listQuery(path), undefined);
        if (String(JSON.stringify(res.body)).includes(SECRET))
          leaking.push(
            `${method} ${path}: ${JSON.stringify(res.body).slice(0, 300)}`
          );
      }
      expect(leaking, leaking.join('\n')).to.deep.equal([]);
    });
  });
