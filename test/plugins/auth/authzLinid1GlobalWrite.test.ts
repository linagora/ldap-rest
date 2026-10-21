import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import AuthzScope from '../../../src/plugins/auth/authzScope';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
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
 * The mail domains: every administrator reads them, only those of the
 * global organization add, change or delete them.
 */
describe('AuthzLinid1: global write branches', () => {
  let dm: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let top: string;
  let branch: string;
  let orgDn: string;
  // What the suite had to create for the branch, in creation order
  const created: string[] = [];
  const globalDn = (): string => `uid=gwb.global,ou=users,${base}`;
  const localDn = (): string => `uid=gwb.local,ou=users,${base}`;
  const seed = (): string => `dc=gwbseed,${branch}`;
  const api = '/api/v1/ldap/domains';
  // Every place the moved entries can be left in
  const moving = (): string[] => [
    `dc=gwbmove,dc=gwbseed,${branch}`,
    `dc=gwbmove,${branch}`,
    `dc=gwbmove,${orgDn}`,
    `dc=gwbmove,${top}`,
    `dc=gwbin,${branch}`,
    `dc=gwbin,${orgDn}`,
  ];
  const as = (user: string): DmRequest =>
    ({ user, headers: {} }) as unknown as DmRequest;
  const domainAt = (dn: string): Promise<boolean> =>
    dm.ldap.add(dn, {
      objectClass: ['top', 'domain', 'domainRelatedObject'],
      dc: /^dc=([^,]+)/.exec(dn)![1],
      associatedDomain: 'gwbmove.example.org',
    });
  const refused = async (write: Promise<unknown>): Promise<void> => {
    try {
      await write;
    } catch (err) {
      expect(String(err)).to.match(/\[authz-forbidden\]/);
      return;
    }
    throw new Error('the write was accepted');
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
    top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    branch = `ou=domains,ou=nomenclature,${base}`;
    orgDn = `ou=GWB Org,${top}`;
    dm = new DM();
    await dm.ready;

    for (const [dn, uid] of [
      [globalDn(), 'gwb.global'],
      [localDn(), 'gwb.local'],
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
      ou: 'GWB Org',
      twakeLocalAdminLink: localDn(),
    });
    // The global administrator administers the top organization
    await dm.ldap.modify(top, {
      add: {
        objectClass: 'twakeDepartment',
        twakeLocalAdminLink: globalDn(),
      },
    });
    for (const [dn, ou] of [
      [`ou=nomenclature,${base}`, 'nomenclature'],
      [branch, 'domains'],
    ]) {
      try {
        await dm.ldap.add(dn, { objectClass: ['organizationalUnit'], ou });
        created.push(dn);
      } catch {
        // Already there
      }
    }
    await dm.ldap.add(seed(), {
      objectClass: ['top', 'domain', 'domainRelatedObject'],
      dc: 'gwbseed',
      associatedDomain: 'gwbseed.example.org',
    });

    dm.config.ldap_flat_schema = [
      './static/schemas/twake/nomenclature/twakeDomain.json',
    ];
    dm.config.authz_global_write_branch = [branch];
    await dm.registerPlugin('testAuth', new TestAuthPlugin(dm));
    await dm.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(dm));
    await dm.registerPlugin('authzLinid1', new AuthzLinid1(dm));
    const scope = new AuthzScope(dm);
    await dm.registerPlugin('authzScope', scope);
    scope.afterLoad();
    dm.setupErrorMiddleware();
    request = supertest(dm.app);
  });

  after(async () => {
    if (!dm) return;
    for (const dc of ['gwbseed', 'gwbnew', 'gwblocal'])
      await dm.ldap.delete(`dc=${dc},${branch}`).catch(() => undefined);
    for (const dn of moving()) await dm.ldap.delete(dn).catch(() => undefined);
    for (const dn of [...created].reverse())
      await dm.ldap.delete(dn).catch(() => undefined);
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

  it('lets the administrator of the top organization add, change and delete', async () => {
    const added = await request
      .post(api)
      .set('X-Test-User', 'gwb.global')
      .send({ dc: 'gwbnew', associatedDomain: 'gwbnew.example.org' });
    expect(added.status, JSON.stringify(added.body)).to.equal(201);
    const changed = await request
      .put(`${api}/gwbnew`)
      .set('X-Test-User', 'gwb.global')
      .send({ replace: { description: 'New' } });
    expect(changed.status, JSON.stringify(changed.body)).to.equal(200);
    const deleted = await request
      .delete(`${api}/gwbnew`)
      .set('X-Test-User', 'gwb.global');
    expect(deleted.status, JSON.stringify(deleted.body)).to.equal(200);
  });

  it('lets a local administrator read them', async () => {
    const list = await request.get(api).set('X-Test-User', 'gwb.local');
    expect(list.status).to.equal(200);
    expect(JSON.stringify(list.body)).to.include('gwbseed.example.org');
    const one = await request
      .get(`${api}/gwbseed`)
      .set('X-Test-User', 'gwb.local');
    expect(one.status).to.equal(200);
    expect(one.body.associatedDomain).to.equal('gwbseed.example.org');

    // A search from above the branch brings them back too
    const result = (await dm.ldap.search(
      {
        filter: '(associatedDomain=gwbseed.example.org)',
        scope: 'sub',
        attributes: ['associatedDomain'],
        paged: false,
      },
      base,
      { user: 'gwb.local', headers: {} } as unknown as DmRequest
    )) as SearchResult;
    expect(result.searchEntries.map(entry => entry.dn)).to.deep.equal([seed()]);
  });

  it('refuses a local administrator any write', async () => {
    const added = await request
      .post(api)
      .set('X-Test-User', 'gwb.local')
      .send({ dc: 'gwblocal', associatedDomain: 'gwblocal.example.org' });
    expect(added.status).to.equal(403);
    const changed = await request
      .put(`${api}/gwbseed`)
      .set('X-Test-User', 'gwb.local')
      .send({ replace: { description: 'Mine' } });
    expect(changed.status).to.equal(403);
    const deleted = await request
      .delete(`${api}/gwbseed`)
      .set('X-Test-User', 'gwb.local');
    expect(deleted.status).to.equal(403);
    const kept = (await dm.ldap.search(
      { scope: 'base', paged: false },
      seed()
    )) as SearchResult;
    expect(kept.searchEntries).to.have.length(1);
  });

  it('offers to create a domain to the global administrators only', async () => {
    const creates = async (user: string): Promise<boolean> => {
      const res = await request
        .get('/api/v1/authz/scope')
        .set('Accept', 'application/json')
        .set('X-Test-User', user);
      expect(res.status).to.equal(200);
      return (res.body.entities as { name: string; create: boolean }[]).find(
        entity => entity.name === 'domains'
      )!.create;
    };
    expect(await creates('gwb.global')).to.equal(true);
    expect(await creates('gwb.local')).to.equal(false);
  });

  it('refuses to start with the global organization in a global write branch', () => {
    dm.config.authz_global_organization = `ou=inside,${branch}`;
    try {
      expect(() => new AuthzLinid1(dm)).to.throw(
        /lies in the global write branch/
      );
    } finally {
      dm.config.authz_global_organization = '';
    }
  });

  it('reads them as every administrator, writes them as the global ones', async () => {
    const authz = dm.loadedPlugins['authzLinid1'] as AuthzLinid1;
    expect(await authz.getUserPermissions(localDn(), branch)).to.deep.equal({
      read: true,
      write: false,
      delete: false,
    });
    expect(await authz.getUserPermissions(globalDn(), branch)).to.deep.equal({
      read: true,
      write: true,
      delete: true,
    });
  });

  describe('moves', () => {
    afterEach(async () => {
      for (const dn of moving())
        await dm.ldap.delete(dn).catch(() => undefined);
    });

    it('lets a global administrator move within, out of and into them', async () => {
      const global = as('gwb.global');
      await domainAt(`dc=gwbmove,${branch}`);
      // Within, a domain nested under another
      await dm.ldap.rename(
        `dc=gwbmove,${branch}`,
        `dc=gwbmove,dc=gwbseed,${branch}`,
        global
      );
      // Out, to an organization they hold
      await dm.ldap.rename(
        `dc=gwbmove,dc=gwbseed,${branch}`,
        `dc=gwbmove,${top}`,
        global
      );
      // And in again
      await dm.ldap.rename(`dc=gwbmove,${top}`, `dc=gwbmove,${branch}`, global);
      const there = (await dm.ldap.search(
        { scope: 'base', paged: false },
        `dc=gwbmove,${branch}`
      )) as SearchResult;
      expect(there.searchEntries).to.have.length(1);
    });

    it('refuses a local administrator a move out, though they read there', async () => {
      await domainAt(`dc=gwbmove,${branch}`);
      // Write on their organization, read on the branch: taking the entry
      // out of it is a delete there
      await refused(
        dm.ldap.rename(
          `dc=gwbmove,${branch}`,
          `dc=gwbmove,${orgDn}`,
          as('gwb.local')
        )
      );
      const kept = (await dm.ldap.search(
        { scope: 'base', paged: false },
        `dc=gwbmove,${branch}`
      )) as SearchResult;
      expect(kept.searchEntries).to.have.length(1);
    });

    it('refuses a local administrator a move in', async () => {
      await domainAt(`dc=gwbin,${orgDn}`);
      await refused(
        dm.ldap.rename(
          `dc=gwbin,${orgDn}`,
          `dc=gwbin,${branch}`,
          as('gwb.local')
        )
      );
    });
  });

  it('refuses to start with a branch given by both options', () => {
    dm.config.authz_global_branch = [branch.toUpperCase()];
    try {
      expect(() => new AuthzLinid1(dm)).to.throw(/overlap/);
    } finally {
      dm.config.authz_global_branch = [];
    }
  });

  it('refuses to start with a write branch in a global branch, or holding one', () => {
    for (const global of [`ou=nomenclature,${base}`, `ou=sub,${branch}`]) {
      dm.config.authz_global_branch = [global];
      try {
        expect(() => new AuthzLinid1(dm), global).to.throw(/overlap/);
      } finally {
        dm.config.authz_global_branch = [];
      }
    }
  });
});
