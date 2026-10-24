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
 * The targets a body or a query names — a member, a destination, a name to
 * be taken, the base of a search — are probed the same way, on a route the
 * caller may use, with what it holds in the path (#396). Bulk import names
 * its targets in the rows of a file: its routes are listed here, and its
 * rows probed by `bulkImportAuthz`.
 *
 * The models: `authzDynamic` and `authzPerBranch` judging by branch,
 * `authzLinid1` and `authzPerBranch` judging by attachment.
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
import AuthzDynamic from '../../src/plugins/auth/authzDynamic';
import { ssha } from '../../src/plugins/auth/authzDynamicHash';
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
import LdapEnterpriseRules from '../../src/plugins/ldap/enterpriseRules';
import ExternalUsersInGroups from '../../src/plugins/ldap/externalUsersInGroups';
import TwakeTombstone from '../../src/plugins/twake/tombstone';
import TwakeInstances from '../../src/plugins/twake/instances';
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

/** A broker that takes every message, for the plugins requiring one */
class StubRabbitMq {
  name = 'rabbitmq';
  getRawClient(): Promise<unknown> {
    return Promise.resolve({});
  }
  subscribe(): Promise<void> {
    return Promise.resolve();
  }
  publish(): Promise<void> {
    return Promise.resolve();
  }
}

const ADMIN = 'probe.admin';
const CALLER = 'probe.caller';
/** In every value the targets carry that the caller must never read */
const SECRET = 'probesecret';

/** What names the targets: no listing may carry any of it */
const TARGETS = [
  SECRET,
  'probe-them',
  'probe-tuser',
  'probe-tgroup',
  'probe-them-group',
  'probe-position',
  'probe-slodger',
  'probe-slgroup',
];

/**
 * Routes whose probe stops at the shape of the call, the target unread:
 * `METHOD path` → why.
 */
const UNEXERCISED: Record<string, string> = {
  'POST /api/v1/ldap/positions/:id/move':
    'positions carry no organization link: they are never moved',
};

/**
 * Writes naming no target in their path, nor one this test carries in their
 * body: `METHOD path` → why.
 */
const NO_TARGET: Record<string, string> = {
  'POST /api/v1/ldap/bulk-import/users':
    'its targets are in the rows of a file: bulkImportAuthz probes them',
  'POST /api/v1/ldap/positions':
    'the body names the entry it creates only: its name is taken whoever may read it, as for an account',
  'POST /api/v1/password-policies':
    'the body names the entry it creates only: its name is taken whoever may read it, as for an account',
  'POST /scim/v2/Users':
    'the body names the entry it creates only: its name is taken whoever may read it, as for an account',
  'POST /scim/v2/Groups':
    'its members are resolved as those of a group replaced, which is probed',
  'POST /scim/v2/Bulk':
    'each operation is that of a SCIM route, probed on its own',
};

/** The two values of a route parameter: a target there, one not there */
interface Pair {
  there: string;
  absent: string;
}

/** An authorization model, as the probe needs it */
interface Model {
  /** The plugin's name, under which it is registered */
  name: string;
  /** How the suite names the model */
  label?: string;
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
  /**
   * The plugin authenticates its callers itself, by a token: each caller's
   * token, and the branch it grants
   */
  tokens?: Record<
    string,
    { token: string; branch: (orgs: string, base: string) => string }
  >;
  /**
   * A grant holds its whole branch: no narrower rule hides part of it from
   * the caller
   */
  wholeBranch?: boolean;
  /**
   * The caller reads an organization it does not write: its routes are
   * probed inside it too, on what a narrower rule hides
   */
  readOnlyOrg?: boolean;
}

/** Where the caller's organization lodges what it may not read */
const lodger = (orgs: string): string =>
  `uid=probe-lodger,ou=users,ou=probemine,${orgs}`;
const lodgerGroup = (orgs: string): string =>
  `cn=probe-lgroup,ou=groups,ou=probemine,${orgs}`;
/** What the organization the caller only reads holds, hidden from it */
const seenLodger = (orgs: string): string =>
  `uid=probe-slodger,ou=users,ou=probeseen,${orgs}`;
const seenGroup = (orgs: string): string =>
  `cn=probe-slgroup,ou=groups,ou=probeseen,${orgs}`;

/**
 * Judged by attachment, what carries no link is in transit, every
 * administrator's to read (#387): the organizations, their spaces, the
 * password policies. That they exist may differ; a write must still be
 * refused, and no secret answered.
 */
const TRANSIT_ALLOWED: Record<string, string> = {
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
      'a space carries no link: every administrator reads it, its members’ usernames included',
    ])
  ),
  ...Object.fromEntries(
    ['GET /api/v1/ldap/positions/:id'].map(route => [
      route,
      'a position is a nomenclature value: every administrator reads it',
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
};

const MODELS: Model[] = [
  {
    name: 'authzDynamic',
    plugin: AuthzDynamic,
    env: (_orgs, base) => ({
      DM_AUTHZ_DYNAMIC_BASE: `ou=probetokens,${base}`,
      DM_AUTHZ_DYNAMIC_CACHE_TTL: '60',
    }),
    allowed: {},
    wholeBranch: true,
    tokens: {
      [ADMIN]: { token: 'probe-admin-token', branch: (_orgs, base) => base },
      [CALLER]: {
        token: 'probe-caller-token',
        branch: orgs => `ou=probemine,${orgs}`,
      },
    },
  },
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
            // Read, not written
            [`ou=probeseen,${orgs}`]: {
              read: true,
              write: false,
              delete: false,
            },
            // Lodged in the caller's branches, refused by a narrower rule
            ...Object.fromEntries(
              [
                lodger(orgs),
                lodgerGroup(orgs),
                seenLodger(orgs),
                seenGroup(orgs),
              ].map(dn => [dn, { read: false, write: false, delete: false }])
            ),
          },
        },
        groups: {},
      }),
      DM_AUTHZ_PER_BRANCH_CACHE_TTL: '60',
    }),
    allowed: {},
    readOnlyOrg: true,
  },
  {
    name: 'authzLinid1',
    plugin: AuthzLinid1,
    env: () => ({}),
    publicOrganizations: true,
    allowed: TRANSIT_ALLOWED,
  },
  {
    name: 'authzPerBranch',
    label: 'authzPerBranch, judging by attachment',
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
      DM_AUTHZ_FILTER_ATTACHED_ENTRIES: 'true',
    }),
    publicOrganizations: true,
    allowed: TRANSIT_ALLOWED,
  },
];

