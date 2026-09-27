import { expect } from 'chai';

import { DM } from '../../src/bin';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';

/**
 * An entry created by another tool than this one may lack a class its
 * schema declares, and the directory then refuses an attribute that class
 * carries. Modifying such an entry adds the auxiliary classes it lacks.
 */
describe('Object class repair on modify', function () {
  let server: DM;
  let users: any;
  let base: string;
  let orgDn: string;
  let accountDn: string;
  let strayDn: string;

  const classes = async (dn: string): Promise<string[]> => {
    const result = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['objectClass'] },
      dn
    )) as { searchEntries: Record<string, unknown>[] };
    const raw = result.searchEntries[0].objectClass as string | string[];
    return (Array.isArray(raw) ? raw : [raw]).map(c => c.toLowerCase());
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    orgDn = `ou=RepairTest,${base}`;
    accountDn = `uid=repair-test,ou=users,${base}`;
    strayDn = `uid=repair-stray,${orgDn}`;
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    server = new DM();
    users = new LdapFlatGeneric(server).instances[0];
    await server.ldap
      .add(orgDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'RepairTest',
        twakeDepartmentPath: 'RepairTest',
      })
      .catch(() => undefined);
  });

  beforeEach(async () => {
    for (const dn of [accountDn, strayDn])
      await server.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: dn === accountDn ? 'repair-test' : 'repair-stray',
        cn: 'Repair Test',
        sn: 'Test',
      });
  });

  afterEach(async () => {
    for (const dn of [accountDn, strayDn])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  after(async () => {
    await server?.ldap.delete(orgDn).catch(() => undefined);
  });

  it('should give an account made elsewhere the class its organization link needs', async () => {
    await users.moveEntry('repair-test', orgDn);
    expect(await classes(accountDn)).to.include('twakewhitepages');
    // A structural class cannot be added to an existing entry.
    expect(await classes(accountDn)).not.to.include('twakeaccount');
  });

  it('should leave the classes alone when the change names them', async () => {
    await server.ldap.modify(accountDn, {
      replace: { objectClass: ['top', 'inetOrgPerson'], description: 'kept' },
    });
    expect(await classes(accountDn)).not.to.include('twakewhitepages');
  });

  it('should answer 409, not 500, when the entry cannot hold the change', async () => {
    // Outside every declared branch: nothing is repaired.
    let raised: unknown;
    try {
      await server.ldap.modify(strayDn, {
        replace: { twakeDepartmentLink: orgDn },
      });
    } catch (err) {
      raised = err;
    }
    expect((raised as { statusCode?: number }).statusCode).to.equal(409);
    expect((raised as { code?: number }).code).to.equal(65);
  });

  it('should add an auxiliary class only once its mandatory attributes are there', async function () {
    const index = await server.ldap.schemaIndex();
    if (index.getObjectClass('posixAccount')?.kind !== 'AUXILIARY')
      return this.skip();
    server.ldap.declareObjectClasses(orgDn, ['posixAccount']);

    await server.ldap.modify(strayDn, { replace: { description: 'x' } });
    expect(await classes(strayDn)).not.to.include('posixaccount');

    await server.ldap.modify(strayDn, {
      replace: {
        uidNumber: '10042',
        gidNumber: '10042',
        homeDirectory: '/home/repair-stray',
      },
    });
    expect(await classes(strayDn)).to.include('posixaccount');
  });
});
