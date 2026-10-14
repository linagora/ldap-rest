/**
 * A raw LDAP filter in `match` may hold a DN: `.` and `@` are common in
 * one (uid=john.doe, mail=a@b) and are no filter metacharacter.
 * linagora/twake-directory-manager#70
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Group raw match filter', function () {
  let server: DM;
  let plugin: LdapGroups;
  let request: ReturnType<typeof supertest>;
  const named = 'rawmatch.list';
  const other = 'rawmatch.other';
  let dn: string;
  let mailDn: string;
  let quoteDn: string;

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
    // A DN with a dot, and one with an @ (and a dot)
    dn = `uid=rawmatch.john,${process.env.DM_LDAP_BASE}`;
    mailDn = `mail=rawmatch.jane@example.com,${process.env.DM_LDAP_BASE}`;
    quoteDn = `uid=rawmatch.o'brien,${process.env.DM_LDAP_BASE}`;
    const person = { objectClass: ['top', 'twakeAccount', 'twakeWhitePages'] };
    await server.ldap.add(dn, {
      ...person,
      uid: 'rawmatch.john',
      cn: 'John',
      sn: 'Doe',
      mail: 'rawmatch.john@example.com',
    });
    await server.ldap.add(mailDn, {
      ...person,
      uid: 'rawmatch.jane',
      cn: 'Jane',
      sn: 'Doe',
      mail: 'rawmatch.jane@example.com',
    });
    await server.ldap.add(quoteDn, {
      ...person,
      uid: "rawmatch.o'brien",
      cn: "O'Brien",
      sn: "O'Brien",
      mail: 'rawmatch.obrien@example.com',
    });
    await plugin.addGroup(named, [dn, mailDn, quoteDn]);
    await plugin.addGroup(other, []);
  });

  after(async () => {
    for (const cn of [named, other])
      await plugin.deleteGroup(cn).catch(() => undefined);
    for (const d of [dn, mailDn, quoteDn])
      await server.ldap.delete(d).catch(() => undefined);
  });

  const get = (match: string) =>
    request
      .get('/api/v1/ldap/groups')
      .query({ match })
      .set('Accept', 'application/json');

  it('should find the groups of a DN holding a dot', async () => {
    const res = await get(`(member=${dn})`);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property(named);
    expect(res.body).not.to.have.property(other);
  });

  it('should find the groups of a DN holding an @', async () => {
    const res = await get(`(member=${mailDn})`);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property(named);
    expect(res.body).not.to.have.property(other);
  });

  it('should find the groups of a DN holding an apostrophe', async () => {
    const res = await get(`(member=${quoteDn})`);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property(named);
    expect(res.body).not.to.have.property(other);
  });

  it('should refuse a +', async () => {
    const res = await get('(member=uid=a+b)');
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
  });

  it('should still refuse a backslash', async () => {
    const res = await get('(member=a\\2a)');
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/forbidden characters/);
  });

  it('should still refuse other punctuation', async () => {
    const res = await get('(cn=a;b)');
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
  });
});
