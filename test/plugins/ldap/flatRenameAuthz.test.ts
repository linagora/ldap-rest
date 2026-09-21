/**
 * The rename route has to be authorized, and that is not free: it is bought
 * by handing the request down to the directory call.
 *
 * `renameEntry` called `ldap.rename(dn, newDn)` with no request, and every
 * authorization plugin skips its check when there is none — see
 * `AuthzBase.shouldSkipAuthorization`. So a route built on it renamed
 * without any branch check at all, and did so silently: the call succeeded,
 * which is the failure mode nobody notices. The same request now travels to
 * `ldapActions`, so `ldaprenamerequest` fires with a user to check.
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

describe('Flat entity rename, authorization', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let orgDn: string;
  const READER = 'rename.reader';
  const WRITER = 'rename.writer';
  const ALICE = 'authz.alice';
  // The suite shares one process: what was set before must be set after.
  let previousConfig: string | undefined;
  let previousTtl: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    orgDn = `ou=RenameAuthzOrg,${base}`;

    previousConfig = process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    previousTtl = process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL;
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        // May look, may not touch: the case the missing request hid.
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
        ou: 'RenameAuthzOrg',
        twakeDepartmentPath: 'RenameAuthzOrg',
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
    for (const dn of [
      `uid=${ALICE},${userBranch}`,
      `uid=${ALICE}2,${userBranch}`,
      orgDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousConfig === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    else process.env.DM_AUTHZ_PER_BRANCH_CONFIG = previousConfig;
    if (previousTtl === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL;
    else process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = previousTtl;
  });

  beforeEach(async () => {
    for (const dn of [
      `uid=${ALICE},${userBranch}`,
      `uid=${ALICE}2,${userBranch}`,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    // Written without a request, as a fixture: the point of the test is what
    // the route does, not how it was seeded.
    await server.ldap.add(`uid=${ALICE},${userBranch}`, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: ALICE,
      cn: ALICE,
      sn: 'Authz',
      givenName: 'Test',
      displayName: 'Test Authz',
      mail: `${ALICE}@example.com`,
      employeeNumber: 'AUZ0001',
      twakeDepartmentLink: orgDn,
      twakeDepartmentPath: 'RenameAuthzOrg',
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

  it('should refuse a caller with no write permission on the branch', async () => {
    const res = await request
      .post(`/api/v1/ldap/users/${ALICE}/rename`)
      .set('X-Test-User', READER)
      .type('json')
      .send({ newId: `${ALICE}2` });

    expect(res.status, JSON.stringify(res.body)).to.equal(403);
    expect(res.body.error).to.equal(
      'Token does not have permission on this branch'
    );
    expect(await exists(`uid=${ALICE},${userBranch}`)).to.equal(true);
    expect(await exists(`uid=${ALICE}2,${userBranch}`)).to.equal(false);
  });

  it('should let a caller with write permission through', async () => {
    const res = await request
      .post(`/api/v1/ldap/users/${ALICE}/rename`)
      .set('X-Test-User', WRITER)
      .type('json')
      .send({ newId: `${ALICE}2` });

    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(await exists(`uid=${ALICE}2,${userBranch}`)).to.equal(true);
  });
});
