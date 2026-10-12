import { expect } from 'chai';
import supertest from 'supertest';
import ConfigApi from '../../../src/plugins/configApi';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { DM } from '../../../src/bin';
import ExternalUsersInGroups from '../../../src/plugins/ldap/externalUsersInGroups';
import { SearchResult } from 'ldapts';
import { ConflictError } from '../../../src/lib/errors';
import { waitFor } from '../../helpers/waitFor';

const { DM_LDAP_GROUP_BASE } = process.env;
process.env.DM_GROUP_SCHEMA = '';

describe('External users in groups', function () {
  let server: DM;
  let plugin: LdapGroups;
  let external: ExternalUsersInGroups;
  const user1 = `mail=toto@toto.org,${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;

  before(async () => {
    server = new DM();
    await server.ready;
    plugin = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', plugin);
    external = new ExternalUsersInGroups(server);
    await server.registerPlugin('externalUsersInGroups', external);
  });

  afterEach(async () => {
    try {
      await plugin.deleteGroup('testgroup');
    } catch (e) {
      // ignore
    }
    try {
      await plugin.ldap.delete(user1);
    } catch (e) {
      // ignore
    }
  });

  it('should load externalUsersInGroups', () => {
    expect(plugin.constructor.name).to.equal('LdapGroups');
  });

  it('should surface a ConflictError from creating the external member as a 409, not a 500', async () => {
    // Exercises the catch around `this.ldap.add` in the
    // ldapgroupvalidatemembers hook: when the member creation itself fails
    // with an HttpError (as ldapActions.add does for entryAlreadyExists,
    // code 68 -> ConflictError), that error must reach the caller as-is
    // (409), not get flattened into the plain Error the catch block used to
    // rewrap it into (a 500). Driven deterministically by stubbing
    // `plugin.ldap.add` rather than relying on a real creation race.
    const realAdd = plugin.ldap.add.bind(plugin.ldap);
    (plugin.ldap as any).add = async (dn: string, entry: unknown) => {
      if (dn === user1) {
        const conflict = new ConflictError(`Entry ${dn} already exists`);
        (conflict as { code?: number }).code = 68;
        throw conflict;
      }
      return realAdd(dn, entry as any);
    };

    try {
      await plugin.addGroup('testgroup', [user1]);
      expect.fail('Should reject external member creation conflict');
    } catch (e) {
      expect(e).to.have.property('statusCode', 409);
    } finally {
      (plugin.ldap as any).add = realAdd;
    }
  });

  it('should accept external member in group', async () => {
    await plugin.addGroup('testgroup', [user1]);
    expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
      testgroup: {
        dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
        cn: 'testgroup',
        member: [user1],
      },
    });
    expect(
      ((await plugin.ldap.search({ paged: false }, user1)) as SearchResult)
        .searchEntries[0]
    )
      .to.have.property('mail')
      .that.equals('toto@toto.org');
  });

  describe('Mail domain validation', function () {
    // Configured here rather than read from DM_MAIL_DOMAIN, which nothing
    // sets: the plugin reads mail_domain from the shared config on each call
    const managedDomain = 'managed.example.org';
    const managedUser = `mail=internal@${managedDomain},${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;
    let savedMailDomain: string[] | undefined;

    before(() => {
      savedMailDomain = server.config.mail_domain;
      server.config.mail_domain = [managedDomain];
    });

    after(() => {
      server.config.mail_domain = savedMailDomain;
    });

    afterEach(async () => {
      try {
        await plugin.deleteGroup('testgroup2');
      } catch (e) {
        // ignore
      }
      try {
        await plugin.ldap.delete(managedUser);
      } catch (e) {
        // ignore
      }
    });

    it('should reject a managed domain written in another case', async () => {
      const upper = `mail=internal@${managedDomain.toUpperCase()},${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;
      try {
        await plugin.addGroup('testgroup2', [upper]);
        expect.fail('Should reject managed domain');
      } catch (e) {
        expect((e as Error).message).to.match(
          /Cannot create external user with managed domain/
        );
      }
    });

    it('should reject external member with managed domain', async () => {
      try {
        await plugin.addGroup('testgroup2', [managedUser]);
        expect.fail('Should reject managed domain');
      } catch (e) {
        expect((e as Error).message).to.match(
          /Cannot create external user with managed domain/
        );
      }
    });

    it('should accept external member with non-managed domain', async () => {
      const externalUser = `mail=external@external-domain.org,${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;
      await plugin.addGroup('testgroup2', [externalUser]);
      expect(await plugin.searchGroupsByName('testgroup2')).to.deep.equal({
        testgroup2: {
          dn: `cn=testgroup2,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup2',
          member: [externalUser],
        },
      });
      expect(
        (
          (await plugin.ldap.search(
            { paged: false },
            externalUser
          )) as SearchResult
        ).searchEntries[0]
      )
        .to.have.property('mail')
        .that.equals('external@external-domain.org');

      // Delete user - the hook should automatically remove it from groups
      await plugin.ldap.delete(externalUser);

      // Verify user was removed from group by the hook, which runs once the
      // delete has landed
      await waitFor(
        async () =>
          (await plugin.searchGroupsByName('testgroup2')).testgroup2.member
            .length === 0,
        { what: 'the deleted member to leave the group' }
      );
      expect(await plugin.searchGroupsByName('testgroup2')).to.deep.equal({
        testgroup2: {
          dn: `cn=testgroup2,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup2',
          member: [],
        },
      });
    });
  });

  describe('Member addresses', function () {
    const branch = () => process.env.DM_EXTERNAL_MEMBERS_BRANCH as string;
    const escaped = () => `mail=a\\+b@toto.org,${branch()}`;

    afterEach(async () => {
      await plugin.deleteGroup('testgroup3').catch(() => undefined);
      await plugin.ldap.delete(escaped()).catch(() => undefined);
    });

    it('stores an escaped address unescaped', async () => {
      await plugin.addGroup('testgroup3', [escaped()]);
      expect(
        (
          (await plugin.ldap.search(
            { paged: false },
            escaped()
          )) as SearchResult
        ).searchEntries[0]
      )
        .to.have.property('mail')
        .that.equals('a+b@toto.org');
    });

    it('takes a mail RDN right under the branch, read as a DN', () => {
      expect(external.externalAddress(`mail=x@y.org,${branch()}`)).to.equal(
        'x@y.org'
      );
      expect(
        external.externalAddress(`MAIL=x@y.org, ${branch().toUpperCase()}`)
      ).to.equal('x@y.org');
      expect(
        external.externalAddress(`mail=a\\2bb@y.org,${branch()}`)
      ).to.equal('a+b@y.org');
      for (const other of [
        `cn=x,mail=x@y.org,${branch()}`,
        `uid=x,${branch()}`,
        `mail=x@y.org+cn=x,${branch()}`,
        `mail=x@y.org,${process.env.DM_LDAP_BASE}`,
      ])
        expect(external.externalAddress(other), other).to.be.null;
    });

    it('reads no pattern in the branch', () => {
      const saved = server.config.external_members_branch;
      // `.` would match the `e` of the member's branch as a regex
      server.config.external_members_branch = branch().replace(
        /^ou=external/,
        'ou=.xternal'
      );
      try {
        expect(external.externalAddress(`mail=x@y.org,${branch()}`)).to.be.null;
      } finally {
        server.config.external_members_branch = saved;
      }
    });
  });

  describe('Config API', function () {
    it('publishes the branch, the RDN attribute and the managed domains', async () => {
      const saved = server.config.mail_domain;
      server.config.mail_domain = ['Example.COM'];
      try {
        await server.registerPlugin('configApi', new ConfigApi(server));
        const res = await supertest(server.app)
          .get('/api/v1/config')
          .set('Accept', 'application/json');
        expect(res.status).to.equal(200);
        expect(res.body.features.externalUsersInGroups).to.deep.equal({
          enabled: true,
          branch: process.env.DM_EXTERNAL_MEMBERS_BRANCH,
          rdnAttribute: 'mail',
          managedDomains: ['example.com'],
        });
      } finally {
        server.config.mail_domain = saved;
      }
    });
  });
});
