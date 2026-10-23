/**
 * `--authz-transit-origin-attribute`: an entry put in transit keeps the
 * organization it leaves, and loses it when it is claimed, so that who claims
 * it can tell where it comes from.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import type {
  AttributesList,
  SearchResult,
} from '../../../src/lib/ldapActions';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars } from '../../helpers/env';

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

describe('Transit branch: where an entry comes from', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let userBranch: string;
  let sales: string;
  let backend: string;
  let transit: string;
  const ADMIN = 'origin.admin';
  const MOVED = 'origin.entry.moved';
  const MODIFIED = 'origin.entry.modified';
  const LOOSE = 'origin.entry.loose';
  const TYPED = 'origin.entry.typed';
  const accounts = [MOVED, MODIFIED, LOOSE, TYPED];
  const ORIGIN = 'departmentNumber';
  const saved: Record<string, string | undefined> = {};

  const as = (user: string) => ({
    'X-Test-User': user,
    Accept: 'application/json',
  });
  const move = (uid: string, targetOrgDn: string) =>
    request
      .post(`/api/v1/ldap/users/${uid}/move`)
      .set(as(ADMIN))
      .send({ targetOrgDn });
  const origin = async (uid: string): Promise<unknown> => {
    const res = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: [ORIGIN] },
      `uid=${uid},${userBranch}`
    )) as SearchResult;
    const value = res.searchEntries[0]?.[ORIGIN];
    return Array.isArray(value) ? value[0] : value;
  };

  before(function () {
    skipIfMissingEnvVars(this, [
      'DM_LDAP_DN',
      'DM_LDAP_PWD',
      'DM_LDAP_BASE',
      'DM_LDAP_TOP_ORGANIZATION',
    ]);
  });

  before(async function () {
    this.timeout(20000);
    const top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    userBranch = `ou=users,${process.env.DM_LDAP_BASE}`;
    sales = `ou=OriginSales,${top}`;
    backend = `ou=OriginBackend,${top}`;
    transit = `ou=OriginTransit,${top}`;

    const rw = { read: true, write: true, delete: false };
    const env: Record<string, string> = {
      DM_AUTHZ_FILTER_ATTACHED_ENTRIES: 'true',
      DM_AUTHZ_TRANSIT_BRANCH: transit,
      DM_AUTHZ_TRANSIT_ORIGIN_ATTRIBUTE: ORIGIN,
      DM_LDAP_FLAT_SCHEMA: './static/schemas/twake/users.json',
      DM_AUTHZ_PER_BRANCH_CONFIG: JSON.stringify({
        default: { read: false, write: false, delete: false },
        users: { [ADMIN]: { [sales]: rw, [backend]: rw } },
        groups: {},
      }),
    };
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }

    server = new DM();
    await server.ready;

    for (const [dn, ou] of [
      [sales, 'OriginSales'],
      [backend, 'OriginBackend'],
      [transit, 'OriginTransit'],
    ]) {
      await server.ldap.delete(dn).catch(() => undefined);
      await server.ldap.add(dn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou,
        twakeDepartmentPath: ou,
      });
    }

    const account = (uid: string, org: string | null): AttributesList => ({
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid,
      cn: uid,
      sn: 'Origin',
      givenName: 'Test',
      displayName: 'Test Origin',
      mail: `${uid}@example.com`,
      ...(org
        ? { twakeDepartmentLink: org, twakeDepartmentPath: 'OriginOrg' }
        : {}),
    });
    for (const [uid, org] of [
      [MOVED, sales],
      [MODIFIED, sales],
      [LOOSE, null],
      [TYPED, sales],
    ] as [string, string | null][]) {
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
      await server.ldap.add(`uid=${uid},${userBranch}`, account(uid, org));
    }

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const uid of accounts)
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
    for (const dn of [sales, backend, transit])
      await server.ldap.delete(dn).catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('records the organization an entry leaves for transit', async () => {
    expect((await move(MOVED, transit)).status).to.equal(200);
    expect(await origin(MOVED)).to.equal(sales);
  });

  it('removes it when the entry is claimed', async () => {
    expect((await move(MOVED, backend)).status).to.equal(200);
    expect(await origin(MOVED)).to.equal(undefined);
  });

  it('records it when the link itself is modified', async () => {
    const res = await request
      .put(`/api/v1/ldap/users/${MODIFIED}`)
      .set(as(ADMIN))
      .send({ replace: { twakeDepartmentLink: transit } });
    expect(res.status).to.equal(200);
    expect(await origin(MODIFIED)).to.equal(sales);
  });

  it('claims an entry attached to nothing without an origin', async () => {
    expect((await move(LOOSE, backend)).status).to.equal(200);
    expect(await origin(LOOSE)).to.equal(undefined);
  });

  it('leaves alone a modify that names the attribute itself', async () => {
    await server.ldap.modify(`uid=${TYPED},${userBranch}`, {
      replace: { twakeDepartmentLink: transit, [ORIGIN]: 'typed' },
    });
    expect(await origin(TYPED)).to.equal('typed');
  });
});
