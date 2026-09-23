/**
 * Keyed storage kept in the directory.
 *
 * The same contract as the file store, against a real directory, plus the two
 * things that belong to this backend: a record written twice takes the update
 * path rather than failing — recognised by the LDAP result code and not by
 * the wording of a message this repository writes about itself — and the
 * branch is left as it was found.
 */
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import LdapStore from '../../../src/plugins/storage/ldap';
import type { SearchResult } from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Keyed storage, in the directory', function () {
  let server: DM;
  let store: LdapStore;
  let branch: string;
  const inAnHour = (): number => Date.now() + 3600_000;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    branch = `ou=StorageRecords,${process.env.DM_LDAP_BASE as string}`;
    server = new DM();
    await server.ready;
    await server.ldap
      .add(branch, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'StorageRecords',
      })
      .catch(() => undefined);
    store = new LdapStore(server, branch, 'applicationProcess');
  });

  after(async () => {
    store?.stopSweeping();
    const res = (await server.ldap
      .search({ paged: false, scope: 'one' }, branch)
      .catch(() => ({ searchEntries: [] }))) as SearchResult;
    for (const e of res.searchEntries || [])
      await server.ldap.delete(String(e.dn)).catch(() => undefined);
    await server.ldap.delete(branch).catch(() => undefined);
  });

  it('should give back what was kept', async () => {
    await store.set('bcl', 'k1', 'hello', inAnHour());
    expect(await store.get('bcl', 'k1')).to.equal('hello');
  });

  it('should know nothing of a key never written', async () => {
    expect(await store.get('bcl', 'never')).to.equal(null);
  });

  it('should keep two consumers apart', async () => {
    await store.set('bcl', 'shared', 'from bcl', inAnHour());
    await store.set('locks', 'shared', 'from locks', inAnHour());
    expect(await store.get('bcl', 'shared')).to.equal('from bcl');
    expect(await store.get('locks', 'shared')).to.equal('from locks');
  });

  it('should take the same key twice without raising', async () => {
    // Writing an existing record is ordinary. It is recognised by the LDAP
    // result code 68, so this also says the code survives the wrapper.
    await store.set('bcl', 'twice', 'first', inAnHour());
    await store.set('bcl', 'twice', 'second', inAnHour());
    expect(await store.get('bcl', 'twice')).to.equal('second');
  });

  it('should answer expiry on read, before any sweep', async () => {
    await store.set('bcl', 'stale', 'gone', Date.now() - 1000);
    expect(await store.get('bcl', 'stale')).to.equal(null);
  });

  it('should forget a key on demand', async () => {
    await store.set('bcl', 'k2', 'here', inAnHour());
    await store.delete('bcl', 'k2');
    expect(await store.get('bcl', 'k2')).to.equal(null);
  });

  it('should reclaim what expired and leave the rest', async () => {
    await store.set('bcl', 'swept', 'gone', Date.now() - 1000);
    // `get` answers null for an expired record whether or not it was
    // reclaimed, so the assertion is on the branch: one fewer entry.
    const count = async (): Promise<number> =>
      (
        (await server.ldap.search(
          { paged: false, scope: 'one', attributes: ['dn'] },
          branch
        )) as SearchResult
      ).searchEntries.length;
    const before = await count();
    await store.sweep();
    expect(await count(), 'the expired record was reclaimed').to.equal(
      before - 1
    );
    expect(await store.get('bcl', 'k1')).to.equal('hello');
  });
});
