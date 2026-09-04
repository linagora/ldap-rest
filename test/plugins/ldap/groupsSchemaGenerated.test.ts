/**
 * The shipped group schema marks the organization path required *and*
 * generated: a hook fills it after validation, so a conformant client sends
 * nothing. `validateNewGroup` has to grant that attribute the same exemption
 * the flat and organization paths already grant it, or no schema-conformant
 * group creation can succeed at all.
 *
 * The older suite passes because it hands `twakeDepartmentPath` in itself —
 * the one thing a client is no longer meant to do.
 */
import { expect } from 'chai';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { DM } from '../../../src/bin';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Group schema: a generated attribute is not asked of the client', function () {
  let server: DM;
  let plugin: LdapGroups;
  let groupDn: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
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
    // The schema is read asynchronously; without waiting, the validator
    // returns early and the test proves nothing.
    for (let i = 0; i < 50 && !plugin.schema; i++)
      await new Promise(r => setTimeout(r, 100));
    groupDn = `cn=generatedgrp,${plugin.base}`;
  });

  after(async () => {
    await server.ldap.delete(groupDn).catch(() => undefined);
  });

  it('should have a schema marking the path required and generated', () => {
    const path = plugin.schema?.attributes?.twakeDepartmentPath;
    expect(path?.required, 'required').to.be.true;
    expect(path?.generated, 'generated').to.be.true;
  });

  it('should create a group without the generated path', async () => {
    await plugin.addGroup('generatedgrp', [], {
      twakeDepartmentLink: `ou=Test Org 1,ou=organization,${process.env.DM_LDAP_BASE}`,
      mail: 'generatedgrp@example.com',
    });
    const found = await plugin.searchGroupsByName('generatedgrp');
    expect(found).to.have.property('generatedgrp');
  });
});
