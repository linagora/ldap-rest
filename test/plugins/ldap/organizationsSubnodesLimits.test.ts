/**
 * What the subnodes endpoints answer when the directory will not answer in
 * full (#179).
 *
 * `getOrganisationSubnodes` searched a node's children with no limit and
 * caught everything as "no children", so a directory answering
 * `sizeLimitExceeded` — a branch holding more organizations than its server
 * will list at once — became `200 []`, with the only trace at `debug`. An
 * empty tree is what a console draws for that, and nothing says why.
 *
 * The directory is stubbed here rather than reconfigured: the suite binds as
 * the root DN, which OpenLDAP exempts from its own size limit, so the
 * refusal cannot be provoked through the real server. What each case asserts
 * is the classification — which failure means emptiness, which one means a
 * partial answer, and which one has no business being swallowed at all.
 */
import { expect } from 'chai';
import type { Request } from 'express';
import type { SearchResult } from 'ldapts';

import { DM } from '../../../src/bin';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import type { AttributesList } from '../../../src/lib/ldapActions';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

interface Call {
  options: { scope?: string; paged?: unknown; sizeLimit?: number };
  base: string;
  req?: unknown;
}

const ldapError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code });

const asResult = (entries: AttributesList[]): SearchResult =>
  ({ searchEntries: entries, searchReferences: [] }) as unknown as SearchResult;

const pageOf = (entries: AttributesList[]): AsyncGenerator<SearchResult> =>
  (async function* () {
    yield asResult(entries);
  })() as AsyncGenerator<SearchResult>;

/** A refusal raised from the walk, where a paged search actually fails */
const refusingPages = (err: Error): AsyncGenerator<SearchResult> =>
  (async function* () {
    await Promise.resolve();
    throw err;
    // eslint-disable-next-line no-unreachable
    yield asResult([]);
  })() as AsyncGenerator<SearchResult>;

const children = (count: number, dn: string): AttributesList[] =>
  Array.from({ length: count }, (_, i) => ({
    dn: `ou=child${i},${dn}`,
    ou: [`child${i}`],
    objectClass: ['organizationalUnit'],
  }));

