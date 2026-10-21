import { expect } from 'chai';
import nock from 'nock';
import type { Entry } from 'ldapts';

import type { SearchResult } from '../../../src/lib/ldapActions';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

/**
 * The mail domains of the directory reach James: a domain entry added is a
 * domain created, one deleted a domain removed, unless an organization or
 * an address still needs it. Domains are nested here, as a deployment lays
 * them out: `dc=customs,dc=gov,dc=mn,ou=domains,…` under nodes naming none.
 */
describe('James Plugin - mail domains', () => {
  const url = 'http://james.domains.test:8000';
  let dm: DM;
  let base: string;
  let branch: string;
  let mn: string;
  let gov: string;
  let customs: string;
  let org: string;
  let user: string;
  let calls: string[];
  let changed: string[];
  // What the suite had to create for the branch, in creation order
  const created: string[] = [];

  const domainCalls = (): string[] => calls.filter(c => c.includes('/domains'));

  // Every write fires onLdapEntryChange once its hooks are done with it:
  // waiting for that, then a little, is waiting for the calls it makes
  const settled = async (dn: string): Promise<void> => {
    await waitFor(() => changed.includes(dn.toLowerCase()), {
      what: `the change of ${dn}`,
    });
    await new Promise(resolve => setTimeout(resolve, 200));
  };

  const addDomain = async (dn: string, domain?: string): Promise<void> => {
    const dc = /^dc=([^,]+)/.exec(dn)![1];
    await dm.ldap.add(
      dn,
      domain
        ? {
            objectClass: ['top', 'domain', 'domainRelatedObject'],
            dc,
            associatedDomain: domain,
          }
        : { objectClass: ['top', 'domain'], dc }
    );
    await settled(dn);
  };

  const remove = async (dn: string): Promise<void> => {
    await dm.ldap.delete(dn).catch(() => undefined);
  };

  const refusal = async (write: Promise<unknown>): Promise<string> => {
    try {
      await write;
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).to.equal(409);
      return (err as Error).message;
    }
    throw new Error('the write was accepted');
  };

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    base = process.env.DM_LDAP_BASE as string;
    branch = `ou=domains,ou=nomenclature,${base}`;
    mn = `dc=mn,${branch}`;
    gov = `dc=gov,${mn}`;
    customs = `dc=customs,${gov}`;
    org = `ou=JamesDomainsOrg,${base}`;
    user = `uid=jamesdomainsuser,${base}`;

    nock.disableNetConnect();
    const scope = nock(url).persist();
    for (const method of ['GET', 'PUT', 'POST', 'DELETE'])
      scope
        .intercept(() => true, method)
        .reply(function (uri) {
          calls.push(`${method} ${uri}`);
          return method === 'GET' ? [200, []] : [204, ''];
        });

    dm = new DM();
    dm.config.james_webadmin_url = url;
    dm.config.james_init_delay = 0;
    dm.config.enterprise_domain_link_attribute = 'twakeDomainLink';
    await dm.ready;
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', new LdapGroups(dm));
    await dm.registerPlugin('james', new James(dm));
    dm.hooks.onLdapEntryChange = [
      ...(dm.hooks.onLdapEntryChange || []),
      (dn: string, _before: Entry | null, after: Entry | null) => {
        changed.push(dn.toLowerCase());
        if (after) changed.push(String(after.dn).toLowerCase());
      },
    ];

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
  });

  beforeEach(async () => {
    calls = [];
    changed = [];
    await addDomain(mn);
    await addDomain(gov);
    calls = [];
  });

  afterEach(async () => {
    for (const dn of [
      user,
      org,
      `dc=other,${gov}`,
      `dc=any,${gov}`,
      customs,
      gov,
      mn,
    ])
      await remove(dn);
  });

  after(async () => {
    for (const dn of [...created].reverse()) await remove(dn);
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('creates the domain of a nested entry, and none for the nodes above', async () => {
    // The nodes of the beforeEach made no call
    calls = [];
    await addDomain(gov.replace('dc=gov', 'dc=edu'));
    await remove(gov.replace('dc=gov', 'dc=edu'));
    expect(domainCalls()).to.eql([]);

    await addDomain(customs, 'Customs.Gov.MN');
    expect(domainCalls()).to.eql(['PUT /domains/customs.gov.mn']);
  });

  it('skips `*`, which allows every domain and is none', async () => {
    await addDomain(`dc=any,${gov}`, '*');
    await dm.ldap.delete(`dc=any,${gov}`);
    await settled(`dc=any,${gov}`);
    expect(domainCalls()).to.eql([]);
  });

  it('removes the domain with its entry, and nothing with the nodes', async () => {
    await addDomain(customs, 'customs.gov.mn');
    calls = [];
    await dm.ldap.delete(customs);
    await settled(customs);
    expect(domainCalls()).to.eql(['DELETE /domains/customs.gov.mn']);

    changed = [];
    await dm.ldap.delete(gov);
    await settled(gov);
    expect(domainCalls()).to.eql(['DELETE /domains/customs.gov.mn']);
  });

  it('keeps a domain another entry still declares', async () => {
    await addDomain(customs, 'customs.gov.mn');
    await addDomain(`dc=other,${gov}`, 'customs.gov.mn');
    calls = [];
    await dm.ldap.delete(customs);
    await settled(customs);
    expect(domainCalls()).to.eql([]);
  });

  it('refuses the delete while an organization links the entry', async () => {
    await addDomain(customs, 'customs.gov.mn');
    // Spelled otherwise than the entry: a link names it as a DN
    await dm.ldap.add(org, {
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou: 'JamesDomainsOrg',
      twakeDomainLink: customs.replace(
        'dc=customs,dc=gov',
        'DC=Customs, dc=gov'
      ),
    });
    calls = [];
    expect(await refusal(dm.ldap.delete(customs))).to.match(
      /organization still links mail domain customs\.gov\.mn/
    );
    const kept = (await dm.ldap.search(
      { scope: 'base', paged: false },
      customs
    )) as SearchResult;
    expect(kept.searchEntries).to.have.length(1);
    expect(domainCalls()).to.eql([]);
  });

  it('compares the whole DN: a link to the node above is none', async () => {
    await addDomain(customs, 'customs.gov.mn');
    await dm.ldap.add(org, {
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou: 'JamesDomainsOrg',
      twakeDomainLink: gov,
    });
    calls = [];
    await dm.ldap.delete(customs);
    await settled(customs);
    expect(domainCalls()).to.eql(['DELETE /domains/customs.gov.mn']);
  });

  it('refuses the delete while an address is at the domain', async () => {
    await addDomain(customs, 'customs.gov.mn');
    await dm.ldap.add(user, {
      objectClass: ['top', 'twakeAccount'],
      uid: 'jamesdomainsuser',
      mail: 'officer@CUSTOMS.gov.mn',
    });
    calls = [];
    expect(await refusal(dm.ldap.delete(customs))).to.match(
      /addresses at customs\.gov\.mn still exist/
    );
    expect(domainCalls()).to.eql([]);
  });

  it('creates the new domain and removes the old one at a rename', async () => {
    await addDomain(customs, 'customs.gov.mn');
    calls = [];
    changed = [];
    await dm.ldap.modify(customs, {
      replace: { associatedDomain: 'douane.gov.mn' },
    });
    await settled(customs);
    expect(domainCalls()).to.have.members([
      'PUT /domains/douane.gov.mn',
      'DELETE /domains/customs.gov.mn',
    ]);
  });

  it('refuses the rename while an alias is at the old domain', async () => {
    await addDomain(customs, 'customs.gov.mn');
    await dm.ldap.add(user, {
      objectClass: ['top', 'twakeAccount'],
      uid: 'jamesdomainsuser',
      mail: 'officer@example.org',
      mailAlternateAddress: 'smtp:chief@customs.gov.mn',
    });
    calls = [];
    expect(
      await refusal(
        dm.ldap.modify(customs, {
          replace: { associatedDomain: 'douane.gov.mn' },
        })
      )
    ).to.match(/Cannot remove mail domain customs\.gov\.mn/);
    expect(domainCalls()).to.eql([]);
  });
});
