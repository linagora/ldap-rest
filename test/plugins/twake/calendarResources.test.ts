import nock from 'nock';

import { DM } from '../../../src/bin';
import CalendarResources from '../../../src/plugins/twake/calendarResources';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapFlat from '../../../src/plugins/ldap/flatGeneric';

describe('Calendar Resources Plugin', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_BASE
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping Calendar Resources tests: DM_LDAP_DN or DM_LDAP_PWD or DM_LDAP_BASE not set'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let resourceBase: string;
  let testResourceDN: string;
  let dm: DM;
  let calendarResources: CalendarResources;
  let ldapFlat: LdapFlat;
  let resourceInstance: any; // The resources instance from ldapFlat
  let scope: nock.Scope;

  before(function () {
    nock.disableNetConnect();
  });

  after(function () {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(async function () {
    this.timeout(5000);

    dm = new DM();
    // Add schema path for ldapFlat
    dm.config.ldap_flat_schema = [
      'test/fixtures/calendar-resources-schema.json',
    ];
    // Force ldap_base from env BEFORE ready (in case another test modified process.env)
    dm.config.ldap_base = process.env.DM_LDAP_BASE;
    await dm.ready;

    // Initialize resource paths from env
    resourceBase = `ou=resources,${process.env.DM_LDAP_BASE}`;
    testResourceDN = `cn=Conference Room A,${resourceBase}`;

    // Ensure ou=resources exists BEFORE creating plugins
    try {
      await dm.ldap.add(resourceBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'resources',
      });
    } catch (err) {
      // Ignore if already exists
    }

    calendarResources = new CalendarResources(dm);
    ldapFlat = new LdapFlat(dm);
    resourceInstance = ldapFlat.instances[0];

    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapFlat', ldapFlat);
    await dm.registerPlugin('calendarResources', calendarResources);
  });

  afterEach(async () => {
    // Clean up test data
    try {
      await dm.ldap.delete(testResourceDN);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
  });

  it('should create resource in Calendar when added to LDAP', async () => {
    // Track API calls
    let calendarApiCalled = false;
    const apiScope = nock(
      process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080'
    )
      .post('/resources', body => {
        calendarApiCalled = true;
        expect(body).to.have.property('name', 'Conference Room A');
        expect(body).to.have.property('description', 'Large meeting room');
        return true;
      })
      .reply(201);

    const res = await resourceInstance.addEntry('Conference Room A', {
      description: 'Large meeting room',
    });
    expect(res).to.be.true;

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(calendarApiCalled).to.be.true;

    apiScope.persist(false);
    nock.cleanAll();
  });

  it('should update resource in Calendar when modified in LDAP', async () => {
    // Mock both create and update API calls
    const createScope = nock(
      process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080'
    )
      .post('/resources')
      .reply(201);

    // First create the resource
    await resourceInstance.addEntry('Conference Room A', {
      description: 'Large meeting room',
    });

    // Wait for create hook to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Track update API call
    let calendarApiCalled = false;
    const updateScope = nock(
      process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080'
    )
      .patch('/resources/Conference%20Room%20A', body => {
        calendarApiCalled = true;
        expect(body).to.have.property('description', 'Updated description');
        return true;
      })
      .reply(204);

    // Then modify it
    const res = await resourceInstance.modifyEntry(testResourceDN, {
      replace: { description: 'Updated description' },
    });
    expect(res).to.be.true;

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(calendarApiCalled).to.be.true;

    createScope.persist(false);
    updateScope.persist(false);
    nock.cleanAll();
  });

  it('should delete resource from Calendar when deleted from LDAP', async () => {
    // Mock create API call
    const createScope = nock(
      process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080'
    )
      .post('/resources')
      .reply(201);

    // First create the resource
    await resourceInstance.addEntry('Conference Room A', {
      description: 'Large meeting room',
    });

    // Wait for create hook to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Track delete API call
    let calendarApiCalled = false;
    const deleteScope = nock(
      process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080'
    )
      .delete('/resources/Conference%20Room%20A')
      .reply(function () {
        calendarApiCalled = true;
        return [204];
      });

    // Then delete it
    const res = await resourceInstance.deleteEntry(testResourceDN);
    expect(res).to.be.true;

    // Wait for async hooks to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(calendarApiCalled).to.be.true;

    createScope.persist(false);
    deleteScope.persist(false);
    nock.cleanAll();
  });
});
