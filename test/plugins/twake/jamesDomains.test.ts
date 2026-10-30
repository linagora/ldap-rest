import { expect } from 'chai';
import nock from 'nock';
import type { Entry } from 'ldapts';

import type { SearchResult } from '../../../src/lib/ldapActions';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
import TrashPlugin from '../../../src/plugins/ldap/trash';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

/**
 * A server with the James plugin, its WebAdmin calls recorded, and the
 * means to wait for what a write makes it do.
 *
 * The hooks run one after the other: one subscribed after the plugin's has
 * seen a write only once the plugin's calls about it are over. A request's
 * write is followed from onLdapEntryChange, a move made outside a request
 * from ldaprenamedone, and an account's provisioning from ldapadddone.
 */
const jamesServer = async (
  url: string,
  before: (dm: DM) => Promise<void> = () => Promise.resolve()
): Promise<{
  dm: DM;
  james: James;
  calls: string[];
  settled: (dn: string, write: () => Promise<unknown>) => Promise<void>;
  moved: (dn: string, write: () => Promise<unknown>) => Promise<void>;
  added: (dn: string, write: () => Promise<unknown>) => Promise<void>;
}> => {
  const calls: string[] = [];
  const changed: string[] = [];
  const renamed: string[] = [];
  const provisioned: string[] = [];
  const scope = nock(url).persist();
  for (const method of ['GET', 'PUT', 'POST', 'DELETE'])
    scope
      .intercept(() => true, method)
      .reply(function (uri: string) {
        calls.push(`${method} ${uri}`);
        return method === 'GET' ? [200, []] : [204, ''];
      });

  const dm = new DM();
  dm.config.james_webadmin_url = url;
  dm.config.james_init_delay = 0;
  dm.config.enterprise_domain_link_attribute = 'twakeDomainLink';
  // Without a substring rule, as some directories declare
  // mailAlternateAddress: `(labeledURI=*@domain)` matches nothing
  dm.config.alias_attribute = 'labeledURI';
  await dm.ready;
  await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
  await dm.registerPlugin('ldapGroups', new LdapGroups(dm));
  await before(dm);
  const james = new James(dm);
  await dm.registerPlugin('james', james);
  dm.hookBus.subscribe('onLdapEntryChange', (dn, _before, after) => {
    changed.push(dn.toLowerCase());
    if (after) changed.push(String(after.dn).toLowerCase());
  });
  dm.hookBus.subscribe('ldapadddone', dn => {
    provisioned.push(dn.toLowerCase());
  });
  dm.hookBus.subscribe('ldaprenamedone', (_dn, newDn) => {
    renamed.push(newDn.toLowerCase());
  });
  const waiting =
    (seen: string[]) =>
    async (dn: string, write: () => Promise<unknown>): Promise<void> => {
      seen.length = 0;
      await write();
      await waitFor(() => seen.includes(dn.toLowerCase()), {
        what: `the write of ${dn}`,
      });
    };
  return {
    dm,
    james,
    calls,
    settled: waiting(changed),
    moved: waiting(renamed),
    added: waiting(provisioned),
  };
};

