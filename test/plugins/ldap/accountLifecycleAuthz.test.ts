/**
 * The status and password endpoints change an account, so they need the same
 * branch authorization as `PUT /users/<id>`, judged by the request they
 * hand down.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapAccountLifecycle from '../../../src/plugins/ldap/accountLifecycle';
import type { SearchResult } from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

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

describe('Account lifecycle, authorization', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let orgDn: string;
  let userDn: string;
  let active: string;
  const NONE = 'lc.none';
  const READER = 'lc.reader';
  const WRITER = 'lc.writer';
  const ELSEWHERE = 'lc.elsewhere';
  const ALICE = 'authz.lc.alice';
  const ORIGINAL_PASSWORD = 'original-secret';
  let previousConfig: string | undefined;
  // What the directory stored, which a directory hashing cleartext changes
  let storedPassword: unknown;
  let previousTtl: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    orgDn = `ou=LcAuthzOrg,${base}`;
    userDn = `uid=${ALICE},${userBranch}`;
    active = `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`;

    previousConfig = process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    previousTtl = process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL;
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [READER]: { [userBranch]: { read: true, write: false, delete: false } },
        [WRITER]: { [userBranch]: { read: true, write: true, delete: true } },
        [ELSEWHERE]: {
          [`ou=groups,${base}`]: { read: true, write: true, delete: true },
        },
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
        ou: 'LcAuthzOrg',
        twakeDepartmentPath: 'LcAuthzOrg',
      })
      .catch(() => undefined);

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapAccountLifecycle',
      new LdapAccountLifecycle(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [userDn, orgDn])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousConfig === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    else process.env.DM_AUTHZ_PER_BRANCH_CONFIG = previousConfig;
    if (previousTtl === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL;
    else process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = previousTtl;
  });

  beforeEach(async () => {
    await server.ldap.delete(userDn).catch(() => undefined);
    await server.ldap.add(userDn, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: ALICE,
      cn: ALICE,
      sn: 'Authz',
      givenName: 'Test',
      displayName: 'Test Authz',
      mail: `${ALICE}@example.com`,
      employeeNumber: 'AUZ0003',
      userPassword: ORIGINAL_PASSWORD,
      twakeDepartmentLink: orgDn,
      twakeDepartmentPath: 'LcAuthzOrg',
      twakeAccountStatus: active,
    });
    storedPassword = await read('userPassword');
  });

  const read = async (attribute: string): Promise<unknown> => {
    const res = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: [attribute] },
      userDn
    )) as SearchResult;
    const value = res.searchEntries[0]?.[attribute];
    return Buffer.isBuffer(value) ? value.toString() : value;
  };

  for (const caller of [NONE, READER, ELSEWHERE]) {
    it(`should refuse a password reset to ${caller}`, async () => {
      const res = await request
        .post(`/api/v1/ldap/users/${ALICE}/password`)
        .set('X-Test-User', caller)
        .type('json')
        .send({ password: 'taken-over' });
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(await read('userPassword')).to.deep.equal(storedPassword);
    });

    it(`should refuse a generated password to ${caller}`, async () => {
      const res = await request
        .post(`/api/v1/ldap/users/${ALICE}/password`)
        .set('X-Test-User', caller)
        .type('json')
        .send({});
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(res.body).not.to.have.property('password');
      expect(await read('userPassword')).to.deep.equal(storedPassword);
    });

    it(`should refuse a status change to ${caller}`, async () => {
      const res = await request
        .post(`/api/v1/ldap/users/${ALICE}/status`)
        .set('X-Test-User', caller)
        .type('json')
        .send({ state: 'disabled' });
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(await read('twakeAccountStatus')).to.equal(active);
    });
  }

  it('should let a writer reset the password and change the status', async () => {
    const pwd = await request
      .post(`/api/v1/ldap/users/${ALICE}/password`)
      .set('X-Test-User', WRITER)
      .type('json')
      .send({ password: 'new-secret' });
    expect(pwd.status, JSON.stringify(pwd.body)).to.equal(200);
    expect(await read('userPassword')).not.to.deep.equal(storedPassword);

    const status = await request
      .post(`/api/v1/ldap/users/${ALICE}/status`)
      .set('X-Test-User', WRITER)
      .type('json')
      .send({ state: 'disabled' });
    expect(status.status, JSON.stringify(status.body)).to.equal(200);
    expect(await read('twakeAccountStatus')).to.equal(
      `cn=disabled,ou=twakeAccountStatus,ou=nomenclature,${base}`
    );
  });
});
