import { expect } from 'chai';
import supertest from 'supertest';
import { Client, Attribute } from 'ldapts';

import LdapRaw from '../../../src/plugins/ldap/raw';
import { DM } from '../../../src/bin';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('LDAP Raw Plugin', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  let server: DM;
  let plugin: LdapRaw;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let prefix: string;

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    server = new DM();
    await server.ready;
    plugin = new LdapRaw(server);
    await server.registerPlugin('ldapRaw', plugin);
    plugin.api(server.app);
    request = supertest(server.app);
    prefix = `${server.config.api_prefix}/v1/ldap/raw`;
  });

  describe('constructor', () => {
    it('should default to ldap_base when no raw base is configured', () => {
      expect(plugin.bases).to.deep.equal([base]);
    });

    it('should use the configured raw bases', () => {
      const tmp = new DM();
      tmp.config.ldap_raw_base = [`ou=users,${base}`];
      const instance = new LdapRaw(tmp);
      expect(instance.bases).to.deep.equal([`ou=users,${base}`]);
    });

    it('should throw when neither ldap_base nor ldap_raw_base is set', () => {
      const tmp = new DM();
      const saved = tmp.config.ldap_base;
      delete tmp.config.ldap_base;
      tmp.config.ldap_raw_base = [];
      expect(() => new LdapRaw(tmp)).to.throw('Missing --ldap-base');
      tmp.config.ldap_base = saved;
    });

    it('should lowercase hidden attributes and add them to the secrets', () => {
      const tmp = new DM();
      tmp.config.ldap_raw_hidden_attribute = ['telephoneNumber'];
      const instance = new LdapRaw(tmp);
      expect(instance.hiddenAttributes.has('telephonenumber')).to.equal(true);
      // The built-in credential list stays in place
      expect(instance.hiddenAttributes.has('userpassword')).to.equal(true);
    });
  });

  describe('checkDn', () => {
    it('should accept the base itself and its descendants', () => {
      expect(() => plugin.checkDn(base)).to.not.throw();
      expect(() => plugin.checkDn(`ou=users,${base}`)).to.not.throw();
    });

    it('should reject an empty DN', () => {
      expect(() => plugin.checkDn('')).to.throw('DN is required');
    });

    it('should reject a DN outside the exposed bases', () => {
      expect(() => plugin.checkDn('dc=elsewhere,dc=org')).to.throw(
        'outside the exposed bases'
      );
    });
  });

  describe('GET /bases', () => {
    it('should list the exposed bases', async () => {
      const res = await request.get(`${prefix}/bases`);
      expect(res.status).to.equal(200);
      expect(res.body.bases).to.deep.equal([base]);
    });
  });

  describe('GET /rootdse', () => {
    it('should return the naming contexts', async () => {
      const res = await request.get(`${prefix}/rootdse`);
      expect(res.status).to.equal(200);
      expect(res.body.dn).to.equal('');
      const contexts = res.body.attributes.namingContexts;
      expect(contexts).to.be.an('object');
      expect(contexts.values).to.contain(base);
      expect(contexts.binary).to.equal(false);
    });

    it('should advertise the subschema entry', async () => {
      const dn = await plugin.getSubschemaDn();
      expect(dn.toLowerCase()).to.contain('subschema');
    });
  });

  describe('GET /schema', () => {
    it('should return the parsed schema', async () => {
      const res = await request.get(`${prefix}/schema`);
      expect(res.status).to.equal(200);
      expect(res.body.objectClasses).to.be.an('array');
      expect(res.body.attributeTypes).to.be.an('array');
      expect(res.body.objectClasses.length).to.be.greaterThan(0);
      expect(res.body.attributeTypes.length).to.be.greaterThan(0);

      const person = res.body.objectClasses.find((oc: { names: string[] }) =>
        oc.names.includes('person')
      );
      expect(person, 'person object class').to.not.equal(undefined);
      expect(person.must).to.contain('cn');
      expect(person.must).to.contain('sn');
    });

    it('should resolve mandatory attributes through inheritance', async () => {
      const index = await plugin.getSchemaIndex();
      const { must, may } = index.resolveAttributes(['inetOrgPerson']);
      expect(must).to.contain('sn');
      expect(must).to.contain('cn');
      expect(may).to.contain('mail');
    });

    it('should serve the schema from cache on the second call', async () => {
      const first = await plugin.getSchemaIndex();
      const second = await plugin.getSchemaIndex();
      expect(second).to.equal(first);
    });
  });

  describe('GET /entry/:dn', () => {
    it('should read an entry with its operational attributes', async () => {
      const res = await request.get(
        `${prefix}/entry/${encodeURIComponent(`ou=users,${base}`)}`
      );
      expect(res.status).to.equal(200);
      expect(res.body.dn.toLowerCase()).to.equal(
        `ou=users,${base}`.toLowerCase()
      );
      expect(res.body.attributes.ou.values).to.deep.equal(['users']);
      expect(res.body.attributes.objectClass.values).to.contain(
        'organizationalUnit'
      );
      // `+` attributes
      expect(res.body.attributes).to.have.property('entryUUID');
    });

    it('should not expose the attribute wildcards as attributes', async () => {
      const res = await request.get(
        `${prefix}/entry/${encodeURIComponent(`ou=users,${base}`)}`
      );
      expect(res.body.attributes).to.not.have.property('*');
      expect(res.body.attributes).to.not.have.property('+');
    });

    it('should return 404 on an unknown DN', async () => {
      const res = await request.get(
        `${prefix}/entry/${encodeURIComponent(`ou=nothere,${base}`)}`
      );
      expect(res.status).to.equal(404);
      expect(res.body.error).to.contain('not found');
    });

    it('should return 403 on a DN outside the exposed bases', async () => {
      const res = await request.get(
        `${prefix}/entry/${encodeURIComponent('dc=elsewhere,dc=org')}`
      );
      expect(res.status).to.equal(403);
    });

    it('should omit configured hidden attributes', async () => {
      const dn = `uid=rawhidden,ou=users,${base}`;
      await server.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'rawhidden',
        cn: 'Raw Hidden',
        sn: 'Hidden',
        description: 'to be hidden',
      });
      try {
        const visible = await plugin.getEntry(dn);
        expect(visible.attributes).to.have.property('description');

        plugin.hiddenAttributes.add('description');
        const hidden = await plugin.getEntry(dn);
        expect(hidden.attributes).to.not.have.property('description');
        expect(hidden.attributes).to.have.property('uid');
      } finally {
        plugin.hiddenAttributes.delete('description');
        await server.ldap.delete(dn);
      }
    });

    it('should hide credential attributes by default', async () => {
      const dn = `uid=rawsecret,ou=users,${base}`;
      await server.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'rawsecret',
        cn: 'Raw Secret',
        sn: 'Secret',
        userPassword: 'secret',
      });
      try {
        const entry = await plugin.getEntry(dn);
        expect(entry.attributes).to.not.have.property('userPassword');
        expect(entry.attributes).to.have.property('uid');

        // Asking for it explicitly must not get around the filter
        const asked = await plugin.search(
          {
            base: dn,
            scope: 'base',
            filter: '(objectClass=*)',
            attributes: ['uid', 'userPassword'],
          },
          undefined
        );
        expect(asked.entries[0].attributes).to.not.have.property(
          'userPassword'
        );
        expect(asked.entries[0].attributes).to.have.property('uid');

        // Neither must a search over the branch
        const found = await plugin.search({
          base: `ou=users,${base}`,
          scope: 'sub',
          filter: '(uid=rawsecret)',
        });
        expect(found.entries[0].attributes).to.not.have.property(
          'userPassword'
        );
      } finally {
        await server.ldap.delete(dn);
      }
    });

    it('should serve credential attributes when explicitly allowed', () => {
      const tmp = new DM();
      tmp.config.ldap_raw_show_secrets = true;
      const permissive = new LdapRaw(tmp);
      expect(permissive.showSecrets).to.equal(true);
      expect(permissive.hiddenAttributes.has('userpassword')).to.equal(false);
      expect(permissive.getConfigApiData().showSecrets).to.equal(true);
    });

    it('should keep hiding credential attributes of other directories', () => {
      // Samba, Kerberos and AD spellings, not just OpenLDAP's
      for (const attribute of [
        'userpassword',
        'sambantpassword',
        'krbprincipalkey',
        'unicodepwd',
      ])
        expect(plugin.hiddenAttributes.has(attribute), attribute).to.equal(
          true
        );
    });

    it('should base64-encode binary values', async () => {
      const dn = `uid=rawbinary,ou=users,${base}`;
      const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      // `ldapActions.add` stringifies Buffer values, which would destroy the
      // octets: write this fixture straight through ldapts.
      const client = new Client({
        url: (process.env.DM_LDAP_URL as string).split(',')[0],
      });
      await client.bind(
        process.env.DM_LDAP_DN as string,
        process.env.DM_LDAP_PWD as string
      );
      await client.add(dn, [
        new Attribute({
          type: 'objectClass',
          values: ['top', 'inetOrgPerson'],
        }),
        new Attribute({ type: 'uid', values: ['rawbinary'] }),
        new Attribute({ type: 'cn', values: ['Raw Binary'] }),
        new Attribute({ type: 'sn', values: ['Binary'] }),
        new Attribute({ type: 'jpegPhoto', values: [photo] }),
      ]);
      await client.unbind();
      try {
        const entry = await plugin.getEntry(dn);
        expect(entry.attributes.jpegPhoto.binary).to.equal(true);
        expect(entry.attributes.jpegPhoto.values[0]).to.equal(
          photo.toString('base64')
        );
        expect(entry.attributes.cn.binary).to.equal(false);
      } finally {
        await server.ldap.delete(dn);
      }
    });
  });

  describe('GET /children/:dn', () => {
    it('should list direct children only', async () => {
      const res = await request.get(
        `${prefix}/children/${encodeURIComponent(base)}`
      );
      expect(res.status).to.equal(200);
      expect(res.body.children).to.be.an('array');
      expect(res.body.truncated).to.equal(false);
      const rdns = res.body.children.map((c: { rdn: string }) => c.rdn);
      expect(rdns).to.contain('ou=users');
      expect(rdns).to.contain('ou=groups');
      // `ou=lists,ou=groups` is a grandchild, it must not show up
      expect(rdns).to.not.contain('ou=lists');
    });

    it('should sort children by RDN', async () => {
      const res = await request.get(
        `${prefix}/children/${encodeURIComponent(base)}`
      );
      const rdns = res.body.children.map((c: { rdn: string }) => c.rdn);
      expect(rdns).to.deep.equal([...rdns].sort((a, b) => a.localeCompare(b)));
    });

    it('should not compute hasChildren unless asked', async () => {
      const res = await request.get(
        `${prefix}/children/${encodeURIComponent(base)}`
      );
      expect(
        res.body.children.every(
          (c: { hasChildren: boolean }) => c.hasChildren === false
        )
      ).to.equal(true);
    });

    it('should compute hasChildren when asked', async () => {
      const res = await request.get(
        `${prefix}/children/${encodeURIComponent(base)}?children=1`
      );
      expect(res.status).to.equal(200);
      const groups = res.body.children.find(
        (c: { rdn: string }) => c.rdn === 'ou=groups'
      );
      expect(groups.hasChildren).to.equal(true);
    });

    it('should flag a truncated listing instead of hiding entries', async () => {
      const previous = plugin.maxResults;
      plugin.maxResults = 1;
      try {
        const res = await request.get(
          `${prefix}/children/${encodeURIComponent(base)}`
        );
        expect(res.status).to.equal(200);
        expect(res.body.children).to.have.length(1);
        expect(res.body.truncated).to.equal(true);
      } finally {
        plugin.maxResults = previous;
      }
    });

    it('should return 403 outside the exposed bases', async () => {
      const res = await request.get(
        `${prefix}/children/${encodeURIComponent('dc=elsewhere,dc=org')}`
      );
      expect(res.status).to.equal(403);
    });
  });

  describe('GET /search', () => {
    it('should search with an explicit filter and attribute list', async () => {
      const res = await request
        .get(`${prefix}/search`)
        .query({ filter: '(ou=users)', attributes: 'ou,description' });
      expect(res.status).to.equal(200);
      expect(res.body.entries).to.have.length(1);
      expect(res.body.entries[0].attributes.ou.values).to.deep.equal(['users']);
      expect(res.body.entries[0].attributes).to.not.have.property(
        'objectClass'
      );
      expect(res.body.truncated).to.equal(false);
    });

    it('should honour the scope', async () => {
      const res = await request
        .get(`${prefix}/search`)
        .query({ base, scope: 'base' });
      expect(res.status).to.equal(200);
      expect(res.body.entries).to.have.length(1);
      expect(res.body.entries[0].dn.toLowerCase()).to.equal(base.toLowerCase());
    });

    it('should flag truncated results', async () => {
      const res = await request.get(`${prefix}/search`).query({ limit: 1 });
      expect(res.status).to.equal(200);
      expect(res.body.entries).to.have.length(1);
      expect(res.body.truncated).to.equal(true);
    });

    it('should reject an unparseable filter with an explicit message', async () => {
      // What a user naturally types into a search box
      const res = await request
        .get(`${prefix}/search`)
        .query({ filter: 'gov' });
      expect(res.status).to.equal(400);
      expect(res.body.error).to.contain('Invalid LDAP filter');
      expect(res.body.error).to.contain('gov');
      // The message must say what a filter looks like, with a placeholder
      // that cannot be mistaken for the value the user typed
      expect(res.body.error).to.contain('(cn=foo)');
    });

    it('should accept a well-formed filter', () => {
      expect(() => plugin.checkFilter('(cn=foo)')).to.not.throw();
      expect(() =>
        plugin.checkFilter('(|(cn=*foo*)(ou=*foo*))')
      ).to.not.throw();
      expect(() => plugin.checkFilter('gov')).to.throw('Invalid LDAP filter');
      expect(() => plugin.checkFilter('(cn=foo')).to.throw(
        'Invalid LDAP filter'
      );
    });

    it('should reject an invalid scope', async () => {
      const res = await request
        .get(`${prefix}/search`)
        .query({ scope: 'deep' });
      expect(res.status).to.equal(400);
      expect(res.body.error).to.contain('Invalid scope');
    });

    it('should reject a non-positive limit', async () => {
      const res = await request.get(`${prefix}/search`).query({ limit: '0' });
      expect(res.status).to.equal(400);
    });

    it('should reject a base outside the exposed bases', async () => {
      const res = await request
        .get(`${prefix}/search`)
        .query({ base: 'dc=elsewhere,dc=org' });
      expect(res.status).to.equal(403);
    });
  });

  describe('parentOf', () => {
    it('should return null for an exposed base', () => {
      expect(plugin.parentOf(base)).to.equal(null);
    });

    it('should return the parent DN otherwise', () => {
      expect(plugin.parentOf(`ou=lists,ou=groups,${base}`)).to.equal(
        `ou=groups,${base}`
      );
    });
  });

  describe('getConfigApiData', () => {
    it('should advertise a read-only API', () => {
      const data = plugin.getConfigApiData();
      expect(data.readOnly).to.equal(true);
      expect(data.bases).to.deep.equal([base]);
    });
  });
});
