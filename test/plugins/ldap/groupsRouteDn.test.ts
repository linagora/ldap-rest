/**
 * What the group routes do with a name carrying a comma (#395).
 *
 * A group is named by its `cn`, or by its DN: any identifier with a comma
 * was taken for a DN as it stood. One the directory refuses as a DN made the
 * route answer 500, and a well-formed DN anywhere else was read — or
 * written, or deleted — as a group: `GET /groups/<an account's DN>` answered
 * the account.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { isDnSyntax } from '../../../src/lib/utils';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Group routes and the DN they are given', function () {
  let server: DM;
  let plugin: LdapGroups;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let accountDn: string;
  const named = 'routedn.group';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    server = new DM();
    await server.ready;
    server.config.group_schema = '';
    plugin = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', plugin);
    server.setupErrorMiddleware();
    request = supertest(server.app);
    await plugin.addGroup(named, [], { description: 'A group' });
    accountDn = `uid=routedn-account,ou=users,${base}`;
    await server.ldap
      .add(accountDn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'routedn-account',
        cn: 'routedn-account',
        sn: 'routedn-account',
      })
      .catch(() => undefined);
  });

  after(async () => {
    await plugin.deleteGroup(named).catch(() => undefined);
    await server.ldap.delete(accountDn).catch(() => undefined);
  });

  const get = (id: string) =>
    request
      .get(`/api/v1/ldap/groups/${encodeURIComponent(id)}`)
      .set('Accept', 'application/json');

  it('answers 400 for a name the directory would not take as a DN', async () => {
    for (const id of ['a,b', 'a,b=']) {
      const res = await get(id);
      expect(res.status, `${id}: ${JSON.stringify(res.body)}`).to.equal(400);
      expect(res.body.error).to.match(/is not a valid DN/);
    }
  });

  it('answers 404 for an entry outside the groups branch', async () => {
    const res = await get(accountDn);
    expect(res.status, JSON.stringify(res.body)).to.equal(404);
    expect(res.body.error).to.equal('Group not found');
  });

  it('writes nothing outside the groups branch', async () => {
    const del = await request
      .delete(`/api/v1/ldap/groups/${encodeURIComponent(accountDn)}`)
      .set('Accept', 'application/json');
    expect(del.status, JSON.stringify(del.body)).to.equal(404);
    const still = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['1.1'] },
      accountDn
    )) as { searchEntries: unknown[] };
    expect(still.searchEntries).to.have.length(1);
  });

  it('still reads a group by its name, and by its DN', async () => {
    expect((await get(named)).status).to.equal(200);
    expect((await get(`cn=${named},${plugin.base as string}`)).status).to.equal(
      200
    );
  });

  it('tells a DN from what is not one', () => {
    for (const dn of [
      'cn=a,ou=groups,dc=x',
      'cn=a\\,b,dc=x',
      'cn=a+sn=b,dc=x',
      '2.5.4.3=a,dc=x',
    ])
      expect(isDnSyntax(dn), dn).to.equal(true);
    for (const dn of ['a,b', 'a,b=', 'cn=a,,dc=x', '=a,dc=x', 'cn="a,dc=x'])
      expect(isDnSyntax(dn), dn).to.equal(false);
  });
});
