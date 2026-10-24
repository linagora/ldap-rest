/**
 * The attached entries of an organization, for an administrator held to it.
 *
 * `GET /subnodes` and `/subnodes/search` look for the entries attached to an
 * organization from the parent of the top organization. Judged by DN, an
 * administrator whose rules name their organization only may not search
 * there: both routes answered 403 on their own organization.
 */
import { expect } from 'chai';
import type { Response } from 'express';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

class HeaderAuth extends AuthBase {
  name = 'headerAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-test-user'];
    if (typeof user !== 'string') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.user = user;
    next();
  }
}

describe('Organization subnodes, for an administrator held to the organization', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let top: string;
  let mine: string;
  const added: string[] = [];
  const ENV = [
    'DM_LDAP_TOP_ORGANIZATION',
    'DM_AUTHZ_PER_BRANCH_CONFIG',
    'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
  ];
  const previous: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(30000);
    base = process.env.DM_LDAP_BASE as string;
    top = `ou=snbtop,${base}`;
    mine = `ou=snbmine,${top}`;
    for (const k of ENV) previous[k] = process.env[k];
    process.env.DM_LDAP_TOP_ORGANIZATION = top;
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        snbadmin: { [mine]: { read: true, write: true, delete: false } },
        snbroot: { [base]: { read: true, write: true, delete: true } },
      },
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';

    server = new DM();
    await server.ready;
    const add = async (dn: string, entry: Record<string, unknown>) => {
      await server.ldap.delete(dn).catch(() => undefined);
      await server.ldap.add(dn, entry as never);
      added.unshift(dn);
    };
    const ou = (dn: string) =>
      add(dn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
        twakeDepartmentPath: /^ou=([^,]+)/.exec(dn)![1],
      });
    const person = (uid: string, at: string, linked = true) =>
      add(`uid=${uid},${at}`, {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        uid,
        cn: uid,
        sn: uid,
        ...(linked ? { twakeDepartmentLink: mine } : {}),
      });
    // The callers, as the rules name them
    await person('snbadmin', `ou=users,${base}`, false);
    await person('snbroot', `ou=users,${base}`, false);
    await ou(top);
    await ou(mine);
    await ou(`ou=snbchild,${mine}`);
    await ou(`ou=users,${mine}`);
    // Attached to the organization, in its branch and outside it
    await person('snbinside', `ou=users,${mine}`);
    await person('snboutside', `ou=users,${base}`);

    await server.registerPlugin('headerAuth', new HeaderAuth(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of added)
      await server?.ldap.delete(dn).catch(() => undefined);
    for (const k of ENV)
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
  });

  const get = (who: string, path: string) =>
    request
      .get(
        `/api/v1/ldap/organizations/${encodeURIComponent(mine)}/subnodes${path}`
      )
      .set('X-Test-User', who)
      .set('Accept', 'application/json');
  const uids = (body: Array<{ uid?: string | string[] }>) =>
    body.flatMap(e => [e.uid ?? []].flat());
  const ous = (body: Array<{ ou?: string | string[] }>) =>
    body.flatMap(e => [e.ou ?? []].flat());

  for (const [route, path] of [
    ['lists', ''],
    ['searches', '/search?q=snb'],
  ])
    it(`${route} what is attached to the organization within its branch`, async () => {
      const res = await get('snbadmin', path);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(ous(res.body)).to.include('snbchild');
      expect(uids(res.body)).to.include('snbinside');
      expect(uids(res.body)).not.to.include('snboutside');
    });

  for (const [route, path] of [
    ['lists', ''],
    ['searches', '/search?q=snb'],
  ])
    it(`still ${route} from the base for whoever reads it`, async () => {
      const res = await get('snbroot', path);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(uids(res.body)).to.include.members(['snbinside', 'snboutside']);
    });

  it('still refuses an organization the caller does not read', async () => {
    const res = await request
      .get(
        `/api/v1/ldap/organizations/${encodeURIComponent(top)}/subnodes/search?q=snb`
      )
      .set('X-Test-User', 'snbadmin')
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });
});
