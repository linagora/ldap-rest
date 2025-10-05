import { expect } from 'chai';
import { DM } from '../../src/bin';
import ConfigApi from '../../src/plugins/configApi';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../src/plugins/ldap/groups';
import LdapOrganization from '../../src/plugins/ldap/organization';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

describe('ConfigApi Plugin', () => {
  let dm: DM;

  before(function () {
    // Skip tests if env vars are not set
    if (!process.env.DM_LDAP_DN || !process.env.DM_LDAP_PWD) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping ConfigApi tests: DM_LDAP_DN or DM_LDAP_PWD not set'
      );
      (this as Mocha.Context).skip();
    }
  });

  beforeEach(async () => {
    dm = new DM();
    await dm.ready;
    await dm.run();
  });

  afterEach(() => {
    dm.stop();
  });

  it('should expose configuration endpoint', async () => {
    const configApi = new ConfigApi(dm);
    dm.registerPlugin('configApi', configApi);

    const response = await fetch('http://localhost:8081/api/v1/config', {
      headers: { Accept: 'application/json' },
    });

    expect(response.ok).to.be.true;
    const config = await response.json();
    expect(config).to.have.property('apiPrefix');
    expect(config).to.have.property('ldapBase');
    expect(config).to.have.property('features');
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

    const response = await fetch('http://localhost:8081/api/v1/config', {
      headers: { Accept: 'application/json' },
    });

    expect(response.ok).to.be.true;
    const config = await response.json();

    expect(config.features.flatResources).to.be.an('array');
    expect(config.features.flatResources.length).to.be.greaterThan(0);

    const resource = config.features.flatResources[0];
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

    const response = await fetch('http://localhost:8081/api/v1/config', {
      headers: { Accept: 'application/json' },
    });

    expect(response.ok).to.be.true;
    const config = await response.json();

    expect(config.features.groups).to.exist;
    expect(config.features.groups.enabled).to.be.true;
    expect(config.features.groups).to.have.property('base');
    expect(config.features.groups).to.have.property('endpoints');
    expect(config.features.groups.endpoints).to.have.property('list');
    expect(config.features.groups.endpoints).to.have.property('addMember');
  });

  it('should include organizations configuration when ldapOrganization is loaded', async function () {
    if (!process.env.DM_LDAP_TOP_ORGANIZATION) {
      this.skip();
    }

    const organizations = new LdapOrganization(dm);
    dm.registerPlugin('ldapOrganizations', organizations);

    const configApi = new ConfigApi(dm);
    dm.registerPlugin('configApi', configApi);

    const response = await fetch('http://localhost:8081/api/v1/config', {
      headers: { Accept: 'application/json' },
    });

    expect(response.ok).to.be.true;
    const config = await response.json();

    expect(config.features.organizations).to.exist;
    expect(config.features.organizations.enabled).to.be.true;
    expect(config.features.organizations).to.have.property('topOrganization');
    expect(config.features.organizations).to.have.property('endpoints');
    expect(config.features.organizations.endpoints).to.have.property('getTop');
    expect(config.features.organizations.endpoints).to.have.property(
      'getSubnodes'
    );
  });
});