const domainEntry = (dn: string, domain?: string): Record<string, unknown> => {
  const dc = /^dc=([^,]+)/.exec(dn)![1];
  return domain
    ? {
        objectClass: ['top', 'domain', 'domainRelatedObject'],
        dc,
        associatedDomain: domain,
      }
    : { objectClass: ['top', 'domain'], dc };
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

/**
 * The mail domains of the directory reach James: a domain entry added is a
 * domain created, one deleted a domain removed, unless an organization or
 * an address still needs it. Domains are nested here, as a deployment lays
 * them out: `dc=customs,dc=gov,dc=mn,ou=domains,…` under nodes naming none.
 */
describe('James Plugin - mail domains', () => {
  let dm: DM;
  let calls: string[];
  let settled: (dn: string, write: () => Promise<unknown>) => Promise<void>;
  let base: string;
  let branch: string;
  let mn: string;
  let gov: string;
  let customs: string;
  let org: string;
  let user: string;
  // What the suite had to create for the branch, in creation order
  const created: string[] = [];

  const domainCalls = (): string[] => calls.filter(c => c.includes('/domains'));
  const reset = (): void => {
    calls.length = 0;
  };

  const addDomain = (dn: string, domain?: string): Promise<void> =>
    settled(dn, () => dm.ldap.add(dn, domainEntry(dn, domain) as never));

  const remove = async (dn: string): Promise<void> => {
    await dm.ldap.delete(dn).catch(() => undefined);
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
    ({ dm, calls, settled } = await jamesServer(
      'http://james.domains.test:8000'
    ));

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
    await addDomain(mn);
    await addDomain(gov);
    reset();
  });

  afterEach(async () => {
    for (const dn of [
      user,
      org,
      `dc=other,${gov}`,
      `dc=any,${gov}`,
      `dc=customs,${mn}`,
      `dc=customs,${branch}`,
      customs,
      gov,
      mn,
    ])
      await remove(dn);
  });

  after(async () => {
    if (dm) for (const dn of [...created].reverse()) await remove(dn);
    nock.cleanAll();
    nock.enableNetConnect();
  });

  const addUser = (attributes: Record<string, string>): Promise<boolean> =>
    dm.ldap.add(user, {
      objectClass: ['top', 'inetOrgPerson'],
      uid: 'jamesdomainsuser',
      cn: 'Officer',
      sn: 'Officer',
      ...attributes,
    });

  it('creates the domain of a nested entry, and none for the nodes above', async () => {
    const edu = gov.replace('dc=gov', 'dc=edu');
    await addDomain(edu);
    await settled(edu, () => dm.ldap.delete(edu));
    expect(domainCalls()).to.eql([]);

    await addDomain(customs, 'Customs.Gov.MN');
    expect(domainCalls()).to.eql(['PUT /domains/customs.gov.mn']);
  });

  it('skips `*`, which allows every domain and is none', async () => {
    await addDomain(`dc=any,${gov}`, '*');
    await settled(`dc=any,${gov}`, () => dm.ldap.delete(`dc=any,${gov}`));
    expect(domainCalls()).to.eql([]);
  });

  it('removes the domain with its entry, and nothing with the nodes', async () => {
    await addDomain(customs, 'customs.gov.mn');
    reset();
    await settled(customs, () => dm.ldap.delete(customs));
    expect(domainCalls()).to.eql(['DELETE /domains/customs.gov.mn']);

    reset();
    await settled(gov, () => dm.ldap.delete(gov));
    expect(domainCalls()).to.eql([]);
  });

  it('keeps a domain another entry still declares', async () => {
    await addDomain(customs, 'customs.gov.mn');
    await addDomain(`dc=other,${gov}`, 'customs.gov.mn');
    reset();
    await settled(customs, () => dm.ldap.delete(customs));
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
    reset();
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
    reset();
    await settled(customs, () => dm.ldap.delete(customs));
    expect(domainCalls()).to.eql(['DELETE /domains/customs.gov.mn']);
  });

  it('refuses the delete while an address is at the domain', async () => {
    await addDomain(customs, 'customs.gov.mn');
    await addUser({ mail: 'officer@CUSTOMS.gov.mn' });
    reset();
    expect(await refusal(dm.ldap.delete(customs))).to.match(
      /addresses at customs\.gov\.mn still exist/
    );
    expect(domainCalls()).to.eql([]);
  });

  it('creates the new domain and removes the old one at a rename', async () => {
    await addDomain(customs, 'customs.gov.mn');
    reset();
    await settled(customs, () =>
      dm.ldap.modify(customs, {
        replace: { associatedDomain: 'douane.gov.mn' },
      })
    );
    expect(domainCalls()).to.have.members([
      'PUT /domains/douane.gov.mn',
      'DELETE /domains/customs.gov.mn',
    ]);
  });

  it('refuses the rename while an alias is at the old domain, without a substring rule', async () => {
    await addDomain(customs, 'customs.gov.mn');
    await addUser({
      mail: 'officer@example.org',
      labeledURI: 'smtp:chief@customs.gov.mn',
    });
    reset();
    expect(
      await refusal(
        dm.ldap.modify(customs, {
          replace: { associatedDomain: 'douane.gov.mn' },
        })
      )
    ).to.match(/Cannot remove mail domain customs\.gov\.mn/);
    expect(domainCalls()).to.eql([]);
  });

  describe('between two domain branches', () => {
    let restore: () => void;

    // `dc=mn` stands for a branch of its own, whose domains another
    // attribute names
    beforeEach(() => {
      const loaded = dm.loadedPlugins as Record<string, unknown>;
      const previous = loaded.ldapFlatGeneric;
      loaded.ldapFlatGeneric = {
        instances: [
          {
            base: branch,
            schema: {
              attributes: { associatedDomain: { role: 'domainName' } },
            },
          },
          {
            base: mn,
            schema: { attributes: { description: { role: 'domainName' } } },
          },
        ],
      };
      restore = () => {
        if (previous) loaded.ldapFlatGeneric = previous;
        else delete loaded.ldapFlatGeneric;
      };
    });

    afterEach(() => restore());

    it('refuses a move dropping a domain addresses are at', async () => {
      await addDomain(`dc=customs,${branch}`, 'customs.gov.mn');
      await addUser({ mail: 'officer@customs.gov.mn' });
      reset();
      expect(
        await refusal(
          dm.ldap.rename(`dc=customs,${branch}`, `dc=customs,${mn}`)
        )
      ).to.match(/Cannot move .*addresses at customs\.gov\.mn still exist/);
      expect(domainCalls()).to.eql([]);
    });

    it('follows a move between them', async () => {
      await addDomain(`dc=customs,${branch}`, 'customs.gov.mn');
      await settled(`dc=customs,${branch}`, () =>
        dm.ldap.modify(`dc=customs,${branch}`, {
          replace: { description: 'douane.gov.mn' },
        })
      );
      reset();
      await settled(`dc=customs,${mn}`, () =>
        dm.ldap.rename(`dc=customs,${branch}`, `dc=customs,${mn}`)
      );
      expect(domainCalls()).to.have.members([
        'PUT /domains/douane.gov.mn',
        'DELETE /domains/customs.gov.mn',
      ]);
    });
  });
});

