/**
 * Two ways a `generated` attribute can go wrong quietly.
 *
 * A schema marks an attribute required *and* generated, so a client may not
 * send it and a hook fills it after validation. That bargain only holds if the
 * hook is there — and if the value it fills is held to the same rules a
 * submitted value would meet.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Generated attributes', function () {
  let base: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(() => {
    base = process.env.DM_LDAP_BASE as string;
  });

  const serve = async (
    schema: string,
    withRules: boolean
  ): Promise<{ server: DM; request: ReturnType<typeof supertest> }> => {
    const server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [schema];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    if (withRules)
      await server.registerPlugin(
        'ldapEnterpriseRules',
        new LdapEnterpriseRules(server)
      );
    server.setupErrorMiddleware();
    return { server, request: supertest(server.app) };
  };

  describe('with nothing loaded to fill them', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    let deptDn: string;

    before(async () => {
      deptDn = `ou=GuardsOrg,${base}`;
      ({ server, request } = await serve(
        './static/schemas/twake/users.json',
        false
      ));
      await server.ldap
        .add(deptDn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'GuardsOrg',
          twakeDepartmentPath: 'GuardsOrg',
        })
        .catch(() => undefined);
    });

    after(async () => {
      await server.ldap
        .delete(`uid=guards.user,ou=users,${base}`)
        .catch(() => undefined);
      await server.ldap.delete(deptDn).catch(() => undefined);
    });

    it('should refuse the creation rather than write an incomplete entry', async () => {
      // Without `core/ldap/enterpriseRules`, nothing fills the path or the
      // status. Exempting them would store an entry missing two attributes
      // its own schema calls required — and the client cannot supply them
      // either, since a generated attribute is refused as input.
      const res = await request.post('/api/v1/ldap/users').type('json').send({
        cn: 'Guards User',
        sn: 'User',
        mail: 'guards.user@example.com',
        twakeDepartmentLink: deptDn,
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/is required/);
    });
  });

  describe('when the schema default points nowhere', () => {
    let server: DM;
    let request: ReturnType<typeof supertest>;

    before(async () => {
      ({ server, request } = await serve(
        './test/fixtures/schemas/danglingPointerDefault.json',
        true
      ));
    });

    after(async () => {
      await server.ldap
        .delete(`uid=dangling.user,ou=users,${base}`)
        .catch(() => undefined);
    });

    it('should refuse it, as it refuses the same value from a client', async () => {
      const res = await request
        .post('/api/v1/ldap/danglingUsers')
        .type('json')
        .send({ uid: 'dangling.user', cn: 'Dangling User', sn: 'User' });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/points to a non-existent entry/);
    });
  });
});
