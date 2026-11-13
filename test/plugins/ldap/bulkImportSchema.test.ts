/**
 * The import reads a schema in the format the documentation points it at: the
 * entity one `--ldap-flat-schema` takes (`--bulk-import-schemas
 * users:./static/schemas/twake/users.json`), not only the flat import one it
 * was written for.
 *
 * Read the flat way, such a file names no base and no main attribute: the
 * rows land at the directory root, under `cn`, with none of the schema's
 * fixed, required or role attributes — outside every entity whose schema holds
 * the rules that guard them.
 */
import { join } from 'path';

import { expect } from 'chai';

import type { Config } from '../../../src/bin/index.js';
import { loadSchemaFile } from '../../../src/lib/schemaFile';
import { readBulkImportSchema } from '../../../src/plugins/ldap/bulkImport';

type RawSchema = Parameters<typeof readBulkImportSchema>[0];

describe('Bulk import schemas', () => {
  const config = { ldap_base: 'dc=example,dc=com' } as Config;
  const read = (file: string): ReturnType<typeof readBulkImportSchema> =>
    readBulkImportSchema(loadSchemaFile<RawSchema>(file, { config }), file);

  it('reads the shipped entity schema into the branch it declares', () => {
    const schema = read(join('static', 'schemas', 'twake', 'users.json'));
    expect(schema.base).to.equal('ou=users,dc=example,dc=com');
    expect(schema.mainAttribute).to.equal('uid');
    expect(schema.properties.objectClass.fixed).to.equal(true);
    expect(schema.properties.objectClass.default).to.include('twakeAccount');
    expect(schema.properties.mail.required).to.equal(true);
    expect(schema.properties.twakeDepartmentLink.role).to.deep.equal([
      'organizationLink',
    ]);
    expect(schema.properties.twakeDepartmentPath.role).to.deep.equal([
      'organizationPath',
    ]);
  });

  it('keeps the entity rules the import applies to its columns', () => {
    const schema = read(join('static', 'schemas', 'twake', 'users.json'));
    expect(schema.entity.strict).to.equal(true);
    expect(schema.entity.attributes).to.have.property('mail');
    expect(schema.entity.attributes).to.not.have.property('twakeCozyDomain');
  });

  it('reads the flat format as a schema that declares no strict', () => {
    const schema = readBulkImportSchema(
      {
        base: 'ou=people,dc=example,dc=com',
        mainAttribute: 'uid',
        properties: { uid: { type: 'string', required: true } },
      },
      'inline'
    );
    expect(schema.entity.strict).to.equal(false);
    expect(schema.entity.attributes).to.have.property('uid');
  });

  it('keeps reading the flat import format', () => {
    const schema = readBulkImportSchema(
      {
        base: 'ou=people,dc=example,dc=com',
        mainAttribute: 'uid',
        properties: {
          uid: { type: 'string', required: true },
          twakeDepartmentLink: { role: ['organizationLink'] },
        },
      },
      'inline'
    );
    expect(schema.base).to.equal('ou=people,dc=example,dc=com');
    expect(schema.mainAttribute).to.equal('uid');
    expect(schema.properties.uid.required).to.equal(true);
    expect(schema.properties.twakeDepartmentLink.role).to.deep.equal([
      'organizationLink',
    ]);
  });

  it('gives roles as lists, whichever way the file spells them', () => {
    const schema = readBulkImportSchema(
      {
        entity: { base: 'ou=people,dc=example,dc=com', mainAttribute: 'cn' },
        attributes: { cn: { role: 'identifier' } },
      },
      'inline'
    );
    expect(schema.mainAttribute).to.equal('cn');
    expect(schema.properties.cn.role).to.deep.equal(['identifier']);
  });

  it('refuses a schema naming no base', () => {
    for (const raw of [
      {},
      { entity: {} },
      { base: '' },
      { mainAttribute: 'uid', properties: {} },
    ])
      expect(
        () => readBulkImportSchema(raw, 'schema.json'),
        JSON.stringify(raw)
      ).to.throw(/names no base/);
  });
});