/**
 * The trash turns a delete into a move no request hook sees, and runs here
 * before the plugin's delete guard: the move is followed, and a domain still
 * in use kept.
 */
describe('James Plugin - mail domains in the trash', () => {
  let dm: DM;
  let james: James;
  let calls: string[];
  let settled: (dn: string, write: () => Promise<unknown>) => Promise<void>;
  let moved: (dn: string, write: () => Promise<unknown>) => Promise<void>;
  let added: (dn: string, write: () => Promise<unknown>) => Promise<void>;
  let base: string;
  let branch: string;
  let trashBase: string;
  // Created by the trash, if it had to
  let trashCreated: boolean;
  let customs: string;
  let trashed: string;
  let user: string;
  const created: string[] = [];

  const domainCalls = (): string[] => calls.filter(c => c.includes('/domains'));

  const exists = async (dn: string): Promise<boolean> => {
    try {
      const found = (await dm.ldap.search(
        { scope: 'base', paged: false, attributes: ['1.1'] },
        dn
      )) as SearchResult;
      return found.searchEntries.length > 0;
    } catch {
      return false;
    }
  };

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    base = process.env.DM_LDAP_BASE as string;
    branch = `ou=domains,ou=nomenclature,${base}`;
    trashBase = `ou=trash,${base}`;
    customs = `dc=trashcustoms,${branch}`;
    trashed = `dc=trashcustoms,${trashBase}`;
    user = `uid=jamestrashuser,${base}`;

    nock.disableNetConnect();
    ({ dm, james, calls, settled, moved, added } = await jamesServer(
      'http://james.trash.test:8000',
      async server => {
        server.config.trash_base = trashBase;
        server.config.trash_watched_bases = branch;
        await server.registerPlugin('trash', new TrashPlugin(server));
      }
    ));
    trashCreated = !(await exists(trashBase));
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
    await settled(customs, () =>
      dm.ldap.add(customs, domainEntry(customs, 'trash.gov.mn') as never)
    );
    calls.length = 0;
  });

  // Each write waited for, so that no call to James is still on its way
  // when the next test, or nock's cleanup, comes
  afterEach(async () => {
    if (await exists(user)) await settled(user, () => dm.ldap.delete(user));
    if (await exists(customs))
      await moved(trashed, () => dm.ldap.delete(customs));
    if (await exists(trashed))
      await settled(trashed, () => dm.ldap.delete(trashed));
  });

  after(async () => {
    if (dm) {
      // The branch is watched: deleting it moves it to the trash
      for (const dn of [...created].reverse())
        await dm.ldap.delete(dn).catch(() => undefined);
      for (const dn of [`ou=domains,${trashBase}`, trashed])
        await dm.ldap.delete(dn).catch(() => undefined);
      if (trashCreated) await dm.ldap.delete(trashBase).catch(() => undefined);
    }
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('removes a domain the trash takes, and creates it again on its way back', async () => {
    await moved(trashed, () => dm.ldap.delete(customs));
    expect(domainCalls()).to.eql(['DELETE /domains/trash.gov.mn']);

    calls.length = 0;
    await moved(customs, () => dm.ldap.move(trashed, customs));
    expect(domainCalls()).to.eql(['PUT /domains/trash.gov.mn']);
  });

  it('keeps in James a domain the trash takes while addresses are at it', async () => {
    await added(user, () =>
      dm.ldap.add(user, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'jamestrashuser',
        cn: 'Trash',
        sn: 'Trash',
        mail: 'officer@trash.gov.mn',
      })
    );
    calls.length = 0;
    await moved(trashed, () => dm.ldap.delete(customs));
    expect(domainCalls()).to.eql([]);
  });

  it('warns at startup that the trash watches the domains', () => {
    const warned: string[] = [];
    const warn = james.logger.warn;
    james.logger.warn = ((message: string) => {
      warned.push(String(message));
      return james.logger;
    }) as typeof warn;
    try {
      james.afterLoad();
    } finally {
      james.logger.warn = warn;
    }
    expect(warned.join('\n')).to.match(
      /the trash watches the mail domains .*--trash-watched-bases/
    );
    // Without a list, the trash watches every branch
    warned.length = 0;
    const listed = dm.config.trash_watched_bases;
    dm.config.trash_watched_bases = '';
    james.logger.warn = ((message: string) => {
      warned.push(String(message));
      return james.logger;
    }) as typeof warn;
    try {
      james.afterLoad();
    } finally {
      james.logger.warn = warn;
      dm.config.trash_watched_bases = listed;
    }
    expect(warned.join('\n')).to.match(/every branch/);
  });
});

