import { expect } from 'chai';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';

/**
 * Addresses come from the directory, and James WebAdmin URLs are built from
 * them. Spliced raw, `/`, `?`, `#` and `%` split the URL, so a delegated
 * writer could make a call with the global WebAdmin token act on another
 * user. Every address must stay one encoded path segment.
 */
describe('James WebAdmin URLs built from addresses', () => {
  const base = 'http://james.url.test:8000';
  const dn = 'uid=u,ou=users,dc=example,dc=com';
  let dm: DM;
  let james: James;
  let requested: string[];

  const internals = (): Record<string, unknown> =>
    james as unknown as Record<string, unknown>;

  // `@` is a pchar and stays as written; the delimiters do not
  const segment = (value: string): string =>
    encodeURIComponent(value).replace(/%40/g, '@');

  beforeEach(async () => {
    dm = new DM();
    await dm.ready;
    dm.config.james_webadmin_url = base;
    dm.config.james_retry_attempts = 1;
    james = new James(dm);

    requested = [];
    const plugin = internals();
    plugin.isGroupDn = async () => false;
    plugin.defaultSignatures = async () => ({});
    plugin.dropStaleForwards = async () => undefined;
    plugin.ldapGetAttributes = async () => null;
    plugin.fetch = async (url: string): Promise<Response> => {
      const parsed = new URL(url);
      requested.push(`${parsed.pathname}${parsed.search}`);
      return new Response('{"taskId":"task-1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  for (const mail of [
    'x/../../users/b@test.org',
    'a#b@test.org',
    'a?b@test.org',
    'a%2Fb@test.org',
  ]) {
    it(`keeps ${mail} as one segment of the quota URL`, async () => {
      await james.hooks.onLdapQuotaChange!(dn, mail, 0, 1024);
      expect(requested).to.deep.equal([`/quota/users/${segment(mail)}/size`]);
    });

    it(`keeps ${mail} as one segment of the alias URL`, async () => {
      await james.hooks.onLdapAliasChange!(dn, mail, [], ['alias@test.org']);
      expect(requested).to.deep.equal([
        `/address/aliases/${segment(mail)}/sources/${segment('alias@test.org')}`,
      ]);
    });
  }

  it('keeps an address as one segment of the forward URL', async () => {
    dm.config.james_sync_forwards = true;
    const mail = 'a?b@test.org';
    const forward = 'c#d@test.org';
    await james.hooks.onLdapForwardChange!(dn, mail, [], [forward]);
    expect(requested).to.deep.equal([
      `/address/forwards/${segment(mail)}/targets/${segment(forward)}`,
    ]);
  });

  it('keeps both addresses as segments of the rename URL', async () => {
    const oldMail = 'a%2Fb@test.org';
    const newMail = 'c#d@test.org';
    await james.hooks.onLdapMailChange!(dn, oldMail, newMail);
    expect(requested).to.deep.equal([
      `/users/${segment(oldMail)}/rename/${segment(newMail)}` +
        '?action=rename&force',
    ]);
  });

  it('keeps an address as one segment when deleting its data', async () => {
    const mail = 'a#b@test.org';
    await james.deleteUserData(mail);
    expect(requested).to.deep.equal([
      `/users/${segment(mail)}?action=deleteData`,
    ]);
  });
});
