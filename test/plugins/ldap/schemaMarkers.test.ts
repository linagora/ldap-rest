import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

/**
 * The schema markers a client meets over HTTP: what it may not send, what it
 * never gets back, and what it is told when a value does not match.
 */
describe('Schema markers over the API', () => {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let deptDn: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    deptDn = `ou=MarkersOrg,${base}`;

    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    server = new DM();
    await server.ready;
    try {
      await server.ldap.add(deptDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'MarkersOrg',
        twakeDepartmentPath: 'MarkersOrg',
      });
    } catch (e) {
      // already there
    }
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    // The shipped schema marks the path and the status required *and*
    // generated, so it needs the plugin that fills them: without one, those
    // attributes are unreachable from either side.
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    await server.ldap.delete(deptDn).catch(() => undefined);
  });

  const remove = async (uid: string): Promise<void> => {
    await server.ldap
      .delete(`uid=${uid},ou=users,${base}`)
      .catch(() => undefined);
  };

  const body = (
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    cn: 'Marker User',
    sn: 'User',
    mail: 'marker.user@example.com',
    twakeDepartmentLink: deptDn,
    ...extra,
    employeeNumber: 'SCH0001',
    givenName: 'Test',
    displayName: 'Test Person',
  });

  afterEach(async () => {
    await remove('marker.user');
  });

  describe('computed attributes', () => {
    it('should refuse an identifier the server derives itself', async () => {
      const res = await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send(body({ uid: 'chosen.by.the.client' }));
      expect(res.status).to.equal(400);
      expect(res.body.error).to.match(/computed by the server/);
    });

    it('should refuse a computed organization path', async () => {
      const res = await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send(body({ twakeDepartmentPath: 'Somewhere Else' }));
      expect(res.status).to.equal(400);
      expect(res.body.error).to.match(/computed by the server/);
    });

    it('should refuse to have one replaced on an update', async () => {
      await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send(body())
        .expect(201);
      const res = await request
        .put('/api/v1/ldap/users/marker.user')
        .type('json')
        .send({ replace: { twakeDepartmentPath: 'Somewhere Else' } });
      expect(res.status).to.equal(400);
    });
  });

  describe('read-only attributes', () => {
    it('should refuse memberships, which the group side owns', async () => {
      const res = await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send(body({ memberOf: [`cn=admins,ou=groups,${base}`] }));
      expect(res.status).to.equal(400);
      expect(res.body.error).to.match(/read-only/);
    });
  });

  describe('write-only attributes', () => {
    it('should accept a password and never hand it back', async () => {
      await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send(body({ userPassword: 'S3cret-value' }))
        .expect(201);

      const single = await request
        .get('/api/v1/ldap/users/marker.user')
        .set('Accept', 'application/json');
      expect(single.status).to.equal(200);
      expect(single.body).to.have.property('uid', 'marker.user');
      expect(single.body).to.not.have.property('userPassword');

      const list = await request
        .get('/api/v1/ldap/users?match=marker.user&attribute=uid')
        .set('Accept', 'application/json');
      expect(list.body['marker.user']).to.not.have.property('userPassword');

      // It really was written: the directory holds it.
      const raw = await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['userPassword'] },
        `uid=marker.user,ou=users,${base}`
      );
      expect(
        (raw as { searchEntries: Record<string, unknown>[] }).searchEntries[0]
      ).to.have.property('userPassword');
    });
  });

  describe('validation messages', () => {
    it('should say what a valid value looks like', async () => {
      const res = await request
        .post('/api/v1/ldap/users')
        .type('json')
        .send(body({ mail: 'not-an-address' }));
      expect(res.status).to.equal(400);
      expect(res.body.error).to.match(/Expected an email address/);
    });
  });
});
