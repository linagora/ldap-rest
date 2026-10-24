/**
 * An authorization refusal answers before any other plugin's judgement.
 *
 * The first hook to throw answers a request, and hooks used to run in the
 * order their plugins registered: in a deployment, the order the plugins'
 * imports completed in. `enterpriseRules` registered before the
 * authorization plugin answered a caller who may not write a branch with
 * 409 "already used" — telling them, one request at a time, which addresses
 * the directory holds where they cannot read. `trash` registered before it
 * moved an entry to the trash before anyone judged the delete.
 *
 * Every plugin here registers before the authorization plugin, which is the
 * order that used to let them answer first.
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
import TrashPlugin from '../../../src/plugins/ldap/trash';
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

describe('Authorization hooks run first', function () {
  let server: DM;
  // Setup and cleanup go through a server with no plugin: the trash would
  // take the deletes, and the rules judge the adds
  let plain: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let ownOrg: string;
  let otherOrg: string;
  let trashBase: string;
  let holderDn: string;
  const OUTSIDER = 'first.outsider';
  const HOLDER = 'first.holder';
  const previous: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    ownOrg = `ou=FirstOwnOrg,${base}`;
    otherOrg = `ou=FirstOtherOrg,${base}`;
    trashBase = `ou=firsttrash,${base}`;
    holderDn = `uid=${HOLDER},ou=users,${base}`;
    for (const k of [
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
    ])
      previous[k] = process.env[k];
    // The outsider administers their own organization only.
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [OUTSIDER]: { [ownOrg]: { read: true, write: true, delete: true } },
      },
      groups: {},
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';

    plain = new DM();
    await plain.ready;
    for (const [dn, ou] of [
      [ownOrg, 'FirstOwnOrg'],
      [otherOrg, 'FirstOtherOrg'],
    ])
      await plain.ldap
        .add(dn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou,
          twakeDepartmentPath: ou,
        })
        .catch(() => undefined);
    await plain.ldap
      .add(trashBase, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'firsttrash',
      })
      .catch(() => undefined);

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    await server.registerPlugin(
      'trash',
      new TrashPlugin(
        server.withConfig({
          ...server.config,
          trash_base: trashBase,
          trash_watched_bases: `ou=users,${base}`,
        })
      )
    );
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [
      holderDn,
      `uid=${HOLDER},${trashBase}`,
      trashBase,
      ownOrg,
      otherOrg,
    ])
      await plain.ldap.delete(dn).catch(() => undefined);
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  // An account of the other organization, holding the address probed below
  beforeEach(async () => {
    for (const dn of [holderDn, `uid=${HOLDER},${trashBase}`])
      await plain.ldap.delete(dn).catch(() => undefined);
    await plain.ldap.add(holderDn, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: HOLDER,
      cn: HOLDER,
      sn: 'Holder',
      givenName: 'First',
      displayName: 'First Holder',
      mail: `${HOLDER}@example.com`,
      employeeNumber: 'FIRST001',
      twakeDepartmentLink: otherOrg,
      twakeDepartmentPath: 'FirstOtherOrg',
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
      twakeDeliveryMode: [
        `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
      ],
    });
  });

  const exists = async (dn: string): Promise<boolean> => {
    try {
      await plain.ldap.search(
        { paged: false, scope: 'base', attributes: ['dn'] },
        dn
      );
      return true;
    } catch {
      return false;
    }
  };

  const createIn = (org: string, mail: string): Promise<supertest.Response> =>
    request
      .post('/api/v1/ldap/users')
      .set('X-Test-User', OUTSIDER)
      .type('json')
      .send({
        givenName: 'First',
        sn: 'Probe',
        displayName: 'First Probe',
        mail,
        employeeNumber: `FIRST${Date.now() % 100000}`,
        twakeDepartmentLink: org,
      });

  it('refuses a creation in a branch the caller may not write before saying the address is taken', async () => {
    const res = await createIn(otherOrg, `${HOLDER}@example.com`);
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('still says the address is taken where the caller may write', async () => {
    const res = await createIn(ownOrg, `${HOLDER}@example.com`);
    expect(res.status, JSON.stringify(res.body)).to.equal(409);
  });

  it('refuses a delete the caller may not make before the trash takes the entry', async () => {
    const res = await request
      .delete(`/api/v1/ldap/users/${HOLDER}`)
      .set('X-Test-User', OUTSIDER);
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
    expect(await exists(holderDn), 'the entry stays where it was').to.equal(
      true
    );
    expect(await exists(`uid=${HOLDER},${trashBase}`)).to.equal(false);
  });
});