/**
 * The guard's searches walk page by page, and stop at the first hit: a
 * single search fails once the answer outgrows the server's size limit,
 * and the domain would then never leave James. No directory here: the
 * searches are recorded.
 */
describe('James Plugin - mail domain searches', () => {
  it('walks every search of the delete guard by pages', async () => {
    const dm = new DM();
    await dm.ready;
    dm.config.james_webadmin_url = 'http://james.searches.test:8000';
    dm.config.enterprise_domain_link_attribute = 'twakeDomainLink';
    const base = dm.config.ldap_base as string;
    const dn = `dc=paged,ou=domains,ou=nomenclature,${base}`;
    const james = new James(dm);
    const searches: { filter?: unknown; paged?: unknown }[] = [];
    dm.ldap.search = (async (opts: { scope?: string; filter?: unknown }) => {
      if (opts.scope === 'base')
        return {
          searchEntries: [{ dn, associatedDomain: 'paged.gov.mn' }],
          searchReferences: [],
        };
      searches.push(opts);
      if (!(opts as { paged?: unknown }).paged)
        throw new Error('Size Limit Exceeded');
      return (async function* () {
        yield { searchEntries: [], searchReferences: [] };
      })();
    }) as unknown as typeof dm.ldap.search;

    const guard = james.hooks.ldapdeleterequest as unknown as (
      args: [string]
    ) => Promise<unknown>;
    await guard([dn]);
    expect(searches.map(s => String(s.filter))).to.eql([
      `(|(twakeDomainLink=${dn}))`,
      '(associatedDomain=paged.gov.mn)',
      '(|(mail=*)(mailAlternateAddress=*))',
    ]);
    expect(searches.every(s => s.paged)).to.equal(true);
  });
});
