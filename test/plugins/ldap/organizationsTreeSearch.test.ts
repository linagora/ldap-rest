/**
 * The subtree search of the organizations plugin.
 *
 * `/subnodes/search` only looks one level down, which leaves a tree of a top
 * organization, one country node and a thousand departments without a usable
 * search. The route under test answers organizations at any depth, bounded.
 *
 * The directory is real for what it matches — depth, the base itself, the
 * path attribute — and modelled for what it cannot be asked to do: the suite
 * binds as the root DN, which OpenLDAP exempts from its size limit. The model
 * answers the way ldapts does, which is the point of it: a search carrying a
 * `sizeLimit` that the directory cuts shorter comes back as a plain short
 * list, the refusal swallowed, while a search carrying none raises it.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { SearchResult } from 'ldapts';

import { DM } from '../../../src/bin';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import type { AttributesList } from '../../../src/lib/ldapActions';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

interface Options {
  scope?: string;
  paged?: unknown;
  sizeLimit?: number;
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

describe('Organization subtree search', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  let server: DM;
  let plugin: LdapOrganizations;
  let request: ReturnType<typeof supertest>;
  let top: string;
  let childDn: string;
  let grandChildDn: string;
  let realSearchFn: DM['ldap']['search'];

  const names = (rows: AttributesList[]): string[] =>
    rows.map(r => (r.dn as string).toLowerCase());

  before(async () => {
    top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    childDn = `ou=treesearchchild,${top}`;
    grandChildDn = `ou=treesearchgrand,${childDn}`;
    server = new DM();
    await server.ready;
    plugin = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', plugin);
    plugin.api(server.app);
    request = supertest(server.app);
    realSearchFn = server.ldap.search.bind(server.ldap);

    const attrs = (
      ou: string,
      description: string,
      path?: string
    ): Record<string, string | string[]> => ({
      // The path attribute is allowed by the department class, which is
      // what a deployment configuring one puts on its organizations.
      objectClass:
        path && plugin.pathAttr
          ? ['top', 'organizationalUnit', 'twakeDepartment']
          : ['top', 'organizationalUnit'],
      ou,
      description,
      ...(path && plugin.pathAttr ? { [plugin.pathAttr]: path } : {}),
    });
    const entries: [string, Record<string, string | string[]>][] = [
      [childDn, attrs('treesearchchild', 'zzchild', 'treesearchchild')],
      [
        grandChildDn,
        attrs(
          'treesearchgrand',
          'zzgrand',
          'treesearchchild / treesearchgrand'
        ),
      ],
    ];
    for (const [dn, entry] of entries) {
      try {
        await server.ldap.delete(dn);
      } catch (e) {
        // ignore
      }
      await server.ldap.add(dn, entry);
    }
  });

  after(async () => {
    server.ldap.search = realSearchFn;
    for (const dn of [grandChildDn, childDn]) {
      try {
        await server.ldap.delete(dn);
      } catch (e) {
        // ignore
      }
    }
  });

  afterEach(() => {
    server.ldap.search = realSearchFn;
  });

  it('should find an organization several levels below the base', async () => {
    const res = await plugin.searchOrganisationTree(top, 'zzgrand');
    expect(names(res)).to.deep.equal([grandChildDn.toLowerCase()]);
  });

  it('should include the base itself when it matches', async () => {
    const res = await plugin.searchOrganisationTree(childDn, 'treesearch');
    expect(names(res)).to.have.members([
      childDn.toLowerCase(),
      grandChildDn.toLowerCase(),
    ]);
  });

  it('should match the path attribute', async function () {
    if (!plugin.pathAttr) return this.skip();
    const res = await plugin.searchOrganisationTree(
      top,
      'treesearchchild / treesearchgrand'
    );
    expect(names(res)).to.include(grandChildDn.toLowerCase());
  });

  /**
   * A directory holding `matches` matching organizations under `top`, that
   * lists at most `limit` of them in one answer, answered as ldapts would.
   */
  const directory = (matches: number, limit = Infinity): Options[] => {
    const asked: Options[] = [];
    const all = Array.from({ length: matches }, (_, i) => ({
      dn: `ou=o${i},${top}`,
      ou: [`o${i}`],
    }));
    server.ldap.search = ((options: Options) => {
      asked.push(options);
      if (!options.sizeLimit)
        return Promise.resolve(
          matches > limit
            ? refusingPages(ldapError(4, 'Size Limit Exceeded'))
            : pageOf(all)
        );
      return Promise.resolve(
        asResult(all.slice(0, Math.min(options.sizeLimit, limit)))
      );
    }) as unknown as typeof server.ldap.search;
    return asked;
  };

  const cap = (): number =>
    (server.config.ldap_organization_max_subnodes as number) || 50;

  it('should keep the cap, and count what it left out', async () => {
    const asked = directory(cap() + 5);
    const res = await plugin.searchOrganisationTree(top, 'o');
    expect(asked).to.have.length(1);
    expect(asked[0].scope).to.equal('sub');
    expect(asked[0].sizeLimit, 'unbounded, so a refusal raises').to.equal(
      undefined
    );
    expect(res).to.have.length(cap() + 1);
    const last = res[cap()];
    expect(last.dn).to.equal(`more-organizations-${top}`);
    expect(last._isMoreIndicator).to.equal('true');
    expect(last._displayedCount).to.equal(String(cap()));
    expect(last._totalCount).to.equal(String(cap() + 5));
    // The directory listed everything: the cut is ours, not its limit.
    expect(String(last.cn)).to.match(/5 more organizations/);
    expect(String(last.cn)).to.not.match(/directory/);
  });

  it('should count a single excess organization in the singular', async () => {
    directory(cap() + 1);
    const res = await plugin.searchOrganisationTree(top, 'o');
    expect(String(res[cap()].cn)).to.match(/\.\.\. 1 more organization,/);
  });

  it('should answer a full list without a sentinel', async () => {
    directory(cap());
    const res = await plugin.searchOrganisationTree(top, 'o');
    expect(res).to.have.length(cap());
    expect(res.some(r => r._isMoreIndicator)).to.equal(false);
  });

  it('should not let a directory limit below the cap pass for a whole answer', async () => {
    // The bind account hardened below the cap: ldapts would hand a bounded
    // first search back as `cap - 1` rows and no sign of the rest.
    const warned: string[] = [];
    const realWarn = server.logger.warn.bind(server.logger);
    server.logger.warn = ((message: string) => {
      warned.push(String(message));
      return server.logger;
    }) as unknown as typeof server.logger.warn;
    try {
      const asked = directory(500, cap() - 1);
      const res = await plugin.searchOrganisationTree(top, 'o');
      expect(asked.map(o => o.sizeLimit)).to.deep.equal([undefined, cap() + 1]);
      expect(res).to.have.length(cap());
      const last = res[cap() - 1];
      expect(last._isMoreIndicator).to.equal('true');
      expect(last._displayedCount).to.equal(String(cap() - 1));
      expect(last._totalCount, 'nothing counted the rest').to.equal(undefined);
      expect(String(last.cn)).to.match(/directory will list/);
      expect(warned.some(m => m.includes(top))).to.equal(true);
    } finally {
      server.logger.warn = realWarn;
    }
  });

  it('should answer a missing node with nothing, and raise anything else', async () => {
    server.ldap.search = (() =>
      Promise.resolve(
        refusingPages(ldapError(32, 'No Such Object'))
      )) as unknown as typeof server.ldap.search;
    expect(await plugin.searchOrganisationTree(top, 'o')).to.deep.equal([]);

    server.ldap.search = (() =>
      Promise.resolve(
        refusingPages(ldapError(51, 'Busy'))
      )) as unknown as typeof server.ldap.search;
    let failed = false;
    try {
      await plugin.searchOrganisationTree(top, 'o');
    } catch (e) {
      failed = true;
    }
    expect(failed).to.equal(true);
  });

  it('should answer 400 without q', async () => {
    const res = await request.get(
      `${server.config.api_prefix}/v1/ldap/organizations/${encodeURIComponent(top)}/search`
    );
    expect(res.status).to.equal(400);
  });

  it('should answer the matches over HTTP', async () => {
    const res = await request.get(
      `${server.config.api_prefix}/v1/ldap/organizations/${encodeURIComponent(top)}/search?q=zzgrand`
    );
    expect(res.status).to.equal(200);
    expect(names(res.body)).to.include(grandChildDn.toLowerCase());
  });

  it('should be advertised in the config endpoints', () => {
    const endpoints = plugin.getConfigApiData().endpoints as Record<
      string,
      string
    >;
    expect(endpoints.search).to.equal(
      `${server.config.api_prefix || '/api'}/v1/ldap/organizations/:dn/search`
    );
  });
});
