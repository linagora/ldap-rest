/**
 * The upgrade notes tell an operator who wants the old behaviour to copy the
 * schema and drop the `generated` markers. Dropping the one on `uid` lifted
 * the refusal but left `generatedFrom` deriving the identifier anyway, and
 * the organization path was computed whatever the marker said: the client's
 * value was replaced, silently, on a 201.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import type { SearchResult } from 'ldapts';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Schema copy without the generated markers', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let deptDn: string;
  let schemaFile: string;
  let previousFlatSchema: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    deptDn = `ou=EscapeOrg,${base}`;

    // What the upgrade notes describe: the shipped schema, markers removed
    const schema = JSON.parse(
      fs.readFileSync('./static/schemas/twake/users.json', 'utf8')
    ) as { attributes: Record<string, { generated?: boolean }> };
    delete schema.attributes.uid.generated;
    delete schema.attributes.twakeDepartmentPath.generated;
    schemaFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'escape-hatch-')),
      'users.json'
    );
    // Indented like the original: the placeholder substitution cannot read a
    // minified schema
    fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2));

    previousFlatSchema = process.env.DM_LDAP_FLAT_SCHEMA;
    process.env.DM_LDAP_FLAT_SCHEMA = schemaFile;
    server = new DM();
    await server.ready;
    await server.ldap
      .add(deptDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'EscapeOrg',
        twakeDepartmentPath: 'EscapeOrg',
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
    await server.ldap
      .delete(`uid=escprobe1,ou=users,${base}`)
      .catch(() => undefined);
    await server.ldap
      .delete(`uid=escape.probe.one,ou=users,${base}`)
      .catch(() => undefined);
    await server.ldap.delete(deptDn).catch(() => undefined);
    fs.rmSync(path.dirname(schemaFile), { recursive: true, force: true });
    if (previousFlatSchema === undefined)
      delete process.env.DM_LDAP_FLAT_SCHEMA;
    else process.env.DM_LDAP_FLAT_SCHEMA = previousFlatSchema;
  });

  it('should keep the identifier and the path the client sent', async () => {
    const res = await request.post('/api/v1/ldap/users').type('json').send({
      uid: 'escprobe1',
      cn: 'Escape Probe',
      sn: 'Probe',
      givenName: 'Escape',
      displayName: 'Escape Probe',
      employeeNumber: 'ESC0001',
      mail: 'escape.probe.one@example.com',
      twakeDepartmentLink: deptDn,
      twakeDepartmentPath: 'Chosen / By / Client',
    });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect(res.body).to.have.property('uid', 'escprobe1');

    const stored = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['twakeDepartmentPath'] },
      `uid=escprobe1,ou=users,${base}`
    )) as SearchResult;
    expect(stored.searchEntries[0]).to.have.property(
      'twakeDepartmentPath',
      'Chosen / By / Client'
    );
  });
});
