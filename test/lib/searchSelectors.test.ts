/**
 * The `*`, `+` and `1.1` selectors name no attribute: an entry read with them
 * must not carry them as keys.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapOrganizations from '../../src/plugins/ldap/organizations';
import type { SearchResult } from '../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS_WITH_ORG } from '../helpers/env';

describe('Attribute selectors in search results', function () {
  let server: DM;
  let base: string;
  let topOrg: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    topOrg = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    server.setupErrorMiddleware();
  });

  const noSelector = (entry: Record<string, unknown>): void => {
    for (const name of ['*', '+', '1.1'])
      expect(entry, name).not.to.have.property(name);
  };

  it('should leave them out of a search', async () => {
    const res = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['*', '+'] },
      topOrg
    )) as SearchResult;
    expect(res.searchEntries).to.have.length(1);
    noSelector(res.searchEntries[0]);
    expect(res.searchEntries[0]).to.have.property('entryUUID');
  });

  it('should leave them out of a paged search', async () => {
    const pages = (await server.ldap.search(
      { paged: true, scope: 'sub', attributes: ['*'], filter: '(ou=*)' },
      base
    )) as AsyncGenerator<SearchResult>;
    let seen = 0;
    for await (const page of pages)
      for (const entry of page.searchEntries) {
        noSelector(entry);
        seen++;
      }
    expect(seen).to.be.greaterThan(0);
  });

  it('should leave them out of what the routes answer', async () => {
    const request = supertest(server.app);
    const org = await request.get(
      `/api/v1/ldap/organizations/${encodeURIComponent(topOrg)}`
    );
    expect(org.status, JSON.stringify(org.body)).to.equal(200);
    noSelector(org.body);
    const users = await request.get('/api/v1/ldap/users');
    expect(users.status, JSON.stringify(users.body)).to.equal(200);
    const list = Object.values(users.body as Record<string, unknown>);
    expect(list.length).to.be.greaterThan(0);
    for (const user of list) noSelector(user as Record<string, unknown>);
  });
});
