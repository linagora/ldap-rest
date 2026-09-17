/**
 * A schema is JSON, so a default may be a number — and a directory stores
 * strings. The shipped `static/schemas/example/users.json` carries
 * `mailQuotaSize.default: 1000000000`, which is the case no other suite
 * exercises: every other default in the shipped schemas is a string.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Enterprise rules: schema defaults', function () {
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
    deptDn = `ou=DefaultsOrg,ou=organization,${base}`;
    userDn = `uid=defaults.user,ou=users,${base}`;

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/example/users.json'];
    await server.ldap
      .add(deptDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'DefaultsOrg',
        twakeDepartmentPath: 'DefaultsOrg',
      })
      .catch(() => undefined);
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    await server.ldap.delete(userDn).catch(() => undefined);
    await server.ldap.delete(deptDn).catch(() => undefined);
  });

  const create = (extra: Record<string, unknown> = {}) =>
    request
      .post('/api/v1/ldap/users')
      .type('json')
      .send({
        cn: 'Defaults User',
        sn: 'User',
        mail: 'defaults.user@example.org',
        employeeNumber: 'E90001',
        twakeDepartmentLink: deptDn,
        ...extra,
        givenName: 'Test',
        displayName: 'Test Person',
      });

  const read = async (attribute: string) => {
    const result = (await server.ldap.search(
      { paged: false, scope: 'base', filter: '(objectClass=*)' },
      userDn
    )) as { searchEntries: Record<string, unknown>[] };
    return result.searchEntries[0]?.[attribute];
  };

  it('should store a numeric default as the directory takes it', async () => {
    const res = await create();
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect(await read('mailQuotaSize')).to.equal('1000000000');
  });

  it('should still let the client override it, normalised', async () => {
    await server.ldap.delete(userDn).catch(() => undefined);
    const res = await create({ mailQuotaSize: '5GB' });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect(await read('mailQuotaSize')).to.equal('5000000000');
  });
});
