import fs from 'fs';
import os from 'os';
import { join } from 'path';

import { expect } from 'chai';

import type { Config } from '../../src/bin';
import {
  loadSchemaFile,
  loadSchemaFileAsync,
  mergeSchema,
  resolveSchemaBase,
  schemaUrl,
  shippedSchemasPath,
} from '../../src/lib/schemaFile';

type TestSchema = {
  entity?: Record<string, unknown>;
  strict?: boolean;
  attributes: Record<string, Record<string, unknown>>;
};

describe('lib/schemaFile', () => {
  let dir: string;

  const write = (name: string, content: unknown): string => {
    const file = join(dir, name);
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'schemaFile-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('mergeSchema', () => {
    it('deletes a key set to null', () => {
      expect(
        mergeSchema({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null } })
      ).to.deep.equal({ a: 1, b: { d: 3 } });
    });

    it('patches nested objects key by key', () => {
      expect(
        mergeSchema(
          { x: { type: 'string', label: { en: 'X', fr: 'X' } } },
          { x: { label: { fr: 'Ixe' } } }
        )
      ).to.deep.equal({ x: { type: 'string', label: { en: 'X', fr: 'Ixe' } } });
    });

    it('replaces arrays instead of concatenating them', () => {
      expect(
        mergeSchema({ objectClass: ['top', 'a'] }, { objectClass: ['b'] })
      ).to.deep.equal({ objectClass: ['b'] });
    });

    it('replaces a scalar by an object and the reverse', () => {
      expect(
        mergeSchema({ a: 1, b: { c: 1 } }, { a: { c: 2 }, b: 3 })
      ).to.deep.equal({ a: { c: 2 }, b: 3 });
    });

    it('drops the nulls of a subtree the base does not have', () => {
      expect(mergeSchema({}, { a: { b: null, c: 1 } })).to.deep.equal({
        a: { c: 1 },
      });
    });

    it('leaves the base untouched', () => {
      const base = { a: { b: 1 } };
      mergeSchema(base, { a: { b: 2 } });
      expect(base).to.deep.equal({ a: { b: 1 } });
    });

    it('keeps "__proto__" an ordinary key', () => {
      const merged = mergeSchema(
        {},
        JSON.parse('{"__proto__": {"polluted": true}}')
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(merged)).to.equal(Object.prototype);
      expect((merged as { polluted?: boolean }).polluted).to.equal(undefined);
      expect(Object.keys(merged)).to.deep.equal(['__proto__']);
    });
  });

  describe('resolveSchemaBase', () => {
    it('resolves a relative path from the extending file', () => {
      expect(
        resolveSchemaBase('/etc/ldap-rest/a/users.json', '../b.json')
      ).to.equal('/etc/ldap-rest/b.json');
    });

    it('keeps an absolute path', () => {
      expect(resolveSchemaBase('/etc/users.json', '/opt/base.json')).to.equal(
        '/opt/base.json'
      );
    });

    it('resolves "ldap-rest:" in the shipped schemas', () => {
      expect(
        resolveSchemaBase('/etc/users.json', 'ldap-rest:twake/users.json')
      ).to.equal(join(shippedSchemasPath, 'twake', 'users.json'));
      expect(fs.existsSync(join(shippedSchemasPath, 'twake', 'users.json'))).to
        .be.true;
    });

    it('refuses "ldap-rest:" leaving the shipped schemas', () => {
      expect(() =>
        resolveSchemaBase('/etc/users.json', 'ldap-rest:../../package.json')
      ).to.throw(/not a shipped schema/);
    });
  });

  describe('loadSchemaFile', () => {
    it('returns a file without "extends" as it is', () => {
      const file = write('plain.json', { attributes: { a: null } });
      expect(loadSchemaFile(file)).to.deep.equal({ attributes: { a: null } });
    });

    it('merges a relative base and drops "extends"', () => {
      write('base/users.json', {
        strict: true,
        attributes: { a: { type: 'string' }, b: { type: 'number' } },
      });
      const file = write('local/users.json', {
        extends: '../base/users.json',
        attributes: { b: null, c: { type: 'string' } },
      });
      expect(loadSchemaFile(file)).to.deep.equal({
        strict: true,
        attributes: { a: { type: 'string' }, c: { type: 'string' } },
      });
    });

    it('merges an absolute base', () => {
      const base = write('base.json', {
        attributes: { a: { type: 'string' } },
      });
      const file = write('sub/users.json', {
        extends: base,
        strict: false,
      });
      expect(loadSchemaFile(file)).to.deep.equal({
        attributes: { a: { type: 'string' } },
        strict: false,
      });
    });

    it('merges a shipped schema named with "ldap-rest:"', () => {
      const file = write('users.json', {
        extends: 'ldap-rest:twake/users.json',
        attributes: { mailQuota: null, cn: { label: { fr: 'Nom' } } },
      });
      const schema = loadSchemaFile<TestSchema>(file);
      expect(schema.entity?.name).to.equal('twakeUser');
      expect(schema.attributes).to.not.have.property('mailQuota');
      expect(schema.attributes).to.have.property('mailQuotaSize');
      expect(schema.attributes.cn.label).to.deep.equal({
        en: 'Common name',
        fr: 'Nom',
      });
      expect(schema.attributes.cn.type).to.equal('string');
      expect(schema).to.not.have.property('extends');
    });

    it('follows a chain, the nearest file winning', () => {
      write('a.json', { attributes: { x: { type: 'string', label: 'A' } } });
      write('b.json', {
        extends: 'a.json',
        attributes: { x: { label: 'B' }, y: { type: 'string' } },
      });
      const file = write('c.json', {
        extends: './b.json',
        attributes: { y: null, x: { required: true } },
      });
      expect(loadSchemaFile(file)).to.deep.equal({
        attributes: { x: { type: 'string', label: 'B', required: true } },
      });
    });

    it('replaces the placeholders of every file of the chain', () => {
      write('base.json', { entity: { base: 'ou=users,__LDAP_BASE__' } });
      const file = write('users.json', {
        extends: 'base.json',
        attributes: { o: { branch: ['__ldap_base__'] } },
      });
      expect(
        loadSchemaFile(file, {
          config: { ldap_base: 'dc=example,dc=org' } as Config,
        })
      ).to.deep.equal({
        entity: { base: 'ou=users,dc=example,dc=org' },
        attributes: { o: { branch: ['dc=example,dc=org'] } },
      });
    });

    it('refuses a loop', () => {
      write('a.json', { extends: 'b.json' });
      write('b.json', { extends: 'c.json' });
      write('c.json', { extends: 'a.json' });
      expect(() => loadSchemaFile(join(dir, 'a.json'))).to.throw(
        /"extends" loop: .*a\.json -> .*b\.json -> .*c\.json -> .*a\.json/
      );
    });

    it('refuses a file extending itself', () => {
      const file = write('a.json', { extends: 'a.json' });
      expect(() => loadSchemaFile(file)).to.throw(/"extends" loop/);
    });

    it('names the missing base', () => {
      const file = write('users.json', { extends: 'missing.json' });
      expect(() => loadSchemaFile(file)).to.throw(
        /users\.json extends .*missing\.json, which cannot be read/
      );
    });

    it('keeps the error code of a missing file', () => {
      let err: (Error & { code?: string }) | undefined;
      try {
        loadSchemaFile(join(dir, 'missing.json'));
      } catch (e) {
        err = e as Error & { code?: string };
      }
      expect(err?.code).to.equal('ENOENT');
    });

    it('names the file holding invalid JSON', () => {
      fs.writeFileSync(join(dir, 'broken.json'), '{');
      const file = write('users.json', { extends: 'broken.json' });
      expect(() => loadSchemaFile(file)).to.throw(/broken\.json: /);
    });

    it('refuses an "extends" that is not a path', () => {
      const file = write('users.json', { extends: 42 });
      expect(() => loadSchemaFile(file)).to.throw(
        /"extends" must be the path of a schema/
      );
    });
  });

  describe('loadSchemaFileAsync', () => {
    it('merges a chain as the synchronous version does', async () => {
      write('a.json', { attributes: { x: { type: 'string' }, y: {} } });
      const file = write('b.json', {
        extends: 'a.json',
        attributes: { y: null },
      });
      expect(await loadSchemaFileAsync(file)).to.deep.equal({
        attributes: { x: { type: 'string' } },
      });
    });

    it('refuses a loop', async () => {
      const file = write('a.json', { extends: 'a.json' });
      let err: Error | undefined;
      try {
        await loadSchemaFileAsync(file);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).to.match(/"extends" loop/);
    });
  });

  describe('schemaUrl', () => {
    it('serves a file from its first "schemas" directory', () => {
      expect(
        schemaUrl(
          { static_name: 'static' } as Config,
          '/etc/ldap-rest/schemas/twake/users.json'
        )
      ).to.equal('/static/schemas/twake/users.json');
    });

    it('gives no URL to a file outside any "schemas" directory', () => {
      expect(schemaUrl({} as Config, '/etc/ldap-rest/users.json')).to.equal(
        undefined
      );
    });
  });
});
