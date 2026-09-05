/**
 * The shipped group schema marks the organization path required *and*
 * generated: a hook fills it after validation, so a conformant client sends
 * nothing. `validateNewGroup` has to grant that attribute the same exemption
 * the flat and organization paths already grant it, or no schema-conformant
 * group creation can succeed at all.
 *
 * The older suite passes because it hands `twakeDepartmentPath` in itself —
 * the one thing a client is no longer meant to do.
 *
 * The exemption is granted against a plugin that says it fills the attribute,
 * so the rules that do are loaded here: without them the creation is refused
 * instead, which `generatedAttributeGuards` checks.
 */
import { expect } from 'chai';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { DM } from '../../../src/bin';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Group schema: a generated attribute is not asked of the client', function () {
  let server: DM;
  let plugin: LdapGroups;
  let groupDn: string;
  let orgDn: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    process.env.DM_GROUP_SCHEMA = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../static/schemas/twake/groups.json'
    );
    server = new DM();
    await server.ready;
    plugin = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', plugin);
    // Something has to fill the path for the exemption to be granted, and
    // these are the rules that do.
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    // The schema is read asynchronously; without waiting, the validator
    // returns early and the test proves nothing.
    for (let i = 0; i < 50 && !plugin.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    groupDn = `cn=generatedgrp,${plugin.base}`;
    // The path is copied from the organization the group is linked to, so
    // that organization has to hold one.
    orgDn = `ou=GeneratedGrpOrg,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    await server.ldap
      .add(orgDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'GeneratedGrpOrg',
        twakeDepartmentPath: 'GeneratedGrpOrg',
      })
      .catch(() => undefined);
  });

  after(async () => {
    await server.ldap.delete(groupDn).catch(() => undefined);
    await server.ldap.delete(orgDn).catch(() => undefined);
  });

  it('should have a schema marking the path required and generated', () => {
    const path = plugin.schema?.attributes?.twakeDepartmentPath;
    expect(path?.required, 'required').to.be.true;
    expect(path?.generated, 'generated').to.be.true;
  });

  it('should create a group without the generated path', async () => {
    await plugin.addGroup('generatedgrp', [], {
      twakeDepartmentLink: orgDn,
      mail: 'generatedgrp@example.com',
    });
    const found = await plugin.searchGroupsByName('generatedgrp');
    expect(found).to.have.property('generatedgrp');
  });
});
