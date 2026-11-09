/**
 * The organization filter must not take every entry for an organization
 * when `--ldap-top-organization` is the directory suffix.
 *
 * An entry is recognized by its organization classes, not by where it sits:
 * with the suffix as the tree top, every account, group and nomenclature
 * value is under it, and the structural reading hid them.
 */
import { expect } from 'chai';
import type { Response } from 'express';
import type { SearchResult } from 'ldapts';
import supertest from 'supertest';
import AuthBase, { type DmRequest } from '@ldap-rest/core/lib/auth/base';
import type { Role } from '@ldap-rest/core/abstract/plugin';
import type { AttributesList } from '@ldap-rest/core/lib/ldapActions';
import AuthzLinid1 from '@ldap-rest/authz-linid1';
import LdapFlatGeneric from '@ldap-rest/ldap-flatgeneric';
import LdapGroups from '@ldap-rest/ldap-groups';

import { DM } from '../../helpers/dm';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-test-user'];
    if (typeof user !== 'string' || !user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.user = user;
    next();
  }
}

describe('authzLinid1 with the directory suffix as the tree top', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let groupBranch: string;
  let org: string;
  let other: string;
  let globalWrite: string;
  const ADMIN = 'bttop.admin';
  const LOOSE = 'bttop.loose';
  const GROUP = 'bttop-group-loose';
  const accounts = [ADMIN, LOOSE];
  let previousSchema: string | undefined;

  const as = (uid: string) => ({
    'X-Test-User': uid,
    Accept: 'application/json',
  });

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    groupBranch = `ou=groups,${base}`;
    org = `ou=BTOrg,${base}`;
    other = `ou=BTOther,${base}`;
    globalWrite = `ou=BTDomains,${base}`;

    previousSchema = process.env.DM_LDAP_FLAT_SCHEMA;
    process.env.DM_LDAP_FLAT_SCHEMA =
      './packages/ldap-rest/static/schemas/twake/users.json';

    server = new DM();
    await server.ready;
    // The suffix itself is the tree top: every entry is under it.
    server.config.ldap_top_organization = base;
    server.config.authz_global_write_branch = [globalWrite];

    const user = (uid: string, link?: string): AttributesList => ({
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid,
      cn: uid,
      sn: 'BaseTop',
      givenName: 'Test',
      displayName: 'Test BaseTop',
      mail: `${uid}@example.com`,
      ...(link ? { twakeDepartmentLink: link } : {}),
    });
    for (const [uid, link] of [
      [ADMIN, org],
      [LOOSE, undefined],
    ] as [string, string?][]) {
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
      await server.ldap.add(`uid=${uid},${userBranch}`, user(uid, link));
    }
    for (const [dn, ou, admin] of [
      [org, 'BTOrg', `uid=${ADMIN},${userBranch}`],
      [other, 'BTOther', null],
    ] as [string, string, string | null][]) {
      await server.ldap.delete(dn).catch(() => undefined);
      await server.ldap.add(dn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou,
        twakeDepartmentPath: ou,
        ...(admin ? { twakeLocalAdminLink: admin } : {}),
      });
    }
    await server.ldap
      .delete(`cn=${GROUP},${groupBranch}`)
      .catch(() => undefined);
    await server.ldap.add(`cn=${GROUP},${groupBranch}`, {
      objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
      cn: GROUP,
      member: `uid=${LOOSE},${userBranch}`,
    });
    await server.ldap.delete(globalWrite).catch(() => undefined);
    await server.ldap.add(globalWrite, {
      objectClass: ['top', 'organizationalUnit'],
      ou: 'BTDomains',
    });

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzLinid1', new AuthzLinid1(server));
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('ldapGroups', new LdapGroups(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    await server.ldap
      .delete(`cn=${GROUP},${groupBranch}`)
      .catch(() => undefined);
    for (const uid of accounts)
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
    for (const dn of [org, other, globalWrite])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousSchema === undefined) delete process.env.DM_LDAP_FLAT_SCHEMA;
    else process.env.DM_LDAP_FLAT_SCHEMA = previousSchema;
  });

  it('still lists the account and the group attached to nothing', async () => {
    const users = await request.get('/api/v1/ldap/users').set(as(ADMIN));
    expect(users.status).to.equal(200);
    expect(users.body).to.have.property(LOOSE);

    const groups = await request.get('/api/v1/ldap/groups').set(as(ADMIN));
    expect(groups.status).to.equal(200);
    expect(groups.body).to.have.property(GROUP);
  });

  it('judges an entry asked for without its classes', async () => {
    const found = (await server.ldap.search(
      {
        paged: false,
        scope: 'sub',
        filter: `(uid=${LOOSE})`,
        attributes: ['uid'],
      },
      userBranch,
      { user: ADMIN, headers: {} } as unknown as DmRequest
    )) as SearchResult;
    expect(found.searchEntries).to.have.length(1);
    expect(found.searchEntries[0]).not.to.have.property('objectClass');
  });

  it('keeps a global write branch readable under the tree top', async () => {
    const found = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['ou'] },
      globalWrite,
      { user: ADMIN, headers: {} } as unknown as DmRequest
    )) as SearchResult;
    expect(found.searchEntries).to.have.length(1);
  });

  it('still hides an organization outside the caller branch', async () => {
    const found = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['ou'] },
      other,
      { user: ADMIN, headers: {} } as unknown as DmRequest
    )) as SearchResult;
    expect(found.searchEntries).to.deep.equal([]);
  });
});
