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
  });
});
