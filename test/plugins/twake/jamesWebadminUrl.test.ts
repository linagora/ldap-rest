import { expect } from 'chai';

import { DM } from '../../../src/bin';
import Calendar from '../../../src/plugins/twake/calendar';
import James from '../../../src/plugins/twake/james';
import MigrationProxy from '../../../src/plugins/twake/migrationProxy';

/**
 * Addresses come from the directory, and James and Calendar WebAdmin URLs are
 * built from them. Spliced raw, `/`, `?`, `#` and `%` split the URL, so a
 * delegated writer could make a call with the global WebAdmin token act on
 * another user. Every address must stay one encoded path segment.
 */
describe('Twake WebAdmin URLs built from addresses', () => {
  const base = 'http://james.url.test:8000';
  const dn = 'uid=u,ou=users,dc=example,dc=com';
  let dm: DM;
  let james: James;
  let requested: string[];

  const internals = (): Record<string, unknown> =>
    james as unknown as Record<string, unknown>;

  const jsonResponse = (): Response =>
    new Response('{"taskId":"task-1"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

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
      return jsonResponse();
    };
  });

  // Literal expectations: recomputing the encoding in the test would hide
  // the same mistake on both sides. `@` is a pchar and stays as written.
  const cases = [
    {
      mail: 'x/../../users/b@test.org',
      segment: 'x%2F..%2F..%2Fusers%2Fb@test.org',
    },
    { mail: 'a#b@test.org', segment: 'a%23b@test.org' },
    { mail: 'a?b@test.org', segment: 'a%3Fb@test.org' },
    { mail: 'a%2Fb@test.org', segment: 'a%252Fb@test.org' },
    { mail: 'user+tag@test.org', segment: 'user%2Btag@test.org' },
  ];

  for (const { mail, segment } of cases) {
    it(`keeps ${mail} as one segment of the quota URL`, async () => {
      await james.hooks.onLdapQuotaChange!(dn, mail, 0, 1024);
      expect(requested).to.deep.equal([`/quota/users/${segment}/size`]);
    });

    it(`keeps ${mail} as one segment of the alias URL`, async () => {
      await james.hooks.onLdapAliasChange!(dn, mail, [], ['alias@test.org']);
      expect(requested).to.deep.equal([
        `/address/aliases/${segment}/sources/alias@test.org`,
      ]);
    });
  }

  it('keeps an address as one segment of the forward URL', async () => {
    dm.config.james_sync_forwards = true;
    await james.hooks.onLdapForwardChange!(
      dn,
      'a?b@test.org',
      [],
      ['c#d@test.org']
    );
    expect(requested).to.deep.equal([
      '/address/forwards/a%3Fb@test.org/targets/c%23d@test.org',
    ]);
  });

  it('keeps both addresses as segments of the rename URL', async () => {
    await james.hooks.onLdapMailChange!(dn, 'a%2Fb@test.org', 'c#d@test.org');
    expect(requested).to.deep.equal([
      '/users/a%252Fb@test.org/rename/c%23d@test.org?action=rename&force',
    ]);
  });

  it('keeps an address as one segment when deleting its data', async () => {
    await james.deleteUserData('a#b@test.org');
    expect(requested).to.deep.equal([
      '/users/a%23b@test.org?action=deleteData',
    ]);
  });

  it('keeps an address as one segment of a delegation URL', async () => {
    dm.config.delegation_attribute = 'twakeDelegation';
    const plugin = internals();
    plugin.ldapGetAttributes = async () => ({ mail: 'owner@test.org' });
    plugin._getDelegateEmail = async () => 'delegate@test.org';

    await james._handleDelegationChange(dn, {
      twakeDelegation: [null, 'uid=delegate,ou=users'],
    } as never);

    expect(requested).to.deep.equal([
      '/users/owner@test.org/authorizedUsers/delegate@test.org',
    ]);
  });

  it('keeps a member address as one segment of a team-mailbox URL', async () => {
    const plugin = internals();
    plugin.getMemberEmails = async () => ['m@test.org'];

    await (
      james as unknown as {
        teamMailboxMembers: (
          dn: string,
          mail: string,
          method: 'PUT',
          members: string[]
        ) => Promise<void>;
      }
    ).teamMailboxMembers(dn, 'team@test.org', 'PUT', ['uid=m,ou=users']);

    expect(requested).to.deep.equal([
      '/domains/test.org/team-mailboxes/team/members/m@test.org',
    ]);
  });

  it('refuses a dot segment instead of sending the call elsewhere', async () => {
    let caught: unknown;
    try {
      await james.hooks.onLdapQuotaChange!(dn, '..', 0, 1024);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).to.contain('dot segment');
    expect(requested).to.deep.equal([]);
  });

  it('refuses an empty segment', async () => {
    let caught: unknown;
    try {
      await james.hooks.onLdapQuotaChange!(dn, '', 0, 1024);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).to.contain('empty segment');
    expect(requested).to.deep.equal([]);
  });

  it('refuses a dot forwarding target', async () => {
    dm.config.james_sync_forwards = true;
    let caught: unknown;
    try {
      await james.hooks.onLdapForwardChange!(dn, 'user@test.org', [], ['..']);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).to.contain('dot segment');
    expect(requested).to.deep.equal([]);
  });

  it('keeps a Calendar address as one segment when deleting its data', async () => {
    dm.config.calendar_webadmin_url = 'http://calendar.url.test:8000';
    const calendar = new Calendar(dm);
    const seen: string[] = [];
    (calendar as unknown as Record<string, unknown>).fetch = async (
      url: string
    ): Promise<Response> => {
      const parsed = new URL(url);
      seen.push(`${parsed.pathname}${parsed.search}`);
      return jsonResponse();
    };

    await calendar.deleteUserData('a#b@test.org');

    expect(seen).to.deep.equal(['/users/a%23b@test.org?action=deleteData']);
  });

  it('refuses a dot resource id instead of targeting the WebAdmin root', () => {
    dm.config.calendar_webadmin_url = 'http://calendar.url.test:8000';
    const calendar = new Calendar(dm);
    const resourceUrl = (
      calendar as unknown as { resourceUrl: (id: string) => string }
    ).resourceUrl;

    expect(() => resourceUrl.call(calendar, '..')).to.throw('dot segment');
  });

  it('refuses a dot address in a migration-proxy URL', () => {
    dm.config.migration_proxy_url = 'http://migration.url.test:8000';
    dm.config.migration_proxy_branch = ['dc=example,dc=com'];
    const proxy = new MigrationProxy(dm);
    const userUrl = (
      proxy as unknown as { userUrl: (address: string) => string }
    ).userUrl;

    expect(() => userUrl.call(proxy, '..')).to.throw('dot segment');
  });
});
