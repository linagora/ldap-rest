/**
 * What an organization path is allowed to say about where its entry sits.
 *
 * A path reads from the root down, the entry's own name last, and a path that
 * is *only* that name says the entry hangs straight from the top
 * organization. Taking that on the payload's word let an organization three
 * levels down keep a path naming none of its parents — the very invariant
 * `checkDeptPath` exists to hold. The DN says where the entry is, and every
 * caller of the check knows it.
 *
 * The other way round, directories written before the order was settled hold
 * the reverse path, their own name first and the top organization last
 * (`TestOrg / organization`). The server never computes that any more, but it
 * is what those directories contain: refusing it on validation would make
 * every organization of theirs unwritable on an upgrade.
 */
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import { rdnValue } from '../../../src/lib/utils';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Organization path guards', function () {
  let server: DM;
  let plugin: LdapOrganizations;
  let topOrg: string;
  let topName: string;
  let parentDn: string;
  let childDn: string;
  const parent = 'PathGuardParent';
  const child = 'PathGuardChild';
  const orgClass = ['top', 'organizationalUnit', 'twakeDepartment'];

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    server = new DM();
    await server.ready;
    plugin = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', plugin);
    topOrg = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    topName = rdnValue(topOrg);
    parentDn = `ou=${parent},${topOrg}`;
    childDn = `ou=${child},${parentDn}`;
    // The parent has to exist and hold its path: what precedes an entry's own
    // name has to be a path some organization actually holds.
    await server.ldap
      .add(parentDn, {
        objectClass: orgClass,
        ou: parent,
        [plugin.pathAttr]: parent,
      })
      .catch(() => undefined);
  });

  after(async () => {
    await server.ldap.delete(parentDn).catch(() => undefined);
  });

  /**
   * Run the add hook on an organization entry, as the directory would.
   *
   * @param dn DN the entry would be written at
   * @param ou its own name
   * @param path the path it carries
   * @returns nothing, throws when the path is refused
   */
  const check = async (dn: string, ou: string, path: string): Promise<void> => {
    await plugin.hooks.ldapaddrequest?.([
      dn,
      { objectClass: orgClass, ou, [plugin.pathAttr]: path },
    ]);
  };

  describe('a path that names no parent', () => {
    it('should be accepted from an organization directly under the top one', async () => {
      await check(parentDn, parent, parent);
    });

    it('should be refused from one that hangs lower', async () => {
      try {
        await check(childDn, child, child);
        expect.fail('Should have refused the path');
      } catch (e) {
        expect((e as Error).message).to.match(/names no parent/);
      }
    });

    it('should be accepted from that one once it names its parent', async () => {
      await check(childDn, child, `${parent} / ${child}`);
    });
  });

  describe('a path written the way the directories used to write it', () => {
    it('should be accepted on a top-level organization', async () => {
      await check(parentDn, parent, `${parent} / ${topName}`);
    });

    it('should be accepted on one further down', async () => {
      await check(childDn, child, `${child} / ${parent} / ${topName}`);
    });
  });
});
