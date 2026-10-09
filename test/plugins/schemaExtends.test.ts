/**
 * A schema file extending another, through the plugins that load it: the
 * server, the configuration API and the static plugin must all hand out the
 * merged schema, including when the file is outside the static directory.
 */
import fs from 'fs';
import os from 'os';
import { join } from 'path';

import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import ConfigApi from '../../src/plugins/configApi';
import LdapBulkImport from '../../src/plugins/ldap/bulkImport';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../src/plugins/ldap/groups';
import Static from '../../src/plugins/static';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';
import { waitFor } from '../helpers/waitFor';

type Attributes = Record<string, Record<string, unknown>>;

describe('Schemas extending another', () => {
  let dir: string;
  let usersFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'schemaExtends-'));
    fs.mkdirSync(join(dir, 'schemas'));
    usersFile = join(dir, 'schemas', 'users.json');
    fs.writeFileSync(
      usersFile,
      JSON.stringify({
        extends: 'ldap-rest:twake/users.json',
        attributes: {
          mailQuota: null,
          cn: { label: { fr: 'Nom complet' } },
        },
      })
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('static plugin', () => {
    let savedLdapBase: string | undefined;

    before(() => {
      savedLdapBase = process.env.DM_LDAP_BASE;
      process.env.DM_LDAP_BASE = 'dc=example,dc=com';
    });

    after(() => {
      if (savedLdapBase !== undefined) process.env.DM_LDAP_BASE = savedLdapBase;
      else delete process.env.DM_LDAP_BASE;
    });

    it('serves a configured file outside the static directory, merged', async () => {
      const dm = new DM();
      await dm.ready;
      dm.config.ldap_flat_schema = [usersFile];
      await dm.registerPlugin('static', new Static(dm));

      const res = await supertest(dm.app).get('/static/schemas/users.json');
      expect(res.status).to.equal(200);
      expect(res.body).to.not.have.property('extends');
      expect(res.body.entity.base).to.equal('ou=users,dc=example,dc=com');
      const attributes = res.body.attributes as Attributes;
      expect(attributes).to.not.have.property('mailQuota');
      expect(attributes.cn.label).to.deep.equal({
        en: 'Common name',
        fr: 'Nom complet',
      });
    });

    it('serves a configured file at the URL of a shipped one it shadows', async () => {
      fs.mkdirSync(join(dir, 'schemas', 'twake'));
      const shadowing = join(dir, 'schemas', 'twake', 'users.json');
      fs.renameSync(usersFile, shadowing);
      const dm = new DM();
      await dm.ready;
      dm.config.ldap_flat_schema = [shadowing];
      await dm.registerPlugin('static', new Static(dm));

      const request = supertest(dm.app);
      const res = await request.get('/static/schemas/twake/users.json');
      expect(res.status).to.equal(200);
      expect(res.body.attributes).to.not.have.property('mailQuota');
      // the other shipped schemas are still served from the static directory
      const groups = await request.get('/static/schemas/twake/groups.json');
      expect(groups.status).to.equal(200);
      expect(groups.body.entity.name).to.equal('twakeGroup');
    });

    it('serves a file of the static directory merged, at any depth', async () => {
      const deep = join(dir, 'schemas', 'a', 'b');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(
        join(deep, 'users.json'),
        JSON.stringify({ extends: '../../users.json', strict: false })
      );
      const dm = new DM();
      await dm.ready;
      dm.config.static_path = dir;
      await dm.registerPlugin('static', new Static(dm));

      const request = supertest(dm.app);
      const res = await request.get('/static/schemas/a/b/users.json');
      expect(res.status).to.equal(200);
      expect(res.body.strict).to.equal(false);
      expect(res.body.entity.name).to.equal('twakeUser');
      expect(res.body.attributes).to.not.have.property('mailQuota');

      const missing = await request.get('/static/schemas/a/b/missing.json');
      expect(missing.status).to.equal(404);
    });

    it('serves the first of two configured files on one URL, and warns', async () => {
      fs.mkdirSync(join(dir, 'other', 'schemas'), { recursive: true });
      const second = join(dir, 'other', 'schemas', 'users.json');
      fs.writeFileSync(
        second,
        JSON.stringify({ entity: { name: 'second' }, attributes: {} })
      );
      const dm = new DM();
      await dm.ready;
      dm.config.ldap_flat_schema = [usersFile, second];
      const warnings: string[] = [];
      const logger = dm.logger as unknown as { warn: unknown };
      const original = logger.warn;
      logger.warn = (message: unknown) => warnings.push(String(message));
      try {
        await dm.registerPlugin('static', new Static(dm));
      } finally {
        logger.warn = original;
      }

      expect(warnings).to.deep.equal([
        `${second} is not served: ${usersFile} already has its URL /static/schemas/users.json`,
      ]);
      const res = await supertest(dm.app).get('/static/schemas/users.json');
      expect(res.status).to.equal(200);
      expect(res.body.entity.name).to.equal('twakeUser');
    });

    it('leaves the URL of a default schema option to the static directory', async () => {
      fs.mkdirSync(join(dir, 'schemas', 'twake'));
      fs.writeFileSync(
        join(dir, 'schemas', 'twake', 'groups.json'),
        JSON.stringify({ entity: { name: 'operatorGroup' }, attributes: {} })
      );
      const dm = new DM();
      await dm.ready;
      expect(dm.config.group_schema).to.match(/static\/schemas\/twake\/groups/);
      dm.config.static_path = dir;
      await dm.registerPlugin('static', new Static(dm));

      const res = await supertest(dm.app).get(
        '/static/schemas/twake/groups.json'
      );
      expect(res.status).to.equal(200);
      expect(res.body.entity.name).to.equal('operatorGroup');
    });

    it('serves a configured file whose URL needs percent-encoding', async () => {
      fs.mkdirSync(join(dir, 'schemas', 'users rest'));
      const spaced = join(dir, 'schemas', 'users rest', 'users.json');
      fs.renameSync(usersFile, spaced);
      const dm = new DM();
      await dm.ready;
      dm.config.ldap_flat_schema = [spaced];
      await dm.registerPlugin('static', new Static(dm));

      // without the table, `:dir/:name` would refuse the space with a 400
      const res = await supertest(dm.app).get(
        '/static/schemas/users%20rest/users.json'
      );
      expect(res.status).to.equal(200);
      expect(res.body.entity.name).to.equal('twakeUser');
    });

    it('accepts dotted names and refuses malformed ones at any depth', async () => {
      const deep = join(dir, 'schemas', 'a', 'b');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(
        join(dir, 'schemas', 'my.users.json'),
        JSON.stringify({ extends: 'users.json', strict: false })
      );
      fs.writeFileSync(join(deep, 'notes.txt'), 'plain');
      const dm = new DM();
      await dm.ready;
      dm.config.static_path = dir;
      await dm.registerPlugin('static', new Static(dm));
      const request = supertest(dm.app);

      const dotted = await request.get('/static/schemas/my.users.json');
      expect(dotted.status).to.equal(200);
      expect(dotted.body.strict).to.equal(false);
      expect(dotted.body.entity.name).to.equal('twakeUser');

      for (const url of [
        '/static/schemas/a..json',
        '/static/schemas/a/.json',
        '/static/schemas/a/b/c%20d.json',
        '/static/schemas/a/b%20c/d/e.json',
        '/static/schemas/a/b/..%2F..%2F..%2Fpackage.json',
      ]) {
        const res = await request.get(url);
        expect(res.status, url).to.equal(400);
      }

      // not a schema: left to the static files
      const text = await request.get('/static/schemas/a/b/notes.txt');
      expect(text.status).to.equal(200);
      expect(text.text).to.equal('plain');
    });

    it('answers 500 when the base is missing', async () => {
      fs.writeFileSync(
        join(dir, 'schemas', 'broken.json'),
        JSON.stringify({ extends: 'missing.json' })
      );
      const dm = new DM();
      await dm.ready;
      dm.config.static_path = dir;
      await dm.registerPlugin('static', new Static(dm));

      const res = await supertest(dm.app).get('/static/schemas/broken.json');
      expect(res.status).to.equal(500);
    });
  });

  describe('server side', () => {
    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    });

    it('uses and advertises the merged schema of a flat entity', async () => {
      const dm = new DM();
      await dm.ready;
      dm.config.ldap_flat_schema = [usersFile];
      await dm.registerPlugin('static', new Static(dm));
      const flat = new LdapFlatGeneric(dm);
      await dm.registerPlugin('ldapFlatGeneric', flat);
      await dm.registerPlugin('configApi', new ConfigApi(dm));

      expect(flat.instances).to.have.length(1);
      const attributes = flat.instances[0].schema?.attributes;
      expect(attributes).to.not.have.property('mailQuota');
      expect(attributes).to.have.property('mailQuotaSize');
      expect(flat.instances[0].base).to.equal(
        `ou=users,${dm.config.ldap_base}`
      );

      const request = supertest(dm.app);
      const config = await request
        .get('/api/v1/config')
        .set('Accept', 'application/json');
      expect(config.status).to.equal(200);
      const resource = (
        config.body.features.ldapFlatGeneric.flatResources as {
          schema: { attributes: Attributes };
          schemaUrl: string;
        }[]
      )[0];
      expect(resource.schema.attributes).to.not.have.property('mailQuota');
      expect(resource.schema.attributes.cn.label).to.deep.equal({
        en: 'Common name',
        fr: 'Nom complet',
      });
      expect(resource.schemaUrl).to.equal('/static/schemas/users.json');

      const served = await request.get(resource.schemaUrl);
      expect(served.status).to.equal(200);
      expect(served.body).to.deep.equal(resource.schema);
    });

    it('loads a merged group schema', async () => {
      const groupFile = join(dir, 'schemas', 'groups.json');
      fs.writeFileSync(
        groupFile,
        JSON.stringify({
          extends: 'ldap-rest:twake/groups.json',
          attributes: { description: null },
        })
      );
      const dm = new DM();
      await dm.ready;
      dm.config.group_schema = groupFile;
      const groups = new LdapGroups(dm);
      await waitFor(() => !!groups.schema, { what: 'group schema' });
      expect(groups.schema?.attributes).to.not.have.property('description');
      expect(groups.schema?.attributes).to.have.property('member');
    });

    it('replaces the placeholders of a bulk import schema chain', async () => {
      // the bulk import reads its own top-level `base`, inherited here
      fs.writeFileSync(
        join(dir, 'bulk-base.json'),
        JSON.stringify({
          extends: 'ldap-rest:twake/users.json',
          base: 'ou=users,__LDAP_BASE__',
        })
      );
      const bulkFile = join(dir, 'bulk-users.json');
      fs.writeFileSync(
        bulkFile,
        JSON.stringify({ extends: 'bulk-base.json', mainAttribute: 'uid' })
      );
      const dm = new DM();
      await dm.ready;
      dm.config.bulk_import_schemas = `users:${bulkFile}`;
      const bulk = new LdapBulkImport(dm);
      const resources = bulk.getConfigApiData().resources as {
        base: string;
        mainAttribute: string;
      }[];
      expect(resources).to.have.length(1);
      expect(resources[0].base).to.equal(`ou=users,${dm.config.ldap_base}`);
      expect(resources[0].mainAttribute).to.equal('uid');
    });
  });
});
