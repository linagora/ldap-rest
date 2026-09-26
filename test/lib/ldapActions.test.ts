import LdapActions from '../../src/lib/ldapActions';
import { expect } from 'chai';
import { Client, SearchResult } from 'ldapts';
import { parseConfig } from '../../src/lib/parseConfig';
import configTemplate from '../../src/config/args';
import { DM } from '../../src/bin';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';

let ldapActions: LdapActions;

describe('ldapActions', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  beforeEach(() => {
    ldapActions = new LdapActions(new DM());
  });

  describe('search', () => {
    it('should perform a search and return results', async () => {
      const options = {
        filter: '(uid=p*)',
        paged: false,
      };
      let result = await ldapActions.search(options);
      if (!(result as SearchResult).searchEntries) {
        const tmp = await (result as AsyncGenerator<SearchResult>).next();
        result = tmp.value;
      }
      expect(result).to.have.property('searchEntries');
      expect((result as SearchResult).searchEntries).to.be.an('array');
      expect((result as SearchResult).searchEntries.length).to.be.greaterThan(
        0
      );
    });
  });

  describe('Modify entries', () => {
    let testDN: string;
    let newDN: string;

    before(function () {
      // Skip tests if env vars are not set
      if (!process.env.DM_LDAP_BASE) {
        // eslint-disable-next-line no-console
        console.warn('Skipping LDAP modify: DM_LDAP_BASE not set');
        // @ts-ignore
        this.skip();
      }
      // Initialize DNs after env vars are set
      testDN = `uid=testuser,${process.env.DM_LDAP_BASE}`;
      newDN = `uid=newtestuser,${process.env.DM_LDAP_BASE}`;
    });

    describe('a modify that emits nothing', () => {
      const capture = (): { warn: string[]; debug: string[] } => {
        const said = { warn: [] as string[], debug: [] as string[] };
        const logger = ldapActions.logger as unknown as Record<
          string,
          (m: string) => void
        >;
        logger.warn = (m: string) => said.warn.push(m);
        logger.debug = (m: string) => said.debug.push(m);
        return said;
      };

      before(async () => {
        try {
          await ldapActions.delete(testDN);
        } catch {
          /* ignore */
        }
      });

      afterEach(async () => {
        try {
          await ldapActions.delete(testDN);
        } catch {
          /* ignore */
        }
      });

      beforeEach(async () => {
        await ldapActions.add(testDN, {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User',
          sn: 'User',
          uid: 'testuser',
        });
      });

      it('says nothing loud when the caller asked for nothing', async () => {
        // The routine case: a SCIM PATCH whose operations all turn out to be
        // no-ops still comes through so the authorization hooks run.
        const said = capture();
        expect(await ldapActions.modify(testDN, {})).to.be.false;
        expect(said.warn).to.deep.equal([]);
        expect(said.debug.join('\n')).to.match(/nothing to apply/);
      });

      it('warns when the caller asked for something and none of it was emitted', async () => {
        // Every change named here is dropped while the request is built, so
        // nothing reaches the directory — and the call still answers. Under
        // one debug line shared with the routine case, a translation bug
        // upstream was invisible from the outside.
        const said = capture();
        expect(await ldapActions.modify(testDN, { delete: [''] })).to.be.false;
        expect(said.warn.join('\n')).to.match(/emitted none/);
        expect(said.warn.join('\n')).to.include(testDN);
      });
    });

    describe('add', () => {
      afterEach(async () => {
        // Clean up: delete the test entry if it exists
        try {
          await ldapActions.delete(testDN);
        } catch (err) {
          // Ignore errors if the entry does not exist
        }
      });

      it('should add a new entry successfully, modify it and delete it successfully', async () => {
        const entry = {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User',
          sn: 'User',
          uid: 'testuser',
          mail: 'test@test.org',
        };
        const addResult = await ldapActions.add(testDN, entry);
        expect(addResult).to.be.true;

        // Verify the entry was added
        const searchOptions = {
          filter: '(uid=testuser)',
          paged: false,
        };
        const searchResult = await ldapActions.search(searchOptions);
        expect((searchResult as SearchResult).searchEntries.length).to.equal(1);
        expect((searchResult as SearchResult).searchEntries[0].dn).to.equal(
          testDN
        );

        await ldapActions.modify(testDN, {
          replace: { mail: 't@t.org' },
        });
        const modifiedResult = await ldapActions.search(searchOptions);
        expect((modifiedResult as SearchResult).searchEntries.length).to.equal(
          1
        );
        expect(
          (modifiedResult as SearchResult).searchEntries[0].mail
        ).to.include('t@t.org');

        await ldapActions.delete('testuser');
        let result = await ldapActions.search({ filter: '(uid=testuser)' });
        if (!(result as SearchResult).searchEntries) {
          const tmp = await (result as AsyncGenerator<SearchResult>).next();
          result = tmp.value;
        }
        expect((result as SearchResult).searchEntries.length).to.equal(0);
      });

      it('should fail to add an entry that already exists', async () => {
        const entry = {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User',
          sn: 'User',
          uid: 'testuser',
          mail: 'test@test.org',
        };
        // First add
        const firstAdd = await ldapActions.add(testDN, entry);
        expect(firstAdd).to.be.true;

        // Second add should fail
        try {
          await ldapActions.add(testDN, entry);
          expect.fail('Expected error not thrown');
        } catch (err) {
          expect(err).to.have.property('message');
        }
      });
    });

    describe('rename', () => {
      afterEach(async () => {
        // Clean up: delete the test entry if it exists
        try {
          await ldapActions.delete(testDN);
        } catch (err) {
          // Ignore errors if the entry does not exist
        }
        try {
          await ldapActions.delete(newDN);
        } catch (err) {
          // Ignore errors if the entry does not exist
        }
      });

      it('should rename an existing entry successfully', async () => {
        const entry = {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User',
          sn: 'User',
          uid: 'testuser',
          mail: 'test@test.org',
        };
        const addResult = await ldapActions.add(testDN, entry);
        expect(addResult).to.be.true;

        // Rename the entry
        const renameResult = await ldapActions.rename(testDN, newDN);
        expect(renameResult).to.be.true;

        // Verify the old DN no longer exists
        let result = await ldapActions.search({ filter: '(uid=testuser)' });
        if (!(result as SearchResult).searchEntries) {
          const tmp = await (result as AsyncGenerator<SearchResult>).next();
          result = tmp.value;
        }
        expect((result as SearchResult).searchEntries.length).to.equal(0);

        // Verify the new DN exists
        result = await ldapActions.search({ filter: '(uid=newtestuser)' });
        if (!(result as SearchResult).searchEntries) {
          const tmp = await (result as AsyncGenerator<SearchResult>).next();
          result = tmp.value;
        }
        expect((result as SearchResult).searchEntries.length).to.equal(1);
        expect((result as SearchResult).searchEntries[0].dn).to.equal(newDN);
        expect((result as SearchResult).searchEntries[0].uid).to.equal(
          'newtestuser'
        );
      });
    });
  });

  describe('the base-scope search cache', function () {
    // --ldap-cache-ttl is read once, when ldapActions is built, so each of
    // these builds the instance it needs. Two instances of ldapActions are
    // two caches: writes made through one never drop what the other cached,
    // which is how "did that read come from the cache?" gets answered
    // without counting connections — change the entry behind a cache's back
    // and see whether it still answers the old value.
    const build = (ttlSeconds: number | undefined): LdapActions => {
      if (ttlSeconds === undefined) delete process.env.DM_LDAP_CACHE_TTL;
      else process.env.DM_LDAP_CACHE_TTL = String(ttlSeconds);
      return new LdapActions(new DM());
    };

    let BASE: string;
    let dnA: string;
    let dnB: string;
    let branch: string;
    let renamedBranch: string;
    let childDn: string;
    let savedTtl: string | undefined;

    const read = async (
      ldap: LdapActions,
      dn: string,
      attributes: string[] = ['mail', 'uid']
    ): Promise<SearchResult> =>
      (await ldap.search(
        { paged: false, scope: 'base', filter: '(objectClass=*)', attributes },
        dn
      )) as SearchResult;

    const mailOf = async (ldap: LdapActions, dn: string): Promise<unknown> =>
      (await read(ldap, dn)).searchEntries[0]?.mail;

    const person = (uid: string, mail: string) => ({
      objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
      cn: 'Cache Test User',
      sn: 'User',
      uid,
      mail,
    });

    const thrownBy = async (fn: () => Promise<unknown>): Promise<unknown> => {
      try {
        await fn();
      } catch (err) {
        return err;
      }
      return undefined;
    };

    before(function () {
      savedTtl = process.env.DM_LDAP_CACHE_TTL;
      BASE = process.env.DM_LDAP_BASE as string;
      dnA = `uid=cacheuser,${BASE}`;
      dnB = `uid=cacheuserbis,${BASE}`;
      branch = `ou=cachebranch,${BASE}`;
      renamedBranch = `ou=cachebranchbis,${BASE}`;
      childDn = `uid=cachechild,${branch}`;
    });

    after(function () {
      if (savedTtl === undefined) delete process.env.DM_LDAP_CACHE_TTL;
      else process.env.DM_LDAP_CACHE_TTL = savedTtl;
    });

    // Cleanup runs through an instance of its own: deleting something the
    // test cached must not be what makes the next test pass.
    const wipe = async () => {
      const cleaner = build(0);
      for (const dn of [
        childDn,
        `uid=cachechild,${renamedBranch}`,
        dnA,
        dnB,
        branch,
        renamedBranch,
      ]) {
        try {
          await cleaner.delete(dn);
        } catch {
          /* not there, fine */
        }
      }
    };

    beforeEach(wipe);
    afterEach(wipe);

    it('serves a second identical search from the cache', async () => {
      const cached = build(60);
      const direct = build(0);
      await direct.add(dnA, person('cacheuser', 'before@test.org'));

      expect(await mailOf(cached, dnA)).to.include('before@test.org');

      // Behind that cache's back: another instance, another cache.
      await direct.modify(dnA, { replace: { mail: 'after@test.org' } });
      expect(await mailOf(direct, dnA)).to.include('after@test.org');

      // Cached, so the directory is not consulted and the old value stands.
      expect(await mailOf(cached, dnA)).to.include('before@test.org');
    });

    it('hands out a copy a caller cannot write back into the cache', async () => {
      const cached = build(60);
      const direct = build(0);
      await direct.add(dnA, person('cacheuser', 'before@test.org'));

      // The first read stores a copy and answers the original, so the entry
      // to poison is the one a *hit* hands back: its value arrays were the
      // very arrays the cache holds.
      await read(cached, dnA, ['objectClass']);
      const hit = (await read(cached, dnA, ['objectClass']))
        .searchEntries[0] as unknown as { objectClass: string[] };
      const before = [...hit.objectClass];

      // `objectClass` comes back as a list, which is what a caller would be
      // tempted to sort or push into. Doing so used to write into the cache,
      // and every later reader saw it until the TTL ran out.
      hit.objectClass.push('poisoned');

      const later = (await read(cached, dnA, ['objectClass']))
        .searchEntries[0] as unknown as { objectClass: string[] };
      expect(later.objectClass).to.deep.equal(before);
      expect(later.objectClass).to.not.include('poisoned');
    });

    it('keeps nothing from a read a write overtook', async () => {
      process.env.DM_LDAP_CACHE_TTL = '60';
      const dm = new DM();
      const cached = new LdapActions(dm);
      const direct = build(0);
      await direct.add(dnA, person('cacheuser', 'before@test.org'));

      // The window, made reachable: a write landing after the directory has
      // answered this read and before the read stores it. `ldapsearchresult`
      // is the one place between those two moments, and it is a plugin hook
      // — a write made through this instance runs its own invalidation
      // before the read below ever reaches its store.
      let overtaken = false;
      dm.hooks.ldapsearchresult = [
        async (result: SearchResult) => {
          if (!overtaken) {
            overtaken = true;
            await cached.modify(dnA, { replace: { mail: 'after@test.org' } });
          }
          return result;
        },
      ];

      // This read is answered with the directory as it was when the server
      // replied, which is what has to be returned. What must not happen is
      // that answer being kept for the rest of the TTL.
      expect(await mailOf(cached, dnA)).to.include('before@test.org');
      expect(await mailOf(cached, dnA)).to.include('after@test.org');
    });

    it('caches nothing with the default TTL', async () => {
      const dflt = build(undefined);
      const direct = build(0);
      await direct.add(dnA, person('cacheuser', 'before@test.org'));

      expect(await mailOf(dflt, dnA)).to.include('before@test.org');
      await direct.modify(dnA, { replace: { mail: 'after@test.org' } });
      expect(await mailOf(dflt, dnA)).to.include('after@test.org');
    });

    it('keys on the attributes asked for', async () => {
      const cached = build(60);
      await cached.add(dnA, person('cacheuser', 'before@test.org'));

      const narrow = await read(cached, dnA, ['mail']);
      expect(narrow.searchEntries[0]).to.not.have.property('cn');

      // A key that ignored the attribute list would answer this one with
      // the entry above, which has no cn in it.
      const wide = await read(cached, dnA, ['mail', 'cn']);
      expect(wide.searchEntries[0]).to.have.property('cn');
    });

    it('drops what a modify changed', async () => {
      const cached = build(60);
      await cached.add(dnA, person('cacheuser', 'before@test.org'));
      expect(await mailOf(cached, dnA)).to.include('before@test.org');

      await cached.modify(dnA, { replace: { mail: 'after@test.org' } });
      expect(await mailOf(cached, dnA)).to.include('after@test.org');
    });

    it('drops what a modify changed, whatever case the DN is written in', async () => {
      const cached = build(60);
      await cached.add(dnA, person('cacheuser', 'before@test.org'));
      expect(await mailOf(cached, dnA)).to.include('before@test.org');

      // The directory reads these two as one entry; a cache that compares
      // DNs as plain strings does not, and keeps the old mail.
      await cached.modify(dnA.toUpperCase(), {
        replace: { mail: 'after@test.org' },
      });
      expect(await mailOf(cached, dnA)).to.include('after@test.org');
    });

    it('drops what a delete removed', async () => {
      const cached = build(60);
      await cached.add(dnA, person('cacheuser', 'before@test.org'));
      expect(await mailOf(cached, dnA)).to.include('before@test.org');

      await cached.delete(dnA);
      const err = await thrownBy(() => read(cached, dnA));
      expect(err, 'a deleted entry must not still be served').to.be.an('error');
      expect((err as { code?: number }).code).to.equal(32);
    });

    it('drops what an add re-created', async () => {
      const cached = build(60);
      const direct = build(0);
      await direct.add(dnA, person('cacheuser', 'before@test.org'));
      expect(await mailOf(cached, dnA)).to.include('before@test.org');

      // Removed by something else — another replica, LSC, ldapmodify — and
      // created again through this instance.
      await direct.delete(dnA);
      await cached.add(dnA, person('cacheuser', 'after@test.org'));
      expect(await mailOf(cached, dnA)).to.include('after@test.org');
    });

    it('drops the old DN of a rename', async () => {
      const cached = build(60);
      await cached.add(dnA, person('cacheuser', 'before@test.org'));
      expect(await mailOf(cached, dnA)).to.include('before@test.org');

      await cached.rename(dnA, dnB);
      const err = await thrownBy(() => read(cached, dnA));
      expect(err, 'a renamed entry must not answer under its old DN').to.be.an(
        'error'
      );
      expect((err as { code?: number }).code).to.equal(32);
      expect(await mailOf(cached, dnB)).to.include('before@test.org');
    });

    it('drops the new DN of a rename', async () => {
      const cached = build(60);
      const direct = build(0);
      await direct.add(dnA, person('cacheuser', 'moved@test.org'));
      await direct.add(dnB, person('cacheuserbis', 'previous@test.org'));

      // Cache the entry that holds the target DN today...
      expect(await mailOf(cached, dnB)).to.include('previous@test.org');
      // ...take it out of the way behind that cache's back, and put the
      // other entry in its place.
      await direct.delete(dnB);
      await cached.rename(dnA, dnB);

      expect(await mailOf(cached, dnB)).to.include('moved@test.org');
    });

    it('drops both ends of a move', async () => {
      const cached = build(60);
      const direct = build(0);
      await direct.add(dnA, person('cacheuser', 'moved@test.org'));
      await direct.add(dnB, person('cacheuserbis', 'previous@test.org'));
      expect(await mailOf(cached, dnA)).to.include('moved@test.org');
      expect(await mailOf(cached, dnB)).to.include('previous@test.org');

      await direct.delete(dnB);
      await cached.move(dnA, dnB);

      const err = await thrownBy(() => read(cached, dnA));
      expect(err, 'a moved entry must not answer under its old DN').to.be.an(
        'error'
      );
      expect((err as { code?: number }).code).to.equal(32);
      expect(await mailOf(cached, dnB)).to.include('moved@test.org');
    });

    it('drops the cached children of a renamed branch', async () => {
      const cached = build(60);
      await cached.add(branch, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'cachebranch',
      });
      await cached.add(childDn, person('cachechild', 'child@test.org'));
      expect(await mailOf(cached, childDn)).to.include('child@test.org');

      // One operation at the branch, every DN below it changes.
      await cached.rename(branch, renamedBranch);

      const err = await thrownBy(() => read(cached, childDn));
      expect(
        err,
        'a child of a renamed branch must not answer under its old DN'
      ).to.be.an('error');
      expect((err as { code?: number }).code).to.equal(32);
      expect(
        await mailOf(cached, `uid=cachechild,${renamedBranch}`)
      ).to.include('child@test.org');
    });
  });

  describe('the LDAP base', function () {
    const settings = [
      'DM_LDAP_URL',
      'DM_LDAP_DN',
      'DM_LDAP_PWD',
      'DM_LDAP_BASE',
    ];
    const saved: Record<string, string | undefined> = {};

    // The whole run shares one environment: whatever this suite sets or
    // deletes is given back exactly as it was found.
    before(() => {
      for (const name of settings) saved[name] = process.env[name];
    });

    after(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[name] = value;
        else delete process.env[name];
      }
    });

    it('refuses to start without --ldap-base', () => {
      // The other connection settings are given, so that the missing base is
      // the only thing that can be refused, and no directory is needed: the
      // refusal happens as the configuration is read.
      process.env.NODE_ENV = 'test';
      process.env.DM_LDAP_URL = process.env.DM_LDAP_URL || 'ldap://localhost';
      process.env.DM_LDAP_DN =
        process.env.DM_LDAP_DN || 'cn=admin,dc=example,dc=com';
      process.env.DM_LDAP_PWD = process.env.DM_LDAP_PWD || 'admin';
      delete process.env.DM_LDAP_BASE;
      expect(() => new DM()).to.throw(/LDAP base is not defined/);
    });
  });
});
