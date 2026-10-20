import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import PasswordPolicy from '../../../src/plugins/ldap/passwordPolicy';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import type { SearchResult } from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars } from '../../helpers/env';

/** Takes the caller from X-Test-User */
class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-test-user'];
    if (typeof user !== 'string') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.user = user;
    next();
  }
}

describe('AuthzLinid1: global branches', () => {
  let dm: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let top: string;
  let policyBase: string;
  let orgDn: string;
  const globalDn = (): string => `uid=ppg.global,ou=users,${base}`;
  const localDn = (): string => `uid=ppg.local,ou=users,${base}`;
  const api = '/api/v1/password-policies';

  before(function () {
    skipIfMissingEnvVars(this, [
      'DM_LDAP_DN',
      'DM_LDAP_PWD',
      'DM_LDAP_BASE',
      'DM_LDAP_TOP_ORGANIZATION',
    ]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    policyBase = `ou=ppolicyGlobal,${base}`;
    orgDn = `ou=PPG Org,${top}`;
    dm = new DM();
    await dm.ready;

    for (const [dn, uid] of [
      [globalDn(), 'ppg.global'],
      [localDn(), 'ppg.local'],
    ]) {
      await dm.ldap.delete(dn).catch(() => undefined);
      await dm.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid,
        cn: uid,
        sn: uid,
      });
    }
    await dm.ldap.add(orgDn, {
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou: 'PPG Org',
      twakeLocalAdminLink: localDn(),
    });
    // The global administrator administers the top organization
    await dm.ldap.modify(top, {
      add: {
        objectClass: 'twakeDepartment',
        twakeLocalAdminLink: globalDn(),
      },
    });
    await dm.ldap.add(policyBase, {
      objectClass: ['top', 'organizationalUnit'],
      ou: 'ppolicyGlobal',
    });
    await dm.ldap.add(`cn=default,${policyBase}`, {
      objectClass: ['top', 'person', 'pwdPolicy'],
      cn: 'default',
      sn: 'default',
      pwdAttribute: 'userPassword',
      pwdMinLength: '8',
    });

    dm.config.authz_global_branch = [policyBase];
    dm.config.ppolicy_base = policyBase;
    dm.config.ppolicy_default_dn = `cn=default,${policyBase}`;
    await dm.registerPlugin('testAuth', new TestAuthPlugin(dm));
    await dm.registerPlugin('authzLinid1', new AuthzLinid1(dm));
    await dm.registerPlugin('passwordPolicy', new PasswordPolicy(dm));
    dm.setupErrorMiddleware();
    request = supertest(dm.app);
  });

  after(async () => {
    if (!dm) return;
    for (const cn of ['default', 'extra'])
      await dm.ldap.delete(`cn=${cn},${policyBase}`).catch(() => undefined);
    await dm.ldap.delete(policyBase).catch(() => undefined);
    await dm.ldap
      .modify(top, {
        delete: {
          twakeLocalAdminLink: globalDn(),
          objectClass: 'twakeDepartment',
        },
      })
      .catch(() => undefined);
    await dm.ldap.delete(orgDn).catch(() => undefined);
    await dm.ldap.delete(globalDn()).catch(() => undefined);
    await dm.ldap.delete(localDn()).catch(() => undefined);
    await dm.stop();
  });

  it('lets the administrator of the top organization manage policies', async () => {
    const list = await request.get(api).set('X-Test-User', 'ppg.global');
    expect(list.status).to.equal(200);
    expect(list.body.policies.map((p: { cn: string }) => p.cn)).to.deep.equal([
      'default',
    ]);

    const changed = await request
      .patch(`${api}/default`)
      .set('X-Test-User', 'ppg.global')
      .send({ pwdMinLength: 12 });
    expect(changed.status).to.equal(200);
    expect(changed.body.pwdMinLength).to.equal(12);

    const created = await request
      .post(api)
      .set('X-Test-User', 'ppg.global')
      .send({ cn: 'extra' });
    expect(created.status).to.equal(201);
    const deleted = await request
      .delete(`${api}/extra`)
      .set('X-Test-User', 'ppg.global');
    expect(deleted.status).to.equal(200);
  });

  it('keeps a local administrator out of them', async () => {
    const list = await request.get(api).set('X-Test-User', 'ppg.local');
    expect(list.status).to.equal(403);
    const changed = await request
      .patch(`${api}/default`)
      .set('X-Test-User', 'ppg.local')
      .send({ pwdMinLength: 4 });
    expect(changed.status).to.equal(403);
    const created = await request
      .post(api)
      .set('X-Test-User', 'ppg.local')
      .send({ cn: 'extra' });
    expect(created.status).to.equal(403);
  });

  it('leaves a global branch out of a search from above it', async () => {
    const search = async (user: string): Promise<string[]> => {
      const result = (await dm.ldap.search(
        {
          filter: '(objectClass=pwdPolicy)',
          scope: 'sub',
          attributes: ['cn'],
          paged: false,
        },
        base,
        { user, headers: {} } as unknown as DmRequest
      )) as SearchResult;
      return result.searchEntries.map(entry => entry.dn);
    };
    expect(await search('ppg.local')).not.to.include(
      `cn=default,${policyBase}`
    );
    expect(await search('ppg.global')).to.include(`cn=default,${policyBase}`);
  });

  it('still lets a local administrator read the organizations', async () => {
    const result = (await dm.ldap.search(
      { scope: 'base', attributes: ['ou'], paged: false },
      orgDn,
      { user: 'ppg.local', headers: {} } as unknown as DmRequest
    )) as SearchResult;
    expect(result.searchEntries).to.have.length(1);
  });

  it('gives them to the administrators of the organization named', async () => {
    dm.config.authz_global_organization = orgDn;
    try {
      const list = await request.get(api).set('X-Test-User', 'ppg.local');
      expect(list.status).to.equal(200);
      // An administrator above that organization holds them too
      const above = await request.get(api).set('X-Test-User', 'ppg.global');
      expect(above.status).to.equal(200);
    } finally {
      dm.config.authz_global_organization = '';
    }
  });
});
