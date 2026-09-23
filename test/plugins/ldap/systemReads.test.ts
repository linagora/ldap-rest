/**
 * The reads a plugin makes as the server rather than as its caller.
 *
 * `ldapActions.forRequest(req)` exists so an operation carries the request
 * the authorization hooks read; a call without one skips every check. Some
 * reads have no business being the caller's, and saying which is the point
 * of `ldap.system` — a uniqueness check has to see the whole branch, or it
 * answers "free" about a name that is taken and hands it out as an
 * identifier.
 *
 * Here the caller may write in the users branch and may not read it, which
 * is what an authorization model expresses as "create accounts, do not
 * browse them". The identifier is derived from the mail address, so the
 * collision is the server's to detect.
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
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

/** Authentication reduced to a header: this is about what reads what */
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

describe('Reads a plugin makes as the server', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let orgDn: string;
  const WRITER = 'system.writer';
  const previous: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    orgDn = `ou=SystemReadOrg,${base}`;
    for (const k of [
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
    ])
      previous[k] = process.env[k];
    // Write, no read: the case the unbound uniqueness check is for.
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [WRITER]: {
          // Write in the users branch and in the organization the accounts
          // hang off; read nowhere.
          [`ou=users,${base}`]: { read: false, write: true, delete: true },
          [orgDn]: { read: false, write: true, delete: true },
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
        ou: 'SystemReadOrg',
        twakeDepartmentPath: 'SystemReadOrg',
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
      `uid=taken.name,ou=users,${base}`,
      `uid=taken.name-2,ou=users,${base}`,
      orgDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  const create = async (mail: string): Promise<supertest.Response> =>
    request
      .post('/api/v1/ldap/users')
      .set('X-Test-User', WRITER)
      .type('json')
      .send({
        givenName: 'Taken',
        sn: 'Name',
        displayName: 'Taken Name',
        mail,
        employeeNumber: `SYS${Date.now() % 100000}`,
        twakeDepartmentLink: orgDn,
      });

  it('should still see a name that is taken when the caller may not read it', async () => {
    // First account: its identifier comes from the mail's local part.
    const first = await create('taken.name@example.com');
    expect(first.status, JSON.stringify(first.body)).to.equal(201);

    // Second account, same local part on another domain — the case the
    // generator's own comment describes. Asked as the caller, the branch
    // reads as empty, `taken.name` looks free, and the directory refuses
    // the duplicate DN. Asked as the server, the collision is seen and the
    // identifier is suffixed.
    const second = await create('taken.name@other.example.com');
    expect(second.status, JSON.stringify(second.body)).to.equal(201);
    expect(second.body.uid ?? second.body.entry?.uid).to.not.equal(
      'taken.name'
    );
  });
});
