/**
 * `memberOf` is an operational attribute: the directory computes it and only
 * returns it when it is asked for by name. The Twake users schema declares it
 * (role `groupMemberships`), so reading an account has to return it.
 *
 * The test directory runs the `memberof` overlay for `groupOfUniqueNames`
 * only, so the group here is one of those.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Flat entity read of declared operational attributes', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userDn: string;
  let groupDn: string;
  const UID = 'opattr.alice';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userDn = `uid=${UID},ou=users,${base}`;
    groupDn = `cn=opattr-list,${process.env.DM_LDAP_GROUP_BASE || base}`;

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);

    await server.ldap.delete(groupDn).catch(() => undefined);
    await server.ldap.delete(userDn).catch(() => undefined);
    await server.ldap.add(userDn, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: UID,
      cn: UID,
      sn: 'Opattr',
      givenName: 'Test',
      displayName: `Test ${UID}`,
      mail: `${UID}@example.com`,
      employeeNumber: 'OPA0001',
      twakeDepartmentLink: base,
      twakeDepartmentPath: 'Root',
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
      twakeDeliveryMode: [
        `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
      ],
    });
    await server.ldap.add(groupDn, {
      objectClass: ['top', 'groupOfUniqueNames'],
      cn: 'opattr-list',
      uniqueMember: userDn,
    });
  });

  after(async () => {
    await server.ldap.delete(groupDn).catch(() => undefined);
    await server.ldap.delete(userDn).catch(() => undefined);
  });

  it('should return memberOf, which the schema declares', async () => {
    const res = await request
      .get(`/api/v1/ldap/users/${UID}`)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    const memberOf = [res.body.memberOf].flat().map(String);
    expect(memberOf.map(dn => dn.toLowerCase())).to.include(
      groupDn.toLowerCase()
    );
  });

  it('should not return the operational attributes it does not declare', async () => {
    const res = await request
      .get(`/api/v1/ldap/users/${UID}`)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.not.have.any.keys(
      'entryUUID',
      'createTimestamp',
      'modifyTimestamp',
      'entryDN'
    );
  });
});
