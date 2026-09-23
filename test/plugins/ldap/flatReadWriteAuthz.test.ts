/**
 * Reading, modifying and deleting a flat entity have to be authorized too.
 *
 * `renameEntry` was fixed for exactly this in 0.8.0, and the same shape was
 * left everywhere else in `abstract/ldapFlat`: `apiGet`, `listEntries`,
 * `modifyEntry` and `deleteEntry` all called the directory without handing
 * the request down, and every authorization plugin skips its check when
 * there is none — see `AuthzBase.shouldSkipAuthorization`. A caller with no
 * permission on the branch listed every account, read any of them, changed
 * them and deleted them, and each call answered success.
 *
 * Creation was the exception: `addEntry` always passed the request, which is
 * why the hole went unnoticed — the route people test first was the one that
 * worked.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import type { SearchResult } from '../../../src/lib/ldapActions';
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

describe('Flat entity read and write, authorization', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let orgDn: string;
  const NONE = 'rw.none';
  const READER = 'rw.reader';
  const WRITER = 'rw.writer';
  const ALICE = 'authz.rw.alice';
  let previousConfig: string | undefined;
  let previousTtl: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    orgDn = `ou=RwAuthzOrg,${base}`;

    previousConfig = process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    previousTtl = process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL;
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        // NONE is deliberately absent: the default denies everything, which
        // is the state of any authenticated caller nobody granted anything.
        [READER]: { [userBranch]: { read: true, write: false, delete: false } },
        [WRITER]: { [userBranch]: { read: true, write: true, delete: true } },
      },
      groups: {},
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];

    await server.ldap
      .add(orgDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'RwAuthzOrg',
        twakeDepartmentPath: 'RwAuthzOrg',
      })
      .catch(() => undefined);

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [`uid=${ALICE},${userBranch}`, orgDn])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousConfig === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    else process.env.DM_AUTHZ_PER_BRANCH_CONFIG = previousConfig;
    if (previousTtl === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL;
    else process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = previousTtl;
  });

  beforeEach(async () => {
    await server.ldap
      .delete(`uid=${ALICE},${userBranch}`)
      .catch(() => undefined);
    await server.ldap.add(`uid=${ALICE},${userBranch}`, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: ALICE,
      cn: ALICE,
      sn: 'Authz',
      givenName: 'Test',
      displayName: 'Test Authz',
      mail: `${ALICE}@example.com`,
      employeeNumber: 'AUZ0002',
      twakeDepartmentLink: orgDn,
      twakeDepartmentPath: 'RwAuthzOrg',
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
      twakeDeliveryMode: [
        `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
      ],
    });
  });

  const exists = async (dn: string): Promise<boolean> => {
    try {
      const res = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['dn'] },
        dn
      )) as SearchResult;
      return res.searchEntries.length > 0;
    } catch {
      return false;
    }
  };

  const forbidden = 'Token does not have permission on this branch';

  it('should refuse to list the branch to a caller granted nothing', async () => {
    const res = await request
      .get('/api/v1/ldap/users')
      .set('X-Test-User', NONE)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
    expect(res.body.error).to.equal(forbidden);
  });

  it('should refuse to read one entry to a caller granted nothing', async () => {
    const res = await request
      .get(`/api/v1/ldap/users/${ALICE}`)
      .set('X-Test-User', NONE)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('should refuse a modification to a caller who may only read', async () => {
    const res = await request
      .put(`/api/v1/ldap/users/${ALICE}`)
      .set('X-Test-User', READER)
      .type('json')
      .send({ replace: { description: 'changed' } });
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('should refuse a deletion to a caller who may only read', async () => {
    const res = await request
      .delete(`/api/v1/ldap/users/${ALICE}`)
      .set('X-Test-User', READER)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
    expect(await exists(`uid=${ALICE},${userBranch}`)).to.equal(true);
  });

  it('should let a reader list and read', async () => {
    const list = await request
      .get('/api/v1/ldap/users')
      .set('X-Test-User', READER)
      .set('Accept', 'application/json');
    expect(list.status, JSON.stringify(list.body)).to.equal(200);
    const one = await request
      .get(`/api/v1/ldap/users/${ALICE}`)
      .set('X-Test-User', READER)
      .set('Accept', 'application/json');
    expect(one.status, JSON.stringify(one.body)).to.equal(200);
  });

  it('should let a writer modify and delete', async () => {
    const mod = await request
      .put(`/api/v1/ldap/users/${ALICE}`)
      .set('X-Test-User', WRITER)
      .type('json')
      .send({ replace: { description: 'changed' } });
    expect(mod.status, JSON.stringify(mod.body)).to.equal(200);
    const del = await request
      .delete(`/api/v1/ldap/users/${ALICE}`)
      .set('X-Test-User', WRITER)
      .set('Accept', 'application/json');
    expect(del.status, JSON.stringify(del.body)).to.equal(200);
    expect(await exists(`uid=${ALICE},${userBranch}`)).to.equal(false);
  });
});
