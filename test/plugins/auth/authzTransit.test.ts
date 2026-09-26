/**
 * The transit branch under authzPerBranch, where a branch can be held
 * read-only: an ordinary move still asks only for read on the organization
 * the entry leaves, putting it in transit asks for write there.
 *
 * And an entry attached to no organization is judged on its parent: ldapts
 * answers the missing link with an empty array, which used to be read as the
 * branch "undefined", so that nobody could write such an entry at all.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import type { AttributesList } from '../../../src/lib/ldapActions';
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

describe('Transit branch under authzPerBranch', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let userBranch: string;
  let orgRead: string;
  let orgWrite: string;
  let transit: string;
  const READER = 'transit.reader';
  const USERS_ADMIN = 'transit.users.admin';
  const MOVED = 'transit.entry.moved';
  const HELD = 'transit.entry.held';
  const LOOSE = 'transit.entry.loose';
  const accounts = [MOVED, HELD, LOOSE];
  const saved: Record<string, string | undefined> = {};

  const as = (user: string) => ({
    'X-Test-User': user,
    Accept: 'application/json',
  });
  const move = (uid: string, targetOrgDn: string, caller: string) =>
    request
      .post(`/api/v1/ldap/users/${uid}/move`)
      .set(as(caller))
      .send({ targetOrgDn });

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
    orgRead = `ou=TransitOrgRead,${top}`;
    orgWrite = `ou=TransitOrgWrite,${top}`;
    transit = `ou=TransitOrgTransit,${top}`;

    const rw = { read: true, write: true, delete: false };
    const env: Record<string, string> = {
      DM_AUTHZ_FILTER_ATTACHED_ENTRIES: 'true',
      DM_AUTHZ_TRANSIT_BRANCH: transit,
      DM_LDAP_FLAT_SCHEMA: './static/schemas/twake/users.json',
      DM_AUTHZ_PER_BRANCH_CONFIG: JSON.stringify({
        default: { read: false, write: false, delete: false },
        users: {
          [READER]: {
            [orgRead]: { read: true, write: false, delete: false },
            [orgWrite]: rw,
          },
          [USERS_ADMIN]: { [userBranch]: rw },
        },
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
      [orgRead, 'TransitOrgRead'],
      [orgWrite, 'TransitOrgWrite'],
      [transit, 'TransitOrgTransit'],
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
      sn: 'Transit',
      givenName: 'Test',
      displayName: 'Test Transit',
      mail: `${uid}@example.com`,
      ...(org
        ? { twakeDepartmentLink: org, twakeDepartmentPath: 'TransitOrg' }
        : {}),
    });
    for (const [uid, org] of [
      [MOVED, orgRead],
      [HELD, orgRead],
      [LOOSE, null],
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
    for (const dn of [orgRead, orgWrite, transit])
      await server.ldap.delete(dn).catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('moves an entry out of a branch held read-only, as before', async () => {
    const res = await move(MOVED, orgWrite, READER);
    expect(res.status).to.equal(200);
  });

  it('does not put in transit an entry of a branch held read-only', async () => {
    const res = await move(HELD, transit, READER);
    expect(res.status).to.equal(403);
  });

  it('judges an entry attached to no organization on its parent', async () => {
    const res = await request
      .put(`/api/v1/ldap/users/${LOOSE}`)
      .set(as(USERS_ADMIN))
      .send({ replace: { displayName: 'Changed on its parent' } });
    expect(res.status).to.equal(200);
  });
});