for (const model of MODELS)
  describe(`What every route tells a caller without rights, under ${model.label ?? model.name}`, function () {
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
      'DM_AUTHZ_FILTER_ATTACHED_ENTRIES',
      'DM_AUTHZ_DYNAMIC_BASE',
      'DM_AUTHZ_DYNAMIC_CACHE_TTL',
      'DM_LDAP_USERS_BASE',
      'DM_TWAKE_LIFECYCLE_DELETED_ATTRIBUTE',
      'DM_TWAKE_LIFECYCLE_DELETED_VALUE',
      'DM_TWAKE_TOMBSTONE_DN',
      'DM_TWAKE_SPACE_CLASS',
      'DM_TWAKE_SPACE_DISPLAY_NAME_ATTRIBUTE',
      'DM_TWAKE_SPACE_ADMIN_ATTRIBUTE',
      'DM_TWAKE_SPACE_EDITOR_ATTRIBUTE',
      'DM_TWAKE_SPACE_VIEWER_ATTRIBUTE',
      'DM_ORGANIZATION_SCHEMA',
      'DM_SCIM_USER_BASE',
      'DM_SCIM_GROUP_BASE',
      'DM_APP_ACCOUNTS_USER_ATTRIBUTE',
    ];
    let dir: string;

    let params: (path: string) => Record<string, Pair> | null;
    /** How a caller says who it is, under this model */
    const as = (who: string): Record<string, string> =>
      model.tokens
        ? { Authorization: `Bearer ${model.tokens[who].token}` }
        : { 'X-Test-User': who };
    let policyDn = '';
    let spaceId: string | undefined;
    let mySpaceId: string | undefined;

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
        // Where the account routes find a user
        DM_LDAP_USERS_BASE: `ou=users,${base}`,
        // And the app accounts find it by uid, as the probe names it
        DM_APP_ACCOUNTS_USER_ATTRIBUTE: 'uid',
        ...model.env(orgs, base),
        DM_LDAP_FLAT_SCHEMA:
          './static/schemas/twake/users.json,./static/schemas/example/positions.json',
        // Its pointers are checked: a manager must exist
        DM_ORGANIZATION_SCHEMA: './static/schemas/twake/organizations.json',
        // Where SCIM finds the targets: by default, right under the base
        DM_SCIM_USER_BASE: `ou=users,${base}`,
        DM_SCIM_GROUP_BASE: `ou=groups,${base}`,
        DM_TWAKE_GROUP_BASE: `ou=groups,ou={org},${orgs}`,
        DM_TWAKE_GROUP_USER_BASE: `ou=users,ou={org},${orgs}`,
        DM_TWAKE_GROUP_ORGANIZATION_DN: `ou={org},${orgs}`,
        DM_TWAKE_SPACE_BASE: `ou=spaces,ou={org},${orgs}`,
        // A deleted account is kept as a tombstone, marked in a standard
        // attribute: the one deleted to be one, so that the others are
        // removed for good
        DM_TWAKE_LIFECYCLE_DELETED_ATTRIBUTE: 'employeeType',
        DM_TWAKE_LIFECYCLE_DELETED_VALUE: 'deleted',
        DM_TWAKE_TOMBSTONE_DN: `^uid=probe-gone,ou=users,${base}$`,
        // Spaces of standard classes, which the test directory knows
        DM_TWAKE_SPACE_CLASS: 'top,organizationalRole,extensibleObject',
        DM_TWAKE_SPACE_DISPLAY_NAME_ATTRIBUTE: 'o',
        DM_TWAKE_SPACE_ADMIN_ATTRIBUTE: 'roleOccupant',
        DM_TWAKE_SPACE_EDITOR_ATTRIBUTE: 'owner',
        DM_TWAKE_SPACE_VIEWER_ATTRIBUTE: 'seeAlso',
        DM_APPLICATIVE_ACCOUNT_BASE: `ou=probeapplicative,${base}`,
        DM_AUTHZ_GLOBAL_ORGANIZATION: orgs,
      });

      server = new DM();
      await server.ready;
      // An instance provider nobody answers at, and attributes the test
      // directory knows
      Object.assign(server.config, {
        twake_instance_provider: 'cozy-stack',
        twake_instance_cozy_url: 'http://127.0.0.1:9',
        twake_instance_cozy_domain: 'probe.example',
        twake_instance_dn: [`^uid=[^,]+,ou=users,${base}$`],
        twake_instance_fqdn_attribute: 'carLicense',
        twake_instance_sent_attribute: 'businessCategory',
      });
      server.loadedPlugins['rabbitmq'] = new StubRabbitMq() as never;
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
          ...(secret ? { title: SECRET } : {}),
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
      await department(org('probeseen'), []);
      for (const name of ['probemine', 'probetheirs', 'probeseen'])
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
      // A position holds its name only: no listing may carry it
      await add(`cn=probe-position,ou=positions,${base}`, {
        objectClass: ['top', 'twakePosition'],
        cn: 'probe-position',
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

      // The tokens of a model authenticating by token
      if (model.tokens) {
        await ou(`ou=probetokens,${base}`);
        for (const [who, { token, branch }] of Object.entries(model.tokens))
          await add(`cn=${who},ou=probetokens,${base}`, {
            objectClass: ['top', 'inetOrgPerson'],
            cn: who,
            sn: who,
            userPassword: ssha(token),
            description: JSON.stringify({
              tenant: who,
              bases: [
                {
                  dn: branch(orgs, base),
                  read: true,
                  write: true,
                  delete: true,
                },
              ],
            }),
          });
      }

      // To be deleted by the administrator, once the plugins are there
      await person('probe-gone', `ou=users,${base}`, theirs);

      // What the caller holds: routes are called on it, and only a target
      // their body or query names varies
      const mine = org('probemine');
      await person('probe-muser', `ou=users,${base}`, mine, false);
      await add(`cn=probe-mgroup,ou=groups,${base}`, {
        objectClass: ['top', 'twakeStaticGroup'],
        cn: 'probe-mgroup',
        member: [`uid=probe-muser,ou=users,${base}`],
        twakeDepartmentLink: mine,
      });
      await department(`ou=probesub,${mine}`, []);
      await person('probe-mtuser', `ou=users,${mine}`, mine, false);
      await add(`cn=probe-mtgroup,ou=groups,${mine}`, {
        objectClass: ['top', 'twakeStaticGroup'],
        cn: 'probe-mtgroup',
        o: 'Probe mine group',
        member: [`uid=probe-mtuser,ou=users,${mine}`],
        twakeDepartmentLink: mine,
      });
      // Lodged in the caller's branch, attached to the other organization:
      // hidden from the caller, by a narrower rule when judged by branch
      await person('probe-lodger', `ou=users,${mine}`, theirs, false);
      await add(lodgerGroup(orgs), {
        objectClass: ['top', 'twakeStaticGroup'],
        cn: 'probe-lgroup',
        o: 'Probe lodged group',
        member: [lodger(orgs)],
        twakeDepartmentLink: theirs,
      });
      // In the organization the caller only reads, hidden by a narrower rule
      await person(
        'probe-slodger',
        `ou=users,${org('probeseen')}`,
        org('probeseen')
      );
      await add(seenGroup(orgs), {
        objectClass: ['top', 'twakeStaticGroup'],
        cn: 'probe-slgroup',
        o: `Probe ${SECRET} seen group`,
        member: [seenLodger(orgs)],
        twakeDepartmentLink: org('probeseen'),
      });
      // Attached to the caller's organization, outside its branch: hidden
      // from the caller when judged by branch
      await person('probe-hidden', `ou=users,${base}`, mine, false);

      for (const [name, Plugin] of [
        ...(model.tokens ? [] : [['testAuth', TestAuth]]),
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
        ['ldapEnterpriseRules', LdapEnterpriseRules],
        ['externalUsersInGroups', ExternalUsersInGroups],
        ['twakeTombstone', TwakeTombstone],
        ['twakeInstances', TwakeInstances],
      ] as [string, new (s: DM) => DmPlugin][])
        await server.registerPlugin(name, new Plugin(server));
      server.setupErrorMiddleware();
      request = supertest(server.app);
      if (model.tokens)
        await (server.loadedPlugins[model.name] as AuthzDynamic).reload();
      policyDn = `cn=probepolicy,${(
        server.loadedPlugins['ldapPasswordPolicy'] as unknown as {
          policyBase(): string;
        }
      ).policyBase()}`;

      // Deleted by the administrator, kept as a tombstone of the other
      // organization
      const gone = await request
        .delete('/api/v1/ldap/users/probe-gone')
        .set(as(ADMIN));
      const tombstone = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['employeeType'] },
        `uid=probe-gone,ou=users,${base}`
      )) as SearchResult;
      // Without it, erasing a tombstone would probe nothing
      if (tombstone.searchEntries[0]?.employeeType !== 'deleted')
        throw new Error(
          `probe-gone left no tombstone: ${gone.status} ${JSON.stringify(gone.body)}`
        );

      // Through the routes, as the administrator: the plugins' own formats.
      // A space carries no link, so it holds no secret: under a model
      // judging by link, its name is every administrator's to read.
      const admin = (path: string, body: object) =>
        request.post(path).set(as(ADMIN)).type('json').send(body);
      await admin('/api/v1/password-policies', {
        cn: 'probepolicy',
        pwdMinLength: 8,
      });
      const space = await admin('/api/v1/organizations/probetheirs/spaces', {
        name: 'Probe space',
        members: [{ username: 'probe-tuser', role: 'admin' }],
      });
      spaceId = (space.body as { id?: string }).id;
      const mySpace = await admin('/api/v1/organizations/probemine/spaces', {
        name: 'Mine space',
        members: [{ username: 'probe-mtuser', role: 'admin' }],
      });
      mySpaceId = (mySpace.body as { id?: string }).id;
      // A caller refused as unknown would answer alike everywhere
      for (const who of [ADMIN, CALLER]) {
        const me = await request.get('/api/v1/authz/scope').set(as(who));
        if (me.status === 401)
          throw new Error(
            `${who} is not authenticated: ${JSON.stringify(me.body)}`
          );
      }
      // Without them, the space routes would probe nothing
      if (!spaceId || !mySpaceId)
        throw new Error(
          `spaces not created: ${JSON.stringify(space.body)} ${JSON.stringify(mySpace.body)}`
        );

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
          return { id: { there: 'probe-position', absent: 'probe-absent' } };
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
      // A tombstone deleted is written again: it is erased
      await (
        server.loadedPlugins['twakeTombstone'] as TwakeTombstone | undefined
      )
        ?.erase(`uid=probe-gone,ou=users,${base}`, { force: true })
        .catch(() => undefined);
      const doomed: string[] = [];
      for (const branch of [
        orgs,
        `ou=probeapplicative,${base}`,
        `ou=probetokens,${base}`,
      ])
        try {
          const found = (await server.ldap.search(
            { paged: false, scope: 'sub', attributes: ['1.1'] },
            branch
          )) as SearchResult;
          doomed.push(...found.searchEntries.map(e => String(e.dn)));
        } catch {
          // Not there
        }
      // And what the routes created in the shared branches
      for (const [branch, filter] of [
        [`ou=users,${base}`, '(uid=probe-new*)'],
        [`ou=groups,${base}`, '(cn=probe-new*)'],
      ])
        try {
          const found = (await server.ldap.search(
            { paged: false, scope: 'one', filter, attributes: ['1.1'] },
            branch
          )) as SearchResult;
          doomed.push(...found.searchEntries.map(e => String(e.dn)));
        } catch {
          // Not there
        }
      doomed.push(
        `uid=probe-them,ou=users,${base}`,
        `cn=probe-them-group,ou=groups,${base}`,
        `cn=probe-position,ou=positions,${base}`,
        `uid=probe-muser,ou=users,${base}`,
        `uid=probe-gone,ou=users,${base}`,
        `uid=probe-hidden,ou=users,${base}`,
        `cn=probe-mgroup,ou=groups,${base}`,
        `uid=${ADMIN},ou=users,${base}`,
        `uid=${CALLER},ou=users,${base}`,
        policyDn
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
                name?: string;
                route?: { path: string; methods: Record<string, boolean> };
                handle?: { stack?: unknown[] };
              }[];
            };
          }
        ).router?.stack ?? [];
      const out: [string, string][] = [];
      /** Whether a mounted router holds routes, at any depth */
      const holdsRoutes = (layers: unknown[]): boolean =>
        layers.some(inner => {
          const l = inner as { route?: unknown; handle?: { stack?: unknown } };
          return (
            Boolean(l.route) ||
            (Array.isArray(l.handle?.stack) && holdsRoutes(l.handle.stack))
          );
        });
      for (const layer of stack) {
        // A mounted router's routes are not listed here: one would go
        // unprobed, so it is said. The body parsers' router holds none.
        if (
          Array.isArray(layer.handle?.stack) &&
          holdsRoutes(layer.handle.stack)
        )
          throw new Error(
            `A router holding routes is mounted (${layer.name ?? 'anonymous'}): list its routes`
          );
        if (layer.route)
          for (const method of Object.keys(layer.route.methods))
            out.push([method.toUpperCase(), layer.route.path]);
      }
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
      let text = JSON.stringify({ status: res.status, body: res.body })
        // Where each call was served, and when
        .replace(/127\.0\.0\.1:\d+/g, '<server>')
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>');
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
      const req = request[verb](path).set(as(who));
      return (
        body === undefined ? req : req.type('json').send(body as object)
      ) as never;
    };

    /**
     * The targets and the other organization, as the server reads them:
     * what a write the caller should not make would change.
     */
    const snapshot = async (): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      for (const [branch, scope] of [
        [`ou=probetheirs,${orgs}`, 'sub'],
        [`uid=probe-them,ou=users,${base}`, 'base'],
        [`cn=probe-them-group,ou=groups,${base}`, 'base'],
        [`cn=probe-position,ou=positions,${base}`, 'base'],
        [policyDn, 'base'],
        // And what the caller holds: a write refused leaves it alone too
        [`ou=probemine,${orgs}`, 'sub'],
        [`ou=probeseen,${orgs}`, 'sub'],
        [`uid=probe-muser,ou=users,${base}`, 'base'],
        [`cn=probe-mgroup,ou=groups,${base}`, 'base'],
        [`uid=probe-hidden,ou=users,${base}`, 'base'],
        [`uid=probe-gone,ou=users,${base}`, 'base'],
      ] as [string, 'sub' | 'base'][]) {
        const found = (await server.ldap
          .search(
            {
              paged: false,
              scope,
              // And what the password routes write, which `*` leaves out
              attributes: [
                '*',
                'pwdPolicySubentry',
                'pwdAccountLockedTime',
                'pwdFailureTime',
              ],
            },
            branch
          )
          .catch(() => ({ searchEntries: [] }))) as SearchResult;
        for (const entry of found.searchEntries) out[String(entry.dn)] = entry;
      }
      return out;
    };

    /**
     * Call every route naming a target twice as `who`, on a target there and
     * on one that is not: the routes answering differently, and the ones
     * this test cannot place.
     *
     * @param who the caller
     * @param only the methods to call
     * @param place the targets of a route, none to leave it out
     */
    const probe = async (
      who: string,
      only?: string[],
      place: (path: string) => Record<string, Pair> | null | undefined = path =>
        params(path)
    ): Promise<{
      differing: string[];
      unplaced: string[];
      unexercised: string[];
    }> => {
      const differing: string[] = [];
      const unplaced: string[] = [];
      const unexercised: string[] = [];
      for (const [method, path] of routes()) {
        if (!path.includes(':')) continue;
        if (only && !only.includes(method)) continue;
        const key = `${method} ${path}`;
        const pairs = place(path);
        if (pairs === undefined) continue;
        if (!pairs) {
          unplaced.push(key);
          continue;
        }
        // Only the parameters the path names: the others were not asked
        const named = Object.entries(pairs).filter(([k]) =>
          new RegExp(`:${k}(/|$)`).test(path)
        );
        const there = Object.fromEntries(named.map(([k, v]) => [k, v.there]));
        const absent = Object.fromEntries(named.map(([k, v]) => [k, v.absent]));
        const body = bodyFor(method, path);
        const a = await call(method, fill(path, there), body, who);
        const b = await call(method, fill(path, absent), body, who);
        const left = neutral(a, there);
        const right = neutral(b, absent);
        if (String(JSON.stringify(a.body)).includes(SECRET))
          differing.push(`${key} answered a secret: ${JSON.stringify(a.body)}`);
        if (who !== CALLER) {
          if (left !== right)
            differing.push(`${key}\n    there:  ${left}\n    absent: ${right}`);
          continue;
        }
        // An error is no answer: it hides what the route would say
        if (a.status >= 500 || b.status >= 500)
          differing.push(
            `${key} failed: ${a.status} ${b.status} ${JSON.stringify(b.body)}`
          );
        // Refused at the shape: the call never reached what it probes
        if (a.status === 400 && !UNEXERCISED[key]) unexercised.push(key);
        // A write to a target the caller holds nothing of is refused,
        // whatever its existence tells
        if (method !== 'GET' && a.status < 400)
          differing.push(`${key} wrote: ${a.status} ${JSON.stringify(a.body)}`);
        // That a target exists may be every administrator's to read
        if (!model.allowed[key] && left !== right)
          differing.push(`${key}\n    there:  ${left}\n    absent: ${right}`);
      }
      return { differing, unplaced, unexercised };
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
        'GET /api/v1/organizations/:id/spaces/:spaceId',
        'GET /api/v1/ldap/positions/:id',
        'GET /api/v1/users/:user/app-accounts',
        'GET /scim/v2/Users/:id',
        'GET /scim/v2/Groups/:id',
      ])
        expect(
          differing.some(line => line.startsWith(`${route}\n`)),
          route
        ).to.equal(true);
    });

    it('answers alike whether a target it may not touch is there or not', async function () {
      this.timeout(120000);
      const before = await snapshot();
      // The targets are there to be touched
      expect(Object.keys(before)).to.include.members([
        `uid=probe-them,ou=users,${base}`,
        `uid=probe-tuser,ou=users,ou=probetheirs,${orgs}`,
        `cn=probe-tgroup,ou=groups,ou=probetheirs,${orgs}`,
      ]);
      const { differing, unplaced, unexercised } = await probe(CALLER);
      expect(unplaced, 'routes this test cannot place').to.deep.equal([]);
      expect(unexercised, 'routes refused at the shape').to.deep.equal([]);
      expect(differing, differing.join('\n')).to.deep.equal([]);
      // Nothing the caller may not touch was touched
      expect(await snapshot()).to.deep.equal(before);
    });

    it('answers alike inside an organization it reads, but may not write', async function () {
      // Judged by branch, every organization route stops at the
      // organization's gate: here, the caller goes past it, and the groups
      // and users a narrower rule hides must answer as absent ones do
      if (!model.readOnlyOrg) this.skip();
      this.timeout(120000);
      const inside = (path: string) =>
        // A space carries no link, and no rule here hides one
        path.startsWith('/api/v1/organizations/:id') &&
        !path.includes(':spaceId')
          ? {
              id: { there: 'probeseen', absent: 'probeseen' },
              groupId: { there: 'probe-slgroup', absent: 'probe-absent' },
              userId: { there: 'probe-slodger', absent: 'probe-absent' },
            }
          : undefined;
      // Past the gate: the organization is the caller's to read
      const gate = await call(
        'GET',
        '/api/v1/organizations/probeseen/groups',
        undefined
      );
      expect(gate.status, JSON.stringify(gate.body)).to.equal(200);
      // And the targets are there to be found, by one who may read them
      const seen = await probe(ADMIN, ['GET'], inside);
      expect(
        seen.differing.some(line =>
          line.startsWith('GET /api/v1/organizations/:id/groups/:groupId\n')
        ),
        seen.differing.join('\n')
      ).to.equal(true);
      const before = await snapshot();
      const { differing, unplaced, unexercised } = await probe(
        CALLER,
        undefined,
        inside
      );
      expect(unplaced).to.deep.equal([]);
      expect(unexercised, 'routes refused at the shape').to.deep.equal([]);
      expect(differing, differing.join('\n')).to.deep.equal([]);
      expect(await snapshot()).to.deep.equal(before);
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
        const text = String(JSON.stringify(res.body));
        // Judged by attachment, a nomenclature value is every
        // administrator's: the positions are listed to all
        const hidden = [
          ...(model.publicOrganizations
            ? TARGETS.filter(token => token !== 'probe-position')
            : [...TARGETS, 'probe-hidden']),
          ...(model.wholeBranch ? [] : ['probe-lodger', 'probe-lgroup']),
        ];
        if (hidden.some(token => text.includes(token)))
          leaking.push(
            `${method} ${path}: ${JSON.stringify(res.body).slice(0, 300)}`
          );
      }
      expect(leaking, leaking.join('\n')).to.deep.equal([]);
    });

    /**
     * A target carried in a body or a query, on a route the caller may use:
     * what the caller holds is in the path, and only the target varies
     * (#396).
     */
    interface Carried {
      method: string;
      path: () => string;
      vary: () => Pair;
      body?: (target: string) => unknown;
      query?: (target: string) => string;
      /** Only judged by attachment: by branch, the path is not the caller's */
      attachedOnly?: boolean;
      /**
       * Only judged by branch: by attachment, the target is the caller's to
       * read
       */
      branchOnly?: boolean;
      /**
       * The route looks in the caller's own branch only: the target hides
       * there behind a narrower rule, which a model granting whole branches
       * has not
       */
      narrowed?: boolean;
      /** Judged by attachment, a difference allowed: why */
      transit?: string;
      /** A difference allowed under every model: why */
      allowed?: string;
      /**
       * The absent variant is a write the caller may make, and goes
       * through: the route is the caller's to use
       */
      writes?: boolean;
      /**
       * The variant naming a target that is there is a write the caller may
       * make, on what it holds: it goes through, setting this attribute of
       * this entry to the target, and nothing else
       */
      sets?: { dn: () => string; attribute: string };
      /**
       * A target not found is left out, the rest written: both variants go
       * through, and must write the same
       */
      leavesOut?: boolean;
      /**
       * The caller's call gets past the authorization, to the lookup of the
       * target: its absent variant is no refusal. Without it, two refusals
       * would answer alike and probe nothing.
       */
      reaches?: boolean;
    }

    const theirsOrg = (): string => `ou=probetheirs,${orgs}`;
    const orgPair = (): Pair => ({
      there: theirsOrg(),
      absent: `ou=probe-absent,${orgs}`,
    });
    const userPair = (): Pair => ({
      there: `uid=probe-them,ou=users,${base}`,
      absent: `uid=probe-absent,ou=users,${base}`,
    });
    const ORG_EXISTS =
      'an organization carries no link: every administrator reads it';
    let created = 0;
    const TAKEN =
      'a name is taken whoever may read the entry holding it: uniqueness answers about the whole directory';
    const POINTER =
      'a pointer leads somewhere whoever may read where: whether an account exists is answered, not what it holds';
    /** An account of the caller's organization, as the Twake schema wants it */
    const newAccount = (uid: string, link = `ou=probemine,${orgs}`) => ({
      // The uid is the mail's, suffixed if taken: no name to probe
      cn: uid,
      sn: 'Probe',
      givenName: 'New',
      displayName: `Probe ${uid}`,
      mail: `${uid}@example.org`,
      employeeNumber: `N-${uid}`,
      twakeDepartmentLink: link,
    });

    // In the order the administrator's control calls them: the moves last,
    // as they take away what the cases before them are called on
    const CARRIED: Record<string, Carried> = {
      'member added to a group': {
        method: 'POST',
        path: () => '/api/v1/ldap/groups/probe-mgroup/members',
        vary: userPair,
        body: target => ({ member: [target] }),
        attachedOnly: true,
        reaches: true,
      },
      'parent of a new organization': {
        method: 'POST',
        path: () => '/api/v1/ldap/organizations',
        vary: orgPair,
        body: target => ({ ou: 'probe-neworg', parentDn: target }),
        transit: ORG_EXISTS,
      },
      'member added to an organization group': {
        method: 'POST',
        path: () =>
          '/api/v1/organizations/probemine/groups/probe-mtgroup/members',
        vary: () => ({ there: 'probe-lodger', absent: 'probe-absent' }),
        body: target => ({ usernames: [target] }),
        narrowed: true,
        reaches: true,
      },
      'member added to a space': {
        method: 'POST',
        path: () =>
          `/api/v1/organizations/probemine/spaces/${mySpaceId!}/members`,
        vary: () => ({ there: 'probe-lodger', absent: 'probe-absent' }),
        body: target => ({ usernames: [target], role: 'viewer' }),
        narrowed: true,
        reaches: true,
      },
      'group linked to a space': {
        method: 'POST',
        path: () =>
          `/api/v1/organizations/probemine/spaces/${mySpaceId!}/groups`,
        vary: () => ({ there: 'probe-lgroup', absent: 'probe-absent' }),
        body: target => ({ groupIds: [target], role: 'viewer' }),
        narrowed: true,
        reaches: true,
      },
      'tombstone erased': {
        method: 'POST',
        path: () => '/api/v1/twake/tombstones/erase',
        vary: () => ({
          there: `uid=probe-gone,ou=users,${base}`,
          absent: `uid=probe-absent,ou=users,${base}`,
        }),
        body: target => ({ dn: target }),
      },
      'mail taken elsewhere': {
        method: 'PUT',
        path: () => '/api/v1/ldap/users/probe-muser',
        vary: () => ({
          there: `probe-them@${SECRET}.example`,
          // Sent again by the administrator: the account's own copies do
          // not hold it against it (#402)
          absent: 'probe-free@example.org',
        }),
        body: target => ({ replace: { mail: target } }),
        attachedOnly: true,
        allowed: TAKEN,
        writes: true,
      },
      'base of a raw search': {
        method: 'GET',
        path: () => '/api/v1/ldap/raw/search',
        vary: userPair,
        query: target =>
          `?base=${encodeURIComponent(target)}&scope=base&filter=${encodeURIComponent('(objectClass=*)')}`,
      },
      // Judged by branch, the SCIM users are not the caller's: refused alike
      'SCIM user filter': {
        method: 'GET',
        path: () => '/scim/v2/Users',
        vary: () => ({ there: 'probe-them', absent: 'probe-absent' }),
        query: target =>
          `?filter=${encodeURIComponent(`userName eq "${target}"`)}`,
      },
      // Judged by branch, the linked entries are looked for in the
      // organization's branch, which the caller reads
      'organization search': {
        method: 'GET',
        path: () =>
          `/api/v1/ldap/organizations/${encodeURIComponent(`ou=probemine,${orgs}`)}/subnodes/search`,
        vary: () => ({ there: 'probe-hidden', absent: 'probe-absent' }),
        query: target => `?q=${encodeURIComponent(target)}`,
        branchOnly: true,
        reaches: true,
      },
      'organization of a new account': {
        method: 'POST',
        path: () => '/api/v1/ldap/users',
        vary: orgPair,
        body: target => newAccount(`probe-new${++created}`, target),
        attachedOnly: true,
        transit: ORG_EXISTS,
      },
      'member of a new group': {
        method: 'POST',
        path: () => '/api/v1/ldap/groups',
        vary: userPair,
        body: target => ({
          cn: `probe-new${++created}`,
          member: [target],
          objectClass: ['top', 'twakeStaticGroup'],
          twakeDepartmentLink: `ou=probemine,${orgs}`,
        }),
        attachedOnly: true,
        reaches: true,
      },
      'member of a SCIM group': {
        method: 'PUT',
        path: () => '/scim/v2/Groups/probe-mgroup',
        vary: userPair,
        body: target => ({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'probe-mgroup',
          members: [{ value: target }],
        }),
        attachedOnly: true,
        leavesOut: true,
        reaches: true,
      },
      'members of a new space': {
        method: 'POST',
        path: () => '/api/v1/organizations/probemine/spaces',
        vary: () => ({ there: 'probe-lodger', absent: 'probe-absent' }),
        body: target => ({
          name: `probe-new${++created}`,
          members: [{ username: target, role: 'admin' }],
        }),
        narrowed: true,
        reaches: true,
      },
      'account whose instance is ensured': {
        method: 'POST',
        path: () => '/api/v1/twake/instances/ensure',
        vary: userPair,
        body: target => ({ dn: target }),
      },
      'account whose instance is ensured, by mail': {
        method: 'POST',
        path: () => '/api/v1/twake/instances/ensure',
        vary: () => ({
          there: `probe-them@${SECRET}.example`,
          absent: 'probe-absent@example.org',
        }),
        body: target => ({ mail: target }),
      },
      'manager of an organization': {
        method: 'PUT',
        path: () =>
          `/api/v1/ldap/organizations/${encodeURIComponent(`ou=probesub,ou=probemine,${orgs}`)}`,
        vary: userPair,
        body: target => ({ replace: { twakeManagerLink: [target] } }),
        allowed: POINTER,
        sets: {
          dn: () => `ou=probesub,ou=probemine,${orgs}`,
          attribute: 'twakeManagerLink',
        },
        reaches: true,
      },
      'destination of an organization move': {
        method: 'POST',
        path: () =>
          `/api/v1/ldap/organizations/${encodeURIComponent(`ou=probesub,ou=probemine,${orgs}`)}/move`,
        vary: orgPair,
        body: target => ({ targetOrgDn: target }),
        transit: ORG_EXISTS,
      },
      'destination of an account move': {
        method: 'POST',
        path: () => '/api/v1/ldap/users/probe-muser/move',
        vary: orgPair,
        body: target => ({ targetOrgDn: target }),
        attachedOnly: true,
        transit: ORG_EXISTS,
      },
      'destination of a group move': {
        method: 'POST',
        path: () => '/api/v1/ldap/groups/probe-mgroup/move',
        vary: orgPair,
        body: target => ({ targetOrgDn: target }),
        attachedOnly: true,
        transit: ORG_EXISTS,
      },
    };

    /** The cases this model runs */
    const carried = (): [string, Carried][] =>
      Object.entries(CARRIED).filter(
        ([, c]) =>
          !(c.attachedOnly && !model.publicOrganizations) &&
          !(c.branchOnly && model.publicOrganizations) &&
          !(c.narrowed && model.wholeBranch)
      );

    /** A carried case called as `who`, on a target */
    const send = (c: Carried, target: string, who = CALLER) =>
      call(
        c.method,
        c.path() + (c.query?.(target) ?? ''),
        c.body?.(target),
        who
      );

    it('answers alike whether a target its body or query names is there or not', async function () {
      this.timeout(120000);
      const differing: string[] = [];
      for (const [name, c] of carried()) {
        const { there, absent } = c.vary();
        const before = await snapshot();
        const a = await send(c, there);
        const taken = await snapshot();
        const after = JSON.stringify(taken);
        if (c.sets) {
          const { dn, attribute } = c.sets;
          const held = [
            (taken[dn()] as Record<string, unknown> | undefined)?.[attribute] ??
              [],
          ].flat();
          if (!held.includes(there))
            differing.push(`${name} did not set ${attribute}: ${a.status}`);
          // The pointer aside, nothing was touched
          const aside = (s: Record<string, unknown>) =>
            JSON.stringify({
              ...s,
              [dn()]: { ...(s[dn()] as object), [attribute]: undefined },
            });
          if (aside(taken) !== aside(before))
            differing.push(
              `${name} changed the directory beyond ${attribute}: ${a.status}`
            );
        }
        // Nothing the caller may not touch was touched, nor what it holds
        else if (!c.leavesOut && after !== JSON.stringify(before))
          differing.push(`${name} changed the directory: ${a.status}`);
        const b = await send(c, absent);
        // What was not found was left out alike
        if (c.leavesOut && after !== JSON.stringify(await snapshot()))
          differing.push(`${name} wrote what it was named: ${a.status}`);
        const left = neutral(a, { target: there });
        const right = neutral(b, { target: absent });
        if (a.status >= 500 || b.status >= 500)
          differing.push(`${name} failed: ${a.status} ${b.status}`);
        // The value asked for may be answered back; nothing else of it
        if (left.includes(SECRET))
          differing.push(
            `${name} answered a secret: ${JSON.stringify(a.body)}`
          );
        // A write naming what the caller holds nothing of is refused
        if (c.method !== 'GET' && !c.leavesOut && !c.sets && a.status < 400)
          differing.push(
            `${name} wrote: ${a.status} ${JSON.stringify(a.body)}`
          );
        if (c.reaches && b.status === 403)
          differing.push(
            `${name} refused the caller: ${JSON.stringify(b.body)}`
          );
        if (c.writes && b.status >= 400)
          differing.push(
            `${name} refused the caller its own write: ${b.status} ${JSON.stringify(b.body)}`
          );
        const allowed = c.allowed || (model.publicOrganizations && c.transit);
        if (!allowed && left !== right)
          differing.push(`${name}\n    there:  ${left}\n    absent: ${right}`);
      }
      expect(differing, differing.join('\n')).to.deep.equal([]);
    });

    it('places every write that names no target in its path', () => {
      const covered = new Set(
        Object.values(CARRIED).map(c => `${c.method} ${c.path()}`)
      );
      const unplaced = routes()
        .filter(([method, path]) => method !== 'GET' && !path.includes(':'))
        .map(([method, path]) => `${method} ${path}`)
        .filter(key => !covered.has(key) && !NO_TARGET[key]);
      expect(unplaced, 'writes this test cannot place').to.deep.equal([]);
    });

    it('tells the carried targets apart for a caller who may read them', async function () {
      // The cases above probe something: an administrator naming the same
      // targets is answered differently. Its writes go through, so this
      // comes last, as mocha runs the tests in the order they are declared:
      // run alone with --grep, it leaves the caller's tests nothing to probe.
      this.timeout(120000);
      const alike: string[] = [];
      for (const [name, c] of carried()) {
        const { there, absent } = c.vary();
        const a = await send(c, there, ADMIN);
        const b = await send(c, absent, ADMIN);
        if (neutral(a, { target: there }) === neutral(b, { target: absent }))
          alike.push(`${name}: ${a.status} ${JSON.stringify(a.body)}`);
      }
      expect(alike, alike.join('\n')).to.deep.equal([]);
    });
  });
