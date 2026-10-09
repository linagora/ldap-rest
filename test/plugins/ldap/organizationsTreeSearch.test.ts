/**
 * The subtree search of the organizations plugin.
 *
 * `/subnodes/search` only looks one level down, which leaves a tree of a top
 * organization, one country node and a thousand departments without a usable
 * search. The route under test answers organizations at any depth, bounded.
 *
 * The directory is real for what it matches — depth, the base itself, the
 * path attribute — and stubbed for what it cannot be asked to do: the suite
 * binds as the root DN, which OpenLDAP exempts from its size limit, so the
 * cap is checked on the request the plugin sends and the refusal is raised
 * by hand.
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

const asResult = (entries: AttributesList[]): SearchResult =>
  ({ searchEntries: entries, searchReferences: [] }) as unknown as SearchResult;

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

  it('should keep the cap and say the answer is partial', async () => {
    const cap = (server.config.ldap_organization_max_subnodes as number) || 50;
    let asked: { scope?: string; sizeLimit?: number } = {};
    server.ldap.search = ((options: typeof asked) => {
      asked = options;
      return Promise.resolve(
        asResult(
          Array.from({ length: cap + 1 }, (_, i) => ({
            dn: `ou=o${i},${top}`,
            ou: [`o${i}`],
          }))
        )
      );
    }) as unknown as typeof server.ldap.search;
    const res = await plugin.searchOrganisationTree(top, 'o');
    expect(asked.scope).to.equal('sub');
    expect(asked.sizeLimit).to.equal(cap + 1);
    expect(res).to.have.length(cap + 1);
    const last = res[cap];
    expect(last.dn).to.equal(`more-organizations-${top}`);
    expect(last._isMoreIndicator).to.equal('true');
    expect(last._displayedCount).to.equal(String(cap));
  });

  it('should read a refusal as a partial answer, and nothing else as one', async () => {
    server.ldap.search = (() =>
      Promise.reject(
        Object.assign(new Error('Size Limit Exceeded'), { code: 4 })
      )) as unknown as typeof server.ldap.search;
    const res = await plugin.searchOrganisationTree(top, 'o');
    expect(res).to.have.length(1);
    expect(res[0]._isMoreIndicator).to.equal('true');

    server.ldap.search = (() =>
      Promise.reject(
        Object.assign(new Error('No Such Object'), { code: 32 })
      )) as unknown as typeof server.ldap.search;
    expect(await plugin.searchOrganisationTree(top, 'o')).to.deep.equal([]);

    server.ldap.search = (() =>
      Promise.reject(
        Object.assign(new Error('Busy'), { code: 51 })
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
