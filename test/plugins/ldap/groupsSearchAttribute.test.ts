/**
 * Searching groups in something other than their name.
 *
 * The console sends `?match=…&attribute=…` for every entity it lists — its
 * scope selector offers a group's mail and description as much as its name —
 * and the flat lists answer it. The group list built its filter on the RDN
 * attribute whatever was asked, so looking a distribution list up by its
 * address answered "No entry matches this search" on a group holding exactly
 * that address.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Group search scope', function () {
  let server: DM;
  let plugin: LdapGroups;
  let request: ReturnType<typeof supertest>;
  const named = 'searchscope.list';
  const other = 'searchscope.other';
  const mail = 'searchscope.address@example.com';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    server = new DM();
    await server.ready;
    // The filter is the route's business, not the schema's: a directory
    // without a group schema searches the same way.
    server.config.group_schema = '';
    plugin = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', plugin);
    server.setupErrorMiddleware();
    request = supertest(server.app);
    await plugin.addGroup(named, [], { mail, description: 'Scope test' });
    await plugin.addGroup(other, [], { description: 'Another one' });
  });

  after(async () => {
    for (const cn of [named, other])
      await plugin.deleteGroup(cn).catch(() => undefined);
  });

  it('should look in the attribute the client named', async () => {
    const res = await request
      .get('/api/v1/ldap/groups?match=searchscope.address&attribute=mail')
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property(named);
    expect(res.body).not.to.have.property(other);
  });

  it('should look in each of several attributes at once', async () => {
    const res = await request
      .get(
        '/api/v1/ldap/groups?match=searchscope.address&attribute=cn,mail,description'
      )
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property(named);
    expect(res.body).not.to.have.property(other);
  });

  it('should match a substring, as the flat lists do', async () => {
    const res = await request
      .get('/api/v1/ldap/groups?match=scope.other&attribute=cn')
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property(other);
    expect(res.body).not.to.have.property(named);
  });

  it('should refuse an attribute that is not an attribute name', async () => {
    const res = await request
      .get('/api/v1/ldap/groups?match=whatever&attribute=cn)(objectClass=*')
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/Invalid LDAP attribute name/);
  });
});
