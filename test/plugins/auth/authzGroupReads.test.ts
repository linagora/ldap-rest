/**
 * The group reads carry the request, so authzPerBranch judges them on the
 * group base like any other read: they used to reach the directory without
 * one, and every authenticated caller read every group.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapGroups from '../../../src/plugins/ldap/groups';
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

describe('Group reads under authzPerBranch', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let groupBranch: string;
  const GROUP = 'perbranch-read-group';
  const READER = 'perbranch.reader';
  const STRANGER = 'perbranch.stranger';
  let previousConfig: string | undefined;
  let previousFilter: string | undefined;

  const as = (user: string) => ({
    'X-Test-User': user,
    Accept: 'application/json',
  });

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    previousFilter = process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    delete process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    previousConfig = process.env.DM_AUTHZ_PER_BRANCH_CONFIG;

    groupBranch =
      process.env.DM_LDAP_GROUP_BASE || `ou=groups,${process.env.DM_LDAP_BASE}`;
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [READER]: {
          [groupBranch]: { read: true, write: false, delete: false },
        },
      },
      groups: {},
    });

    server = new DM();
    await server.ready;
    const groups = new LdapGroups(server);
    expect(groups.base).to.equal(groupBranch);

    await server.ldap
      .delete(`cn=${GROUP},${groupBranch}`)
      .catch(() => undefined);
    await server.ldap.add(`cn=${GROUP},${groupBranch}`, {
      objectClass: ['top', 'groupOfNames'],
      cn: GROUP,
      member: `uid=someone,${process.env.DM_LDAP_BASE}`,
    });

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    await server.registerPlugin('ldapGroups', groups);
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    await server.ldap
      .delete(`cn=${GROUP},${groupBranch}`)
      .catch(() => undefined);
    if (previousConfig === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    else process.env.DM_AUTHZ_PER_BRANCH_CONFIG = previousConfig;
    if (previousFilter === undefined)
      delete process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    else process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES = previousFilter;
  });

  it('lets a caller holding read on the group base list and read groups', async () => {
    const list = await request.get('/api/v1/ldap/groups').set(as(READER));
    expect(list.status).to.equal(200);
    expect(list.body).to.have.property(GROUP);
    const one = await request
      .get(`/api/v1/ldap/groups/${GROUP}`)
      .set(as(READER));
    expect(one.status).to.equal(200);
  });

  it('refuses the list and a group to a caller holding no read there', async () => {
    const list = await request.get('/api/v1/ldap/groups').set(as(STRANGER));
    expect(list.status).to.equal(403);
    const one = await request
      .get(`/api/v1/ldap/groups/${GROUP}`)
      .set(as(STRANGER));
    expect(one.status).to.equal(403);
  });
});
