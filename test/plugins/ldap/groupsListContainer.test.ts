/**
 * What the group listing does with an entry that is not a group.
 *
 * A deployment may keep its lists in branches — an `ou=` beside the lists
 * themselves — and the listing searches the whole subtree. The search asks
 * for the main attribute, so a container that has none is answered with an
 * empty array rather than with nothing; an array is truthy, so the guard
 * meant to skip a nameless entry let it through, and it reached the client
 * keyed on `''`. A console listing groups showed a row with no name, and
 * offered an empty option wherever it let one be picked.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Group listing and the branches under it', function () {
  let server: DM;
  let plugin: LdapGroups;
  let request: ReturnType<typeof supertest>;
  let containerDn: string;
  const named = 'listcontainer.list';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    server = new DM();
    await server.ready;
    server.config.group_schema = '';
    plugin = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', plugin);
    server.setupErrorMiddleware();
    request = supertest(server.app);
    await plugin.addGroup(named, [], { description: 'Listed beside it' });
    containerDn = `ou=listcontainer,${plugin.base as string}`;
    await server.ldap.add(containerDn, {
      objectClass: ['top', 'organizationalUnit'],
      ou: 'listcontainer',
    });
  });

  after(async () => {
    await plugin.deleteGroup(named).catch(() => undefined);
    if (containerDn)
      await server.ldap.delete(containerDn).catch(() => undefined);
  });

  it('should leave a branch holding groups out of the listing', async () => {
    const res = await request
      .get('/api/v1/ldap/groups')
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).not.to.have.property('');
    const dns = Object.values(res.body as Record<string, { dn?: string }>).map(
      entry => entry.dn
    );
    expect(dns).not.to.include(containerDn);
  });

  it('should still list the groups the branch sits beside', async () => {
    const res = await request
      .get('/api/v1/ldap/groups')
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property(named);
  });
});