describe('Organization subnodes, when the directory will not answer in full', function () {
  let server: DM;
  let plugin: LdapOrganizations;
  let orgDn: string;
  let calls: Call[];

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    server = new DM();
    await server.ready;
    plugin = new LdapOrganizations(server);
    orgDn = `ou=crowded,${process.env.DM_LDAP_TOP_ORGANIZATION as string}`;
  });

  beforeEach(() => {
    calls = [];
  });

  /** Answer every search from `handler`, and remember what was asked */
  const stub = (
    handler: (call: Call) => SearchResult | AsyncGenerator<SearchResult>
  ): void => {
    server.ldap.search = ((
      options: Call['options'],
      base: string,
      req?: unknown
    ) => {
      const call = { options, base, req };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as unknown as typeof server.ldap.search;
  };

  /** A directory that refuses the children and answers everything else */
  const refusingChildren = (available: number): void =>
    stub(call => {
      // A paged search is answered with a generator, a bounded one with a
      // result: the plugin asks for the second only after the first refused.
      if (call.options.scope !== 'one') return pageOf([]);
      if (!call.options.sizeLimit)
        return refusingPages(ldapError(4, 'Size Limit Exceeded'));
      return asResult(
        children(available, orgDn).slice(0, call.options.sizeLimit)
      );
    });

  it('should not answer an empty tree to a directory that refused a long one', async () => {
    refusingChildren(500);
    const subnodes = await plugin.getOrganisationSubnodes(orgDn);
    const organizations = subnodes.filter(e => !e._isMoreIndicator);
    expect(organizations.length, JSON.stringify(subnodes.slice(0, 2))).to.equal(
      50
    );
    expect(String(organizations[0].dn)).to.match(/^ou=child0,/);
  });

  it('should say the answer is partial rather than let it pass for whole', async () => {
    refusingChildren(500);
    const subnodes = await plugin.getOrganisationSubnodes(orgDn);
    const indicator = subnodes.find(e => e._isMoreIndicator);
    expect(
      indicator,
      'a truncated answer carries the row that says so'
    ).to.not.equal(undefined);
    expect(String(indicator?.dn)).to.equal(`more-organizations-${orgDn}`);
    expect(String(indicator?.cn)).to.match(/more organizations/);
  });

  it('should ask the second time with a limit, which is what makes it answer', async () => {
    // ldapts raises `sizeLimitExceeded` only when the request carried no
    // limit of its own. A bounded search is answered where an unbounded one
    // is refused, and that is the whole mechanism of the fallback.
    refusingChildren(500);
    await plugin.getOrganisationSubnodes(orgDn);
    const childSearches = calls.filter(c => c.options.scope === 'one');
    expect(childSearches.length).to.equal(2);
    expect(childSearches[0].options.sizeLimit).to.equal(undefined);
    expect(childSearches[1].options.sizeLimit).to.equal(51);
  });

  it('should answer nothing when the node truly holds nothing', async () => {
    stub(call =>
      call.options.scope === 'one'
        ? refusingPages(ldapError(32, 'No such object'))
        : pageOf([])
    );
    expect(await plugin.getOrganisationSubnodes(orgDn)).to.deep.equal([]);
    // One search: noSuchObject is an answer, not something to retry.
    expect(calls.filter(c => c.options.scope === 'one').length).to.equal(1);
  });

  it('should raise a failure that is neither, rather than dress it as empty', async () => {
    // A directory that is down, a bind that lost its rights, a filter the
    // server will not process: answering `[]` to any of them makes a broken
    // directory look exactly like an empty one.
    stub(call =>
      call.options.scope === 'one'
        ? refusingPages(ldapError(53, 'Unwilling to perform'))
        : pageOf([])
    );
    let raised: Error | undefined;
    await plugin
      .getOrganisationSubnodes(orgDn)
      .catch((err: Error) => (raised = err));
    expect(raised?.message).to.match(/Unwilling to perform/);
  });

  it('should keep the attached entries readable when their search is refused', async () => {
    stub(call => {
      if (call.options.scope === 'one') return pageOf([]);
      if (!call.options.sizeLimit)
        return refusingPages(ldapError(4, 'Size Limit Exceeded'));
      return asResult(children(call.options.sizeLimit, orgDn));
    });
    const subnodes = await plugin.getOrganisationSubnodes(orgDn);
    expect(subnodes.filter(e => !e._isMoreIndicator).length).to.equal(50);
    const indicator = subnodes.find(e => e._isMoreIndicator);
    expect(String(indicator?.dn)).to.equal(`more-${orgDn}`);
  });

  it('should still count what it left out when the directory answers in full', async () => {
    stub(call =>
      call.options.scope === 'one'
        ? pageOf([])
        : pageOf(
            children(60, orgDn).map(e => ({ ...e, objectClass: ['person'] }))
          )
    );
    const subnodes = await plugin.getOrganisationSubnodes(orgDn);
    const indicator = subnodes.find(e => e._isMoreIndicator);
    expect(String(indicator?.cn)).to.equal('... 10 more elements');
    expect(String(indicator?._totalCount)).to.equal('60');
  });

  it('should raise when the branch the attached entries live in is absent', async () => {
    // `noSuchObject` is emptiness for a node's children and a configuration
    // error here: the base is the parent of `ldap_top_organization`, not
    // anything the caller named. An empty answer would leave an operator
    // with a working-looking endpoint and no attached entry anywhere.
    stub(call =>
      call.options.scope === 'one'
        ? pageOf([])
        : refusingPages(ldapError(32, 'No such object'))
    );
    let raised: Error | undefined;
    await plugin
      .getOrganisationSubnodes(orgDn)
      .catch((err: Error) => (raised = err));
    expect(raised?.message).to.match(/No such object/);
  });

  it('should say a node is crowded once, not once per listing', async () => {
    // A console expanding a tree lists the same node on every refresh. The
    // answer stays partial until the directory is reconfigured, so repeating
    // the warning buries the log without adding anything.
    const warned: string[] = [];
    const realWarn = server.logger.warn.bind(server.logger);
    server.logger.warn = ((message: string) => {
      warned.push(String(message));
      return server.logger;
    }) as unknown as typeof server.logger.warn;
    try {
      refusingChildren(500);
      const crowded = `ou=seen-once,${orgDn}`;
      await plugin.getOrganisationSubnodes(crowded);
      await plugin.getOrganisationSubnodes(crowded);
      await plugin.getOrganisationSubnodes(`ou=another,${orgDn}`);
      expect(warned.filter(m => m.includes('seen-once')).length).to.equal(1);
      expect(warned.filter(m => m.includes('another')).length).to.equal(1);
    } finally {
      server.logger.warn = realWarn;
    }
  });

  it('should carry the request into the searches a subnode search makes', async () => {
    // Without it every authorization plugin skips its check — the gap the
    // flat routes had until 0.8.2, still open on this route.
    stub(call => (call.options.scope === 'one' ? pageOf([]) : pageOf([])));
    const req = { user: 'someone' } as unknown as Request;
    await plugin.searchOrganisationSubnodes(orgDn, 'thing', req);
    expect(calls.length).to.be.greaterThan(1);
    expect(calls.every(c => c.req === req)).to.equal(true);
  });
});
