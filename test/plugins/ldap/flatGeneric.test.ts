import { expect } from 'chai';
import supertest from 'supertest';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { DM } from '../../../src/bin';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('LdapFlatGeneric plugin', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  let server: DM;
  let plugin: LdapFlatGeneric;
  let request: any;

  before(async function () {
    this.timeout(5000);
    process.env.DM_LDAP_FLAT_SCHEMA =
      './static/schemas/twake/nomenclature/twakeTitle.json,./static/schemas/twake/nomenclature/twakeListType.json';
    server = new DM();
    await server.ready;
    plugin = new LdapFlatGeneric(server);
    await server.registerPlugin('ldapFlatGeneric', plugin);
    request = supertest(server.app);
  });

  after(async () => {
    // Cleanup is handled automatically
  });

  describe('constructor', () => {
    it('should create instances from schemas', () => {
      expect(plugin.instances).to.have.lengthOf(2);
      expect(plugin.instances[0].name).to.equal('ldapFlat:twakeTitle');
      expect(plugin.instances[1].name).to.equal('ldapFlat:twakeListType');
    });
  });

  describe('API endpoints', () => {
    it('should list titles', async () => {
      const res = await request.get('/api/v1/ldap/titles');
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('object');
      expect(res.body).to.have.property('Dr');
      expect(res.body).to.have.property('Mr');
    });

    it('should list listTypes', async () => {
      const res = await request.get('/api/v1/ldap/listTypes');
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('object');
      expect(res.body).to.have.property('openList');
      expect(res.body).to.have.property('memberRestrictedList');
    });

    it('should filter titles by name', async () => {
      const res = await request.get(
        '/api/v1/ldap/titles?match=Dr&attribute=cn'
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('object');
      expect(res.body).to.have.property('Dr');
    });
  });

  describe('CRUD operations', () => {
    afterEach(async () => {
      try {
        await plugin.instances[0].deleteEntry('TestTitle');
      } catch (e) {
        // Ignore
      }
    });

    it('should create a new title', async () => {
      const res = await request
        .post('/api/v1/ldap/titles')
        .send({ cn: 'TestTitle', description: 'Test description' });
      expect(res.status).to.equal(201);
      expect(res.body).to.have.property('cn', 'TestTitle');
    });

    it('should update a title', async () => {
      await plugin.instances[0].addEntry('TestTitle', {
        description: 'Original',
      });

      const res = await request
        .put(
          `/api/v1/ldap/titles/cn=TestTitle,ou=twakeTitle,ou=nomenclature,${process.env.DM_LDAP_BASE}`
        )
        .send({ replace: { description: 'Updated' } });
      expect(res.status).to.equal(200);

      const entries = await plugin.instances[0].searchEntriesByName(
        'TestTitle',
        false,
        ['cn', 'description']
      );
      expect(entries.TestTitle).to.have.property('description', 'Updated');
    });

    it('should delete a title', async () => {
      await plugin.instances[0].addEntry('TestTitle');

      const res = await request.delete(
        `/api/v1/ldap/titles/cn=TestTitle,ou=twakeTitle,ou=nomenclature,${process.env.DM_LDAP_BASE}`
      );
      expect(res.status).to.equal(200);

      const entries = await plugin.instances[0].listEntries({});
      expect(entries).to.not.have.property('TestTitle');
    });
  });
});
