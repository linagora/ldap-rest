import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapAccountLifecycle, {
  generatePassword,
} from '../../../src/plugins/ldap/accountLifecycle';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Account lifecycle', () => {
  describe('generatePassword', () => {
    it('should draw the requested length from the alphabet', () => {
      const password = generatePassword(24);
      expect(password).to.have.length(24);
      expect(password).to.match(/^[a-zA-Z0-9!@#$%*\-_=+]+$/);
    });

    it('should not repeat itself', () => {
      const seen = new Set(
        Array.from({ length: 50 }, () => generatePassword())
      );
      expect(seen.size).to.equal(50);
    });
  });

  describe('endpoints', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    let base: string;
    let deptDn: string;
    let userDn: string;

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    });

    before(async () => {
      base = process.env.DM_LDAP_BASE as string;
      deptDn = `ou=LifecycleOrg,${base}`;
      userDn = `uid=lifecycle.user,ou=users,${base}`;

      process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
      server = new DM();
      await server.ready;
      try {
        await server.ldap.add(deptDn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'LifecycleOrg',
          twakeDepartmentPath: 'LifecycleOrg',
        });
      } catch (e) {
        // already there
      }
      await server.registerPlugin(
        'ldapFlatGeneric',
        new LdapFlatGeneric(server)
      );
      await server.registerPlugin(
        'ldapAccountLifecycle',
        new LdapAccountLifecycle(server)
      );
      server.setupErrorMiddleware();
      request = supertest(server.app);
    });

    after(async () => {
      await server.ldap.delete(deptDn).catch(() => undefined);
    });

    beforeEach(async () => {
      await server.ldap.delete(userDn).catch(() => undefined);
      await server.ldap.add(userDn, {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        uid: 'lifecycle.user',
        cn: 'Lifecycle User',
        sn: 'User',
        mail: 'lifecycle.user@example.com',
        twakeDepartmentLink: deptDn,
        twakeDepartmentPath: 'LifecycleOrg',
        twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
        employeeNumber: 'ACC0001',
        givenName: 'Test',
        displayName: 'Test Person',
      });
    });

    after(async () => {
      await server.ldap.delete(userDn).catch(() => undefined);
    });

    const read = async (
      attributes: string[]
    ): Promise<Record<string, unknown>> => {
      const result = await server.ldap.search(
        { paged: false, scope: 'base', attributes },
        userDn
      );
      return (result as { searchEntries: Record<string, unknown>[] })
        .searchEntries[0];
    };

    describe('status', () => {
      it('should move the account to a state the schema declares', async () => {
        const res = await request
          .post('/api/v1/ldap/users/lifecycle.user/status')
          .type('json')
          .send({ state: 'disabled' });
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ success: true, state: 'disabled' });
        expect(await read(['twakeAccountStatus'])).to.have.property(
          'twakeAccountStatus',
          `cn=disabled,ou=twakeAccountStatus,ou=nomenclature,${base}`
        );
      });

      it('should move it back', async () => {
        await request
          .post('/api/v1/ldap/users/lifecycle.user/status')
          .type('json')
          .send({ state: 'disabled' })
          .expect(200);
        await request
          .post('/api/v1/ldap/users/lifecycle.user/status')
          .type('json')
          .send({ state: 'enabled' })
          .expect(200);
        expect(await read(['twakeAccountStatus'])).to.have.property(
          'twakeAccountStatus',
          `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`
        );
      });

      it('should name the states it knows when given an unknown one', async () => {
        const res = await request
          .post('/api/v1/ldap/users/lifecycle.user/status')
          .type('json')
          .send({ state: 'retired' });
        expect(res.status).to.equal(400);
        expect(res.body.error).to.match(/known states: .*disabled/);
      });

      it('should refuse a name inherited from Object.prototype', async () => {
        // `states` is a plain object, so `states.constructor` is a function
        // rather than undefined. A `=== undefined` guard let it through into
        // the LDAP modify, answering 500 instead of the documented 400.
        for (const state of ['constructor', 'toString', 'hasOwnProperty']) {
          const res = await request
            .post('/api/v1/ldap/users/lifecycle.user/status')
            .type('json')
            .send({ state });
          expect(res.status, state).to.equal(400);
          expect(res.body.error, state).to.match(/known states: /);
        }
      });

      it('should refuse a body without a state', async () => {
        const res = await request
          .post('/api/v1/ldap/users/lifecycle.user/status')
          .type('json')
          .send({});
        expect(res.status).to.equal(400);
      });
    });

    describe('password', () => {
      it('should generate one and return it exactly once', async () => {
        const res = await request
          .post('/api/v1/ldap/users/lifecycle.user/password')
          .type('json')
          .send({});
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('generated', true);
        expect(res.body.password).to.be.a('string').with.length(16);

        // The credential is written, and reading the account never shows it.
        expect(await read(['userPassword'])).to.have.property('userPassword');
        const shown = await request
          .get('/api/v1/ldap/users/lifecycle.user')
          .set('Accept', 'application/json');
        expect(shown.body).to.not.have.property('userPassword');
      });

      it('should take the password it is given, and not echo it', async () => {
        const res = await request
          .post('/api/v1/ldap/users/lifecycle.user/password')
          .type('json')
          .send({ password: 'Chosen-by-the-admin-1' });
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('generated', false);
        expect(res.body).to.not.have.property('password');
      });

      it('should flag the account for a change at next login', async () => {
        await request
          .post('/api/v1/ldap/users/lifecycle.user/password')
          .type('json')
          .send({})
          .expect(200);
        expect(await read(['pwdReset'])).to.have.property('pwdReset', 'TRUE');
      });

      it('should leave the flag alone when asked not to force a change', async () => {
        const res = await request
          .post('/api/v1/ldap/users/lifecycle.user/password')
          .type('json')
          .send({ forceChange: false });
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('forceChange', false);
        expect(await read(['pwdReset'])).to.have.property('pwdReset', 'FALSE');
      });

      it('should answer 404 for an account that does not exist', async () => {
        const res = await request
          .post('/api/v1/ldap/users/nobody.here/password')
          .type('json')
          .send({});
        expect(res.status).to.equal(404);
      });
    });
  });
});
