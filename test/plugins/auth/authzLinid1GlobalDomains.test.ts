import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import AuthzScope from '../../../src/plugins/auth/authzScope';
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

/**
 * The administrators of --authz-global-organization give the organizations
 * their mail domains, as those of the top organization do: where the top
 * one is a bare container, nobody else could.
 */
describe('AuthzLinid1: the global organization links any domain', () => {
  let dm: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let top: string;
  let gov: string;
  let local: string;
  let domX: string;
  let domL: string;
  const user = (uid: string): string => `uid=${uid},ou=users,${base}`;
  const as = (uid: string): DmRequest =>
    ({ user: uid, headers: {} }) as unknown as DmRequest;
  const organization = (
    dn: string,
    domain?: string
  ): Record<string, unknown> => ({
    objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
    ou: /^ou=([^,]+)/.exec(dn)![1],
    ...(domain ? { twakeDomainLink: domain } : {}),
  });
  const links = async (dn: string): Promise<string[]> => {
    const res = (await dm.ldap.search(
      { scope: 'base', paged: false, attributes: ['twakeDomainLink'] },
      dn
    )) as SearchResult;
    const value = res.searchEntries[0]?.twakeDomainLink;
    return value === undefined
      ? []
      : (Array.isArray(value) ? value : [value]).map(String);
  };
  const refused = async (write: Promise<unknown>): Promise<void> => {
    try {
      await write;
    } catch (err) {
      expect(String(err)).to.match(/may not link .* to domain/);
      return;
    }
    throw new Error('the write was accepted');
  };
  const removeTree = async (dn: string): Promise<void> => {
    try {
      const res = (await dm.ldap.search(
        { paged: false, scope: 'one', attributes: ['1.1'] },
        dn
      )) as SearchResult;
      for (const entry of res.searchEntries) await removeTree(entry.dn);
    } catch {
      return;
    }
    await dm.ldap.delete(dn).catch(() => undefined);
  };

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
    // A top organization of the suite's own, so that its administrator is
    // the one this test names
    top = `ou=GODTop,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    gov = `ou=GODGov,${top}`;
    local = `ou=GODLocal,${gov}`;
    domX = `dc=godx,ou=domains,ou=nomenclature,${base}`;
    domL = `dc=godl,ou=domains,ou=nomenclature,${base}`;
    dm = new DM();
    await dm.ready;
    dm.config.ldap_top_organization = top;
    dm.config.authz_global_organization = gov;
    dm.config.enterprise_domain_link_attribute = 'twakeDomainLink';

    for (const uid of ['god.top', 'god.global', 'god.local']) {
      await dm.ldap.delete(user(uid)).catch(() => undefined);
      await dm.ldap.add(user(uid), {
        objectClass: ['top', 'inetOrgPerson'],
        uid,
        cn: uid,
        sn: uid,
      });
    }
    await removeTree(top);
    await dm.ldap.add(top, {
      ...organization(top),
      twakeLocalAdminLink: user('god.top'),
    });
    await dm.ldap.add(gov, {
      ...organization(gov),
      twakeLocalAdminLink: user('god.global'),
    });
    await dm.ldap.add(local, {
      ...organization(local, domL),
      twakeLocalAdminLink: user('god.local'),
    });

    await dm.registerPlugin('testAuth', new TestAuthPlugin(dm));
    await dm.registerPlugin('authzLinid1', new AuthzLinid1(dm));
    const scope = new AuthzScope(dm);
    await dm.registerPlugin('authzScope', scope);
    scope.afterLoad();
    dm.setupErrorMiddleware();
    request = supertest(dm.app);
  });

  after(async () => {
    if (!dm) return;
    await removeTree(top);
    for (const uid of ['god.top', 'god.global', 'god.local'])
      await dm.ldap.delete(user(uid)).catch(() => undefined);
    await dm.stop();
  });

  it('lets an administrator of the global organization create one linked to any domain', async () => {
    const dn = `ou=GODNew,${gov}`;
    await dm.ldap.add(dn, organization(dn, domX) as never, as('god.global'));
    expect(await links(dn)).to.deep.equal([domX]);
  });

  it('lets them link one below to any domain', async () => {
    await dm.ldap.modify(
      local,
      { add: { twakeDomainLink: domX } },
      as('god.global')
    );
    expect(await links(local)).to.have.members([domL, domX]);
    await dm.ldap.modify(local, { delete: { twakeDomainLink: domX } });
  });

  it('still refuses a local administrator a domain no organization above links', async () => {
    const dn = `ou=GODSub,${local}`;
    await refused(
      dm.ldap.add(dn, organization(dn, domX) as never, as('god.local'))
    );
    // One their organization links stays theirs to give
    await dm.ldap.add(dn, organization(dn, domL) as never, as('god.local'));
    expect(await links(dn)).to.deep.equal([domL]);
  });

  it('still lets the administrator of the top organization link any domain', async () => {
    const dn = `ou=GODTopNew,${top}`;
    await dm.ldap.add(dn, organization(dn, domX) as never, as('god.top'));
    expect(await links(dn)).to.deep.equal([domX]);
  });

  it('says in the scope who links any domain', async () => {
    const linksAny = async (uid: string): Promise<unknown> => {
      const res = await request
        .get('/api/v1/authz/scope')
        .set('Accept', 'application/json')
        .set('X-Test-User', uid);
      expect(res.status).to.equal(200);
      return res.body.linksAnyDomain;
    };
    expect(await linksAny('god.global')).to.equal(true);
    expect(await linksAny('god.top')).to.equal(true);
    expect(await linksAny('god.local')).to.equal(false);
  });
});
