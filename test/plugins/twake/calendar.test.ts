import nock from 'nock';

import { DM } from '../../../src/bin';
import Calendar from '../../../src/plugins/twake/calendar';
import CalendarResources from '../../../src/plugins/twake/calendarResources';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapFlat from '../../../src/plugins/ldap/flatGeneric';

import { waitFor } from '../../helpers/waitFor';
describe('Twake Calendar Plugin', function () {
  let resourceBase: string;
  let testResourceDN: string;
  let dm: DM;
  let calendar: Calendar;
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

    calendar = new Calendar(dm);
    ldapFlat = new LdapFlat(dm);
    resourceInstance = ldapFlat.instances[0];

    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapFlat', ldapFlat);
    await dm.registerPlugin('calendar', calendar);
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
    await waitFor(() => calendarApiCalled);

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
    await new Promise(resolve => setTimeout(resolve, 50));

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
    await waitFor(() => calendarApiCalled);

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
    await new Promise(resolve => setTimeout(resolve, 50));

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
    await waitFor(() => calendarApiCalled);

    expect(calendarApiCalled).to.be.true;

    createScope.persist(false);
    deleteScope.persist(false);
    nock.cleanAll();
  });

  it('should ignore entries outside the resources branch', async () => {
    const apiScope = nock(
      process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080'
    )
      .post('/resources')
      .reply(201);

    await calendar.hooks.ldapcalendarResourceadddone!([
      `cn=Conference Room A,ou=elsewhere,${process.env.DM_LDAP_BASE}`,
      { cn: 'Conference Room A', description: 'Large meeting room' },
    ]);

    expect(apiScope.isDone()).to.be.false;
    nock.cleanAll();
  });

  // What makes an entry a calendar resource, and what the resource is called
  // in Calendar. The hooks are called directly: the point is what the plugin
  // does with a DN, not what the directory does with an entry.
  describe('resource identification', () => {
    const calendarUrl =
      process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080';

    // A plugin whose resource base is the one given, to exercise a base other
    // than the one the test environment configures
    const calendarWithBase = (base: string): Calendar => {
      dm.config.calendar_resource_base = base;
      return new Calendar(dm);
    };

    afterEach(() => {
      dm.config.calendar_resource_base = process.env.DM_CALENDAR_RESOURCE_BASE;
    });

    it('does not take a sibling branch whose name starts with the base for the resource branch', async () => {
      const apiScope = nock(calendarUrl).post('/resources').reply(201);

      await calendar.hooks.ldapcalendarResourceadddone!([
        `cn=Conference Room A,ou=resourcesArchive,${process.env.DM_LDAP_BASE}`,
        { cn: 'Conference Room A', description: 'Archived room' },
      ]);

      expect(apiScope.isDone()).to.be.false;
      nock.cleanAll();
    });

    it('does not take a sibling branch for the resource branch when the base is given without the directory suffix', async () => {
      // `ou=resourcesArchive,…` contains the `ou=resources` text, which is
      // what a substring test looked for
      const partial = calendarWithBase('ou=resources');
      const apiScope = nock(calendarUrl).post('/resources').reply(201);

      await partial.hooks.ldapcalendarResourceadddone!([
        `cn=Conference Room A,ou=resourcesArchive,${process.env.DM_LDAP_BASE}`,
        { cn: 'Conference Room A', description: 'Archived room' },
      ]);

      expect(apiScope.isDone()).to.be.false;
      nock.cleanAll();
    });

    it('recognises a resource whose DN is written with spaces after the commas', async () => {
      let createdName: unknown = null;
      const apiScope = nock(calendarUrl)
        .post('/resources', body => {
          createdName = (body as { name?: unknown }).name;
          return true;
        })
        .reply(201);

      await calendar.hooks.ldapcalendarResourceadddone!([
        `cn=Conference Room A, ou=resources, ${process.env.DM_LDAP_BASE}`,
        { cn: 'Conference Room A', description: 'Large meeting room' },
      ]);

      expect(apiScope.isDone()).to.be.true;
      expect(createdName).to.equal('Conference Room A');
      nock.cleanAll();
    });

    it('does not PATCH Calendar when the modified entry is outside the resource base', async () => {
      const apiScope = nock(calendarUrl)
        .patch(/^\/resources\//)
        .reply(204);

      await calendar.hooks.ldapcalendarResourcemodifydone!([
        `cn=Conference Room A,ou=elsewhere,${process.env.DM_LDAP_BASE}`,
        { replace: { description: 'Updated description' } },
        1,
      ]);

      expect(apiScope.isDone()).to.be.false;
      nock.cleanAll();
    });

    it('does not DELETE from Calendar when the deleted entry is outside the resource base', async () => {
      const apiScope = nock(calendarUrl)
        .delete(/^\/resources\//)
        .reply(204);

      await calendar.hooks.ldapcalendarResourcedeletedone!(
        `cn=Conference Room A,ou=elsewhere,${process.env.DM_LDAP_BASE}`
      );

      expect(apiScope.isDone()).to.be.false;
      nock.cleanAll();
    });

    it('keeps an id carrying a slash in one path segment', async () => {
      let patchPath = '';
      const apiScope = nock(calendarUrl)
        .patch(/^\/resources\//)
        .reply(function (uri) {
          patchPath = uri;
          return [204];
        });

      await calendar.hooks.ldapcalendarResourcemodifydone!([
        `cn=Salle A/B,ou=resources,${process.env.DM_LDAP_BASE}`,
        { replace: { description: 'Updated description' } },
        1,
      ]);

      expect(apiScope.isDone()).to.be.true;
      expect(patchPath).to.equal('/resources/Salle%20A%2FB');
      nock.cleanAll();
    });

    it('reads the whole value of an RDN carrying an escaped comma', async () => {
      let deletePath = '';
      const apiScope = nock(calendarUrl)
        .delete(/^\/resources\//)
        .reply(function (uri) {
          deletePath = uri;
          return [204];
        });

      await calendar.hooks.ldapcalendarResourcedeletedone!(
        `cn=Salle\\, 2,ou=resources,${process.env.DM_LDAP_BASE}`
      );

      expect(apiScope.isDone()).to.be.true;
      expect(decodeURIComponent(deletePath)).to.equal('/resources/Salle, 2');
      nock.cleanAll();
    });

    it('does not borrow an ancestor id when the RDN is neither cn nor uid', async () => {
      let patchPath = '';
      const apiScope = nock(calendarUrl)
        .patch(/^\/resources\//)
        .reply(function (uri) {
          patchPath = uri;
          return [204];
        });

      // cn=zone is the parent's RDN, not this entry's
      await calendar.hooks.ldapcalendarResourcemodifydone!([
        `o=Room 12,cn=zone,ou=resources,${process.env.DM_LDAP_BASE}`,
        { replace: { description: 'Updated description' } },
        1,
      ]);

      expect(patchPath).to.not.equal('/resources/zone');
      expect(decodeURIComponent(patchPath)).to.equal('/resources/Room 12');
      apiScope.done();
      nock.cleanAll();
    });

    it('derives the same id in the add, modify and delete hooks', async () => {
      const dn = `o=Room 12,ou=resources,${process.env.DM_LDAP_BASE}`;
      let createdId: unknown = null;
      let patchPath = '';
      let deletePath = '';
      const apiScope = nock(calendarUrl)
        .post('/resources', body => {
          createdId = (body as { id?: unknown }).id;
          return true;
        })
        .reply(201)
        .patch(/^\/resources\//)
        .reply(function (uri) {
          patchPath = uri;
          return [204];
        })
        .delete(/^\/resources\//)
        .reply(function (uri) {
          deletePath = uri;
          return [204];
        });

      // The name is not the RDN value, so an id derived from one is not the
      // id derived from the other
      await calendar.hooks.ldapcalendarResourceadddone!([
        dn,
        { cn: 'Salle Rouge', description: 'Large meeting room' },
      ]);
      await calendar.hooks.ldapcalendarResourcemodifydone!([
        dn,
        { replace: { description: 'Updated description' } },
        1,
      ]);
      await calendar.hooks.ldapcalendarResourcedeletedone!(dn);

      expect(apiScope.isDone()).to.be.true;
      expect(patchPath).to.equal(
        `/resources/${encodeURIComponent(String(createdId))}`
      );
      expect(deletePath).to.equal(
        `/resources/${encodeURIComponent(String(createdId))}`
      );
      nock.cleanAll();
    });
  });

  describe('calendarResources alias', () => {
    it('is the same plugin, still registered under its historical name', () => {
      const alias = new CalendarResources(dm);

      expect(alias).to.be.instanceOf(Calendar);
      expect(alias.name).to.equal('calendarResources');
      expect(calendar.name).to.equal('calendar');
    });
  });

  describe('deleteUserData', () => {
    // The address goes out as it is written — `@` is legal in a path
    // segment, so nothing encodes it — which is what the plugin does
    // deliberately, see the comment on `deleteUserData` (issue #175)
    it('should call POST /users/{mail}?action=deleteData and return taskId', async () => {
      const deleteDataScope = nock(
        process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080'
      )
        .post('/users/user@test.org?action=deleteData')
        .reply(201, { taskId: 'calendar-task-123' });

      const result = await calendar.deleteUserData('user@test.org');

      expect(result).to.deep.equal({ taskId: 'calendar-task-123' });
      expect(deleteDataScope.isDone()).to.be.true;

      nock.cleanAll();
    });

    it('should return null and log error on non-OK response', async () => {
      const deleteDataScope = nock(
        process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080'
      )
        .post('/users/baduser@test.org?action=deleteData')
        .reply(400, { error: 'Bad request' });

      const result = await calendar.deleteUserData('baduser@test.org');

      expect(result).to.be.null;
      expect(deleteDataScope.isDone()).to.be.true;

      nock.cleanAll();
    });
  });

  describe('registered users sync', () => {
    let userDN: string;
    const calendarUrl =
      process.env.DM_CALENDAR_WEBADMIN_URL || 'http://localhost:8080';

    beforeEach(async () => {
      userDN = `uid=caluser,${process.env.DM_LDAP_BASE}`;
      try {
        await dm.ldap.add(userDN, {
          objectClass: ['inetOrgPerson', 'top'],
          uid: 'caluser',
          cn: 'Benoit TELLIER',
          givenName: 'Benoit',
          sn: 'TELLIER',
          mail: 'caluser@test.org',
        });
      } catch (err) {
        // Ignore if already exists
      }
      // Creating the entry fires onLdapChange with the mail attribute present,
      // which the plugin treats as an addition and skips — so no stray
      // /registeredUsers call races with the interceptors set up below.
    });

    afterEach(async () => {
      try {
        await dm.ldap.delete(userDN);
      } catch (err) {
        // Ignore if it does not exist
      }
      nock.cleanAll();
    });

    it('looks the user up by email and PATCHes it', async () => {
      let patchBody: Record<string, unknown> | null = null;
      let patchUri = '';
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'caluser@test.org' })
        .reply(200, {
          id: '5f50a663',
          email: 'caluser@test.org',
          firstname: 'Old',
          lastname: 'Name',
        })
        .patch('/registeredUsers', body => {
          patchBody = body as Record<string, unknown>;
          return true;
        })
        .query(true)
        .reply(function (uri) {
          patchUri = uri;
          return [204];
        });

      await calendar.syncRegisteredUser('test', userDN);

      expect(scope.isDone()).to.be.true;
      expect(patchUri).to.contain('id=5f50a663');
      expect(patchBody).to.deep.equal({
        email: 'caluser@test.org',
        firstname: 'Benoit',
        lastname: 'TELLIER',
      });
    });

    it('looks up by the OLD email on mail change and PATCHes the new email', async () => {
      let patchBody: Record<string, unknown> | null = null;
      let patchUri = '';
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'old@test.org' })
        .reply(200, {
          id: 'abc123',
          email: 'old@test.org',
          firstname: 'Benoit',
          lastname: 'TELLIER',
        })
        .patch('/registeredUsers', body => {
          patchBody = body as Record<string, unknown>;
          return true;
        })
        .query(true)
        .reply(function (uri) {
          patchUri = uri;
          return [204];
        });

      // LDAP now holds caluser@test.org; Calendar still has old@test.org
      await calendar.hooks.onLdapChange!(userDN, {
        mail: ['old@test.org', 'caluser@test.org'],
      });

      expect(scope.isDone()).to.be.true;
      expect(patchUri).to.contain('id=abc123');
      expect(patchBody).to.deep.equal({
        email: 'caluser@test.org',
        firstname: 'Benoit',
        lastname: 'TELLIER',
      });
    });

    it('does not PATCH when the user is not registered in Calendar', async () => {
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'caluser@test.org' })
        .reply(404, { message: 'User does not exist' });
      const patch = nock(calendarUrl)
        .patch('/registeredUsers')
        .query(true)
        .reply(204);

      await calendar.syncRegisteredUser('test', userDN);

      expect(scope.isDone()).to.be.true;
      expect(patch.isDone()).to.be.false;
    });

    it('stops on a lookup error, without PATCHing', async () => {
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'old@test.org' })
        .reply(500);
      const patch = nock(calendarUrl)
        .patch('/registeredUsers')
        .query(true)
        .reply(204);

      await calendar.hooks.onLdapChange!(userDN, {
        mail: ['old@test.org', 'caluser@test.org'],
      });

      expect(scope.isDone()).to.be.true;
      expect(patch.isDone()).to.be.false;
    });

    it('does not PATCH when the answer is not JSON, and says which lookup failed', async () => {
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'caluser@test.org' })
        .reply(200, '<html>Bad gateway</html>');
      const patch = nock(calendarUrl)
        .patch('/registeredUsers')
        .query(true)
        .reply(204);
      const errors: Record<string, unknown>[] = [];
      const logger = calendar.logger;
      const originalError = logger.error.bind(logger);
      logger.error = ((entry: Record<string, unknown>) => {
        errors.push(entry);
        return logger;
      }) as typeof logger.error;

      try {
        await calendar.syncRegisteredUser('test', userDN);
      } finally {
        logger.error = originalError;
      }

      expect(scope.isDone()).to.be.true;
      expect(patch.isDone()).to.be.false;
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include({
        step: 'find_registered_user',
        searchEmail: 'caluser@test.org',
        http_status: 200,
      });
    });

    it('does not PATCH when the answer has no id', async () => {
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'caluser@test.org' })
        .reply(200, { message: 'User does not exist' });
      const patch = nock(calendarUrl)
        .patch('/registeredUsers')
        .query(true)
        .reply(204);

      await calendar.syncRegisteredUser('test', userDN);

      expect(scope.isDone()).to.be.true;
      expect(patch.isDone()).to.be.false;
    });

    it('picks the user from the full list on Calendar before 1.0.0.1', async () => {
      // Older releases ignore ?email= and answer every registered user
      let patchUri = '';
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'caluser@test.org' })
        .reply(200, [
          { id: 'other', email: 'someoneelse@test.org' },
          { id: 'legacy1', email: 'CalUser@test.org' },
        ])
        .patch('/registeredUsers')
        .query(true)
        .reply(function (uri) {
          patchUri = uri;
          return [204];
        });

      await calendar.syncRegisteredUser('test', userDN);

      expect(scope.isDone()).to.be.true;
      expect(patchUri).to.contain('id=legacy1');
    });

    it('does not PATCH when the user is missing from the full list', async () => {
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'caluser@test.org' })
        .reply(200, [{ id: 'other', email: 'someoneelse@test.org' }]);
      const patch = nock(calendarUrl)
        .patch('/registeredUsers')
        .query(true)
        .reply(204);

      await calendar.syncRegisteredUser('test', userDN);

      expect(scope.isDone()).to.be.true;
      expect(patch.isDone()).to.be.false;
    });

    it('skips sync when the mail is added (no previous mail)', async () => {
      // An unmocked request would not do: syncRegisteredUser catches the
      // error nock throws. The interceptor stays pending only if no call
      // was made.
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query(true)
        .reply(200, []);

      await calendar.hooks.onLdapChange!(userDN, {
        mail: [null, 'caluser@test.org'],
      });

      expect(scope.isDone()).to.be.false;
    });

    it('syncs names when a configured name attribute changes', async () => {
      let patchBody: Record<string, unknown> | null = null;
      let patchUri = '';
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query({ email: 'caluser@test.org' })
        .reply(200, {
          id: 'nm1',
          email: 'caluser@test.org',
          firstname: 'Old',
          lastname: 'Name',
        })
        .patch('/registeredUsers', body => {
          patchBody = body as Record<string, unknown>;
          return true;
        })
        .query(true)
        .reply(function (uri) {
          patchUri = uri;
          return [204];
        });

      // sn is the default configured lastname attribute
      await calendar.hooks.onLdapChange!(userDN, {
        sn: ['Name', 'TELLIER'],
      });

      expect(scope.isDone()).to.be.true;
      expect(patchUri).to.contain('id=nm1');
      expect(patchBody).to.deep.equal({
        email: 'caluser@test.org',
        firstname: 'Benoit',
        lastname: 'TELLIER',
      });
    });

    it('ignores changes to unrelated attributes', async () => {
      // See 'skips sync when the mail is added' for why an interceptor
      const scope = nock(calendarUrl)
        .get('/registeredUsers')
        .query(true)
        .reply(200, []);

      await calendar.hooks.onLdapChange!(userDN, {
        description: ['before', 'after'],
      });

      expect(scope.isDone()).to.be.false;
    });
  });
});
