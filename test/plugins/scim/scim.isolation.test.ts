/**
 * Integration tests for cross-tenant isolation and discovery honesty.
 *
 * Each test here verifies a property that the review pass flagged as
 * insufficiently covered:
 *  - SCIM Group members cannot be injected via arbitrary DNs (tenant escape).
 *  - `sort.supported` is advertised honestly (false) in `ServiceProviderConfig`.
 *  - `attributes=` and `excludedAttributes=` are parsed without erroring.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

describe('SCIM cross-tenant isolation (integration)', function () {
  let server: DM;
  let plugin: Scim;
  let userBase: string;
  let groupBase: string;
  let savedUserBase: string | undefined;
  let savedGroupBase: string | undefined;

  before(async function () {
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn('Skipping SCIM isolation tests: LDAP env vars missing');
      this.skip();
      return;
    }
    const baseDn = process.env.DM_LDAP_BASE;
    userBase = `ou=users,${baseDn}`;
    groupBase = `ou=groups,${baseDn}`;
    savedUserBase = process.env.DM_SCIM_USER_BASE;
    savedGroupBase = process.env.DM_SCIM_GROUP_BASE;
    process.env.DM_SCIM_USER_BASE = userBase;
    process.env.DM_SCIM_GROUP_BASE = groupBase;
    process.env.DM_GROUP_SCHEMA = '';
    server = new DM();
    plugin = new Scim(server);
    await plugin.api(server.app);
    await server.ready;

    // Create an in-base user + an OUT-of-base "foreign" entry that must not
    // be reachable via member references.
    try {
      await plugin.ldap.add(`uid=iso-alice,${userBase}`, {
        objectClass: ['top', 'inetOrgPerson', 'person'],
        uid: 'iso-alice',
        cn: 'Alice',
        sn: 'Alice',
      });
    } catch {
      /* may already exist */
    }
    try {
      await plugin.ldap.add(`ou=other-tenant,${baseDn}`, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'other-tenant',
      });
    } catch {
      /* may already exist */
    }
    try {
      await plugin.ldap.add(`uid=iso-foreign,ou=other-tenant,${baseDn}`, {
        objectClass: ['top', 'inetOrgPerson', 'person'],
        uid: 'iso-foreign',
        cn: 'Foreign',
        sn: 'Foreign',
      });
    } catch {
      /* may already exist */
    }
  });

  after(async () => {
    if (plugin) {
      for (const dn of [
        `uid=iso-alice,${userBase}`,
        `uid=iso-foreign,ou=other-tenant,${process.env.DM_LDAP_BASE}`,
        `ou=other-tenant,${process.env.DM_LDAP_BASE}`,
      ]) {
        try {
          await plugin.ldap.delete(dn);
        } catch {
          /* ignore */
        }
      }
    }
    if (savedUserBase === undefined) delete process.env.DM_SCIM_USER_BASE;
    else process.env.DM_SCIM_USER_BASE = savedUserBase;
    if (savedGroupBase === undefined) delete process.env.DM_SCIM_GROUP_BASE;
    else process.env.DM_SCIM_GROUP_BASE = savedGroupBase;
  });

  afterEach(async () => {
    if (!plugin) return;
    try {
      await plugin.ldap.delete(`cn=iso-group,${groupBase}`);
    } catch {
      /* ignore */
    }
  });

  it('does not add a member whose DN lies outside the SCIM user base', async () => {
    const baseDn = process.env.DM_LDAP_BASE;
    const foreignDn = `uid=iso-foreign,ou=other-tenant,${baseDn}`;
    const res = await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'iso-group',
        // Attempt to escape the tenant base by passing a full DN outside it
        members: [{ value: foreignDn }],
      })
      .expect(201);
    // The foreign DN must NOT appear in the created group's members.
    const values = (res.body.members as { value: string }[] | undefined) || [];
    for (const m of values) {
      expect(
        m.value,
        'foreign DN leaked into group members — cross-tenant escape'
      ).to.not.equal(foreignDn);
    }
  });

  it('accepts a member DN that lies within the SCIM user base', async () => {
    const inBaseDn = `uid=iso-alice,${userBase}`;
    const res = await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'iso-group',
        members: [{ value: inBaseDn }],
      })
      .expect(201);
    const values =
      (res.body.members as { value: string; $ref?: string }[] | undefined) ||
      [];
    const found = values.some(m => m.value === 'iso-alice');
    expect(found, 'in-base member should be present in response').to.be.true;
  });
});

describe('SCIM ServiceProviderConfig honesty (integration)', function () {
  let server: DM;
  let plugin: Scim;
  let savedUserBase: string | undefined;
  let savedGroupBase: string | undefined;

  before(async function () {
    if (!process.env.DM_LDAP_BASE) {
      this.skip();
      return;
    }
    const baseDn = process.env.DM_LDAP_BASE;
    savedUserBase = process.env.DM_SCIM_USER_BASE;
    savedGroupBase = process.env.DM_SCIM_GROUP_BASE;
    process.env.DM_SCIM_USER_BASE = `ou=users,${baseDn}`;
    process.env.DM_SCIM_GROUP_BASE = `ou=groups,${baseDn}`;
    server = new DM();
    plugin = new Scim(server);
    await plugin.api(server.app);
    await server.ready;
  });

  after(() => {
    if (savedUserBase === undefined) delete process.env.DM_SCIM_USER_BASE;
    else process.env.DM_SCIM_USER_BASE = savedUserBase;
    if (savedGroupBase === undefined) delete process.env.DM_SCIM_GROUP_BASE;
    else process.env.DM_SCIM_GROUP_BASE = savedGroupBase;
  });

  it('advertises sort.supported = false', async () => {
    const res = await supertest(server.app)
      .get('/scim/v2/ServiceProviderConfig')
      .expect(200);
    expect(res.body.sort.supported).to.equal(false);
  });

  it('accepts sortBy / sortOrder query params without error', async () => {
    // They're parsed for backwards compatibility but not applied.
    await supertest(server.app)
      .get('/scim/v2/Users?sortBy=userName&sortOrder=ascending')
      .expect(200);
  });

  it('accepts attributes / excludedAttributes query params without error', async () => {
    await supertest(server.app)
      .get(
        '/scim/v2/Users?attributes=userName,displayName&excludedAttributes=emails'
      )
      .expect(200);
  });

  it('invalid filter returns a SCIM error envelope', async () => {
    const res = await supertest(server.app)
      .get('/scim/v2/Users?filter=' + encodeURIComponent('nosuch pr'))
      .expect(400);
    expect(res.body.scimType).to.equal('invalidFilter');
  });
});
