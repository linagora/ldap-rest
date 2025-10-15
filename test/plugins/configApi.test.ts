import { expect } from 'chai';
import supertest from 'supertest';
import { DM } from '../../src/bin';
import ConfigApi from '../../src/plugins/configApi';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../src/plugins/ldap/groups';
import LdapOrganization from '../../src/plugins/ldap/organization';
import Static from '../../src/plugins/static';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';

describe('ConfigApi Plugin', () => {
  let dm: DM;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  beforeEach(async () => {
    dm = new DM();
    await dm.ready;
  });

  it('should expose configuration endpoint', async () => {
    const configApi = new ConfigApi(dm);
    dm.registerPlugin('configApi', configApi);

    const request = supertest(dm.app);
    const response = await request
      .get('/api/v1/config')
      .set('Accept', 'application/json');

    expect(response.status).to.equal(200);
    expect(response.body).to.have.property('apiPrefix');
    expect(response.body).to.have.property('ldapBase');
    expect(response.body).to.have.property('features');
  });

  it('should include flatResources when ldapFlatGeneric is loaded', async () => {
    // Register ldapFlatGeneric with a test schema
    const schemasPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'static',
      'schemas'
    );

    // Override config to load test schema
    dm.config.ldap_flat_schema = [
      join(schemasPath, 'twake', 'nomenclature', 'twakeDeliveryMode.json'),
    ];

    const flatGeneric = new LdapFlatGeneric(dm);
    dm.registerPlugin('ldapFlatGeneric', flatGeneric);

    const configApi = new ConfigApi(dm);
    dm.registerPlugin('configApi', configApi);

    const request = supertest(dm.app);
    const response = await request
      .get('/api/v1/config')
      .set('Accept', 'application/json');

    expect(response.status).to.equal(200);

    expect(response.body.features.ldapFlatGeneric).to.exist;
    expect(response.body.features.ldapFlatGeneric.flatResources).to.be.an(
      'array'
    );
    expect(
      response.body.features.ldapFlatGeneric.flatResources.length
    ).to.be.greaterThan(0);

    const resource = response.body.features.ldapFlatGeneric.flatResources[0];
    expect(resource).to.have.property('name');
    expect(resource).to.have.property('singularName');
    expect(resource).to.have.property('pluralName');
    expect(resource).to.have.property('mainAttribute');
    expect(resource).to.have.property('objectClass');
    expect(resource).to.have.property('base');
    expect(resource).to.have.property('schema');
    expect(resource).to.have.property('endpoints');
  });

  it('should include groups configuration when ldapGroups is loaded', async function () {
    if (!process.env.DM_LDAP_GROUP_BASE) {
      this.skip();
    }

    const groups = new LdapGroups(dm);
    dm.registerPlugin('ldapGroups', groups);

    const configApi = new ConfigApi(dm);
    dm.registerPlugin('configApi', configApi);

    const request = supertest(dm.app);
    const response = await request
      .get('/api/v1/config')
      .set('Accept', 'application/json');

    expect(response.status).to.equal(200);

    expect(response.body.features.ldapGroups).to.exist;
    expect(response.body.features.ldapGroups.enabled).to.be.true;
    expect(response.body.features.ldapGroups).to.have.property('base');
    expect(response.body.features.ldapGroups).to.have.property('endpoints');
    expect(response.body.features.ldapGroups.endpoints).to.have.property(
      'list'
    );
    expect(response.body.features.ldapGroups.endpoints).to.have.property(
      'addMember'
    );
  });

  it('should include organizations configuration when ldapOrganization is loaded', async function () {
    if (!process.env.DM_LDAP_TOP_ORGANIZATION) {
      this.skip();
    }

    const organizations = new LdapOrganization(dm);
    dm.registerPlugin('ldapOrganizations', organizations);

    const configApi = new ConfigApi(dm);
    dm.registerPlugin('configApi', configApi);

    const request = supertest(dm.app);
    const response = await request
      .get('/api/v1/config')
      .set('Accept', 'application/json');

    expect(response.status).to.equal(200);

    expect(response.body.features.ldapOrganizations).to.exist;
    expect(response.body.features.ldapOrganizations.enabled).to.be.true;
    expect(response.body.features.ldapOrganizations).to.have.property(
      'topOrganization'
    );
    expect(response.body.features.ldapOrganizations).to.have.property(
      'endpoints'
    );
    expect(response.body.features.ldapOrganizations.endpoints).to.have.property(
      'getTop'
    );
    expect(response.body.features.ldapOrganizations.endpoints).to.have.property(
      'getSubnodes'
    );
  });

  it('should include schemaUrl when static plugin is loaded', async () => {
    const schemasPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'static',
      'schemas'
    );

    // Configure static plugin
    dm.config.static_path = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'static'
    );
    dm.config.static_name = 'static';

    // Load static plugin
    const staticPlugin = new Static(dm);
    dm.registerPlugin('static', staticPlugin);

    // Configure ldapFlatGeneric with a test schema
    dm.config.ldap_flat_schema = [
      join(schemasPath, 'twake', 'nomenclature', 'twakeDeliveryMode.json'),
    ];

    const flatGeneric = new LdapFlatGeneric(dm);
    dm.registerPlugin('ldapFlatGeneric', flatGeneric);

    const configApi = new ConfigApi(dm);
    dm.registerPlugin('configApi', configApi);

    const request = supertest(dm.app);
    const response = await request
      .get('/api/v1/config')
      .set('Accept', 'application/json');

    expect(response.status).to.equal(200);

    expect(response.body.features.ldapFlatGeneric).to.exist;
    expect(response.body.features.ldapFlatGeneric.flatResources).to.be.an(
      'array'
    );
    expect(
      response.body.features.ldapFlatGeneric.flatResources.length
    ).to.be.greaterThan(0);

    const resource = response.body.features.ldapFlatGeneric.flatResources[0];
    expect(resource).to.have.property('schemaUrl');
    expect(resource.schemaUrl).to.equal(
      '/static/schemas/twake/nomenclature/twakeDeliveryMode.json'
    );
  });
});
