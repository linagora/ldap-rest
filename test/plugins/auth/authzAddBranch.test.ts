/**
 * Creating an organization is judged on the branch its DN lands in as well
 * as on the organization it links to: a local administrator may not put an
 * organization under another tenant's tree because it links to one of theirs.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';
import AuthBase, { type DmRequest } from '@ldap-rest/core/lib/auth/base';
import AuthzLinid1 from '@ldap-rest/authz-linid1';
import LdapGroups from '@ldap-rest/ldap-groups';
import LdapOrganizations from '@ldap-rest/ldap-organizations';

import { DM } from '../../helpers/dm';
import type { AttributesList } from '../../../packages/ldap-rest/src/lib/ldapActions';
import type { Role } from '../../../packages/ldap-rest/src/abstract/plugin';
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

describe('authz add: the DN branch and the linked organization', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let top: string;
  let orgA: string;
  let orgB: string;
  let userBranch: string;
  let previousLink: string | undefined;
  let previousGroupBase: string | undefined;

  const ADMIN = 'addbranch.admin';
  const adminDn = (): string => `uid=${ADMIN},${userBranch}`;

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
    top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    userBranch = `ou=users,${base}`;
    orgA = `ou=AddBranchA,${top}`;
    orgB = `ou=AddBranchB,${top}`;

    // `twakeGroupLink` is allowed on the test organization class; the
    // delegation rule is the same whatever the link attribute is called.
    previousLink = process.env.DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE;
    previousGroupBase = process.env.DM_LDAP_GROUP_BASE;
    process.env.DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE = 'twakeGroupLink';
    // Let the group plugin fall back to the directory root, as it does when
    // no group branch is configured: the root must not become a flat store.
    delete process.env.DM_LDAP_GROUP_BASE;
    server = new DM();
    await server.ready;

    await server.ldap.delete(adminDn()).catch(() => undefined);
    await server.ldap.add(adminDn(), {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: ADMIN,
      cn: ADMIN,
      sn: 'Add',
      givenName: 'Branch',
      displayName: 'Add Branch',
      mail: `${ADMIN}@example.com`,
    } satisfies AttributesList);

    for (const [dn, ou, admins] of [
      [orgA, 'AddBranchA', [adminDn()]],
      [orgB, 'AddBranchB', []],
    ] as [string, string, string[]][]) {
      await server.ldap.delete(dn).catch(() => undefined);
      await server.ldap.add(dn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou,
        twakeDepartmentPath: ou,
        ...(admins.length ? { twakeLocalAdminLink: admins } : {}),
      });
    }

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzLinid1', new AuthzLinid1(server));
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    await server.registerPlugin('ldapGroups', new LdapGroups(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [
      `ou=AddBranchProbe,${orgA}`,
      `ou=AddBranchProbe,${orgB}`,
      `ou=AddBranchRootProbe,${base}`,
      `ou=AddBranchFlatOrg,${userBranch}`,
      orgB,
      orgA,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    await server.ldap.delete(adminDn()).catch(() => undefined);
    if (previousGroupBase === undefined) delete process.env.DM_LDAP_GROUP_BASE;
    else process.env.DM_LDAP_GROUP_BASE = previousGroupBase;
    if (previousLink === undefined)
      delete process.env.DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE;
    else process.env.DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE = previousLink;
  });

  it('refuses an organization under another branch, whatever it links to', async () => {
    const res = await request
      .post('/api/v1/ldap/organizations')
      .set(as(ADMIN))
      .send({
        ou: 'AddBranchProbe',
        parentDn: orgB,
        twakeGroupLink: orgA,
      });
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('refuses an organization at the root through a link', async () => {
    const res = await request
      .post('/api/v1/ldap/organizations')
      .set(as(ADMIN))
      .send({
        ou: 'AddBranchRootProbe',
        parentDn: base,
        twakeGroupLink: orgA,
      });
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('refuses an organization in a flat store through a link', async () => {
    const res = await request
      .post('/api/v1/ldap/organizations')
      .set(as(ADMIN))
      .send({
        ou: 'AddBranchFlatOrg',
        parentDn: userBranch,
        twakeGroupLink: orgA,
      });
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('lets the same administrator create under their own branch', async () => {
    const res = await request
      .post('/api/v1/ldap/organizations')
      .set(as(ADMIN))
      .send({
        ou: 'AddBranchProbe',
        parentDn: orgA,
        twakeGroupLink: orgA,
      });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
  });
});
