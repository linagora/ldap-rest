/**
 * `deleteGuard: nonEmpty` counts the members an entry holds. The placeholder
 * a `groupOfNames` keeps to stay valid is not one of them — whichever way the
 * configuration spells its DN, since the directory answers with its own
 * spelling and the two were compared as text.
 */
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import type { AttributesList } from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Enterprise rules: the placeholder is not a member', function () {
  let server: DM;
  let base: string;
  let listDn: string;
  let placeholder: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    listDn = `cn=guardlist,ou=lists,ou=groups,${base}`;

    server = new DM();
    await server.ready;
    // The only shipped schema that declares `deleteGuard: nonEmpty`.
    server.config.ldap_flat_schema = ['./static/schemas/example/groups.json'];
    // Written as an operator types it, spaces and all: the same DN as the one
    // the directory will store, spelled differently.
    placeholder = 'CN = FakeUser';
    server.config.group_dummy_user = placeholder;

    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
  });

  afterEach(async () => {
    // The guard under test is what stands between this and a clean
    // directory: the second case deliberately gives the group a real member,
    // so deleting straight away was refused and left the entry behind, run
    // after run. Put it back to holding nothing but the placeholder, which
    // the first case shows is deletable, then delete it.
    await server.ldap
      .modify(listDn, { replace: { member: placeholder } })
      .catch(() => undefined);
    await server.ldap.delete(listDn).catch(() => undefined);
  });

  const createList = (members: string[]) =>
    server.ldap.add(listDn, {
      objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
      cn: 'guardlist',
      member: members,
    } as AttributesList);

  it('should let a group holding only the placeholder be deleted', async () => {
    await createList([placeholder]);
    expect(await server.ldap.delete(listDn)).to.be.true;
  });

  it('should still refuse to delete a group that has a real member', async () => {
    await createList([placeholder, `uid=john.doe,ou=users,${base}`]);
    try {
      await server.ldap.delete(listDn);
      expect.fail('the group should not have been deletable');
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).to.equal(409);
      expect((err as Error).message).to.match(/still has 1 member\(s\)/);
    }
  });
});
