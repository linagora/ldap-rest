/**
 * An account whose schema state is not `enabled` is refused, even when the
 * identity provider still lets it sign in: the lifecycle state is the
 * directory's way to stop an administrator without deleting them.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import type { AttributesList } from '../../../src/lib/ldapActions';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import AuthzScope from '../../../src/plugins/auth/authzScope';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

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

describe('AuthzLinid1 and the account status', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let org: string;
  let previousSchema: string | undefined;

  const DISABLED = 'status.disabled';
  const ENABLED = 'status.enabled';
  const NO_ACCESS = 'status.noaccess';
  const TO_DELETE = 'status.todelete';
  const accounts = [DISABLED, ENABLED, NO_ACCESS, TO_DELETE];
  const dnOf = (uid: string): string => `uid=${uid},${userBranch}`;
  const status = (state: string): string =>
    `cn=${state},ou=twakeAccountStatus,ou=nomenclature,${base}`;

  const as = (uid: string): Record<string, string> => ({
    'X-Test-User': uid,
    Accept: 'application/json',
  });

  before(function () {
    skipIfMissingEnvVars(this, [
      'DM_LDAP_DN',
      'DM_LDAP_PWD',
      'DM_LDAP_BASE',
      'DM_LDAP_TOP_ORGANIZATION',
    ]);
  });

  before(async function () {
    this.timeout(30000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    org = `ou=StatusOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    previousSchema = process.env.DM_LDAP_FLAT_SCHEMA;
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';

    server = new DM();
    await server.ready;

    await server.ldap.delete(org).catch(() => undefined);
    await server.ldap.add(org, {
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou: 'StatusOrg',
      twakeDepartmentPath: 'StatusOrg',
      twakeLocalAdminLink: accounts.map(dnOf),
    });

    for (const [uid, state] of [
      [DISABLED, 'disabled'],
      [ENABLED, 'active'],
      [NO_ACCESS, 'noaccess'],
      [TO_DELETE, 'todelete'],
    ] as [string, string][]) {
      await server.ldap.delete(dnOf(uid)).catch(() => undefined);
      await server.ldap.add(dnOf(uid), {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        uid,
        cn: uid,
        sn: 'Status',
        givenName: 'Test',
        displayName: 'Test Status',
        mail: `${uid}@example.com`,
        twakeDepartmentLink: org,
        twakeDepartmentPath: 'StatusOrg',
        twakeAccountStatus: status(state),
      } satisfies AttributesList);
    }

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzLinid1', new AuthzLinid1(server));
    const flat = new LdapFlatGeneric(server);
    await server.registerPlugin('ldapFlatGeneric', flat);
    const scope = new AuthzScope(server);
    await server.registerPlugin('authzScope', scope);
    await waitFor(() => Boolean(flat.instances?.some(i => i.schema)), {
      what: 'the user schema',
    });
    scope.afterLoad();
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const uid of accounts)
      await server.ldap.delete(dnOf(uid)).catch(() => undefined);
    await server.ldap.delete(org).catch(() => undefined);
    if (previousSchema === undefined) delete process.env.DM_LDAP_FLAT_SCHEMA;
    else process.env.DM_LDAP_FLAT_SCHEMA = previousSchema;
  });

  it('refuses an administrator whose state is disabled', async () => {
    const res = await request.get('/api/v1/ldap/users').set(as(DISABLED));
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('refuses an administrator whose state is no access', async () => {
    const res = await request.get('/api/v1/ldap/users').set(as(NO_ACCESS));
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('refuses an administrator whose state is to delete', async () => {
    const res = await request.get('/api/v1/ldap/users').set(as(TO_DELETE));
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('refuses the scope of a disabled administrator', async () => {
    const res = await request.get('/api/v1/authz/scope').set(as(DISABLED));
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('lets an enabled administrator through', async () => {
    const res = await request.get('/api/v1/ldap/users').set(as(ENABLED));
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
  });

  it('applies a suspension at once after a resolved request', async () => {
    const change = (state: string): Promise<boolean> =>
      server.ldap.modify(
        dnOf(DISABLED),
        { replace: { twakeAccountStatus: status(state) } },
        { user: ENABLED } as unknown as DmRequest
      ) as Promise<boolean>;

    // The account starts disabled; enable it to populate the resolution cache
    await change('active');
    expect(
      (await request.get('/api/v1/ldap/users').set(as(DISABLED))).status
    ).to.equal(200);

    await change('disabled');
    expect(
      (await request.get('/api/v1/ldap/users').set(as(DISABLED))).status
    ).to.equal(403);

    await change('active');
    expect(
      (await request.get('/api/v1/ldap/users').set(as(DISABLED))).status
    ).to.equal(200);
  });
});
