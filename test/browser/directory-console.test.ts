/**
 * Tests for the directory console.
 *
 * The components write into `container.innerHTML` and then look their controls
 * up on the container, so a stub element exercises the whole markup path
 * without a DOM implementation — the same approach the other browser suites
 * take.
 */
import { expect } from 'chai';
import nock from 'nock';

import { ConsoleApiClient } from '../../src/browser/directory-console/api/ConsoleApiClient';
import { readFailure } from '../../src/browser/directory-console/DirectoryConsole';
import {
  attributeLabel,
  rdnValue,
  resolveText,
} from '../../src/browser/directory-console/format';
import { EntityDetail } from '../../src/browser/directory-console/components/EntityDetail';
import { EntityForm } from '../../src/browser/directory-console/components/EntityForm';
import {
  EntityList,
  csvCell,
} from '../../src/browser/directory-console/components/EntityList';
import { Translator } from '../../src/browser/directory-console/i18n';
import { formatByteSize } from '../../src/browser/directory-console/format';
import { parseByteSize } from '../../src/plugins/ldap/enterpriseRules';
import type {
  EntityDescriptor,
  EntitySchema,
  Entry,
} from '../../src/browser/directory-console/types';

const baseUrl = 'http://localhost:8099';

/** Minimal stand-in for the element a component renders into. */
function stubContainer(): HTMLElement & { innerHTML: string } {
  return {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLElement & { innerHTML: string };
}

const usersSchema: EntitySchema = {
  attributes: {
    objectClass: { type: 'array', fixed: true, default: ['top'] },
    uid: {
      type: 'string',
      role: 'identifier',
      required: true,
      generated: true,
      generatedFrom: { attribute: 'mail', extract: '^([^@]+)@' },
    },
    cn: {
      type: 'string',
      role: 'displayName',
      required: true,
      label: { en: 'Name', fr: 'Nom' },
    },
    mail: {
      type: 'string',
      role: 'primaryEmail',
      required: true,
      test: '^[^@\\s]+@[^@\\s]+$',
      hint: 'Expected an email address',
    },
    mailAlternateAddress: {
      type: 'array',
      role: 'emailAliases',
      items: { type: 'string' },
    },
    telephoneNumber: {
      type: 'string',
      test: '^\\d{3} \\d{4}$',
      hint: 'Expected pattern 999 9999',
    },
    userPassword: { type: 'string', role: 'password', neverReturn: true },
    memberOf: { type: 'array', readOnly: true, items: { type: 'string' } },
    twakeDepartmentLink: {
      type: 'pointer',
      role: 'organizationLink',
      required: true,
      branch: ['dc=example,dc=com'],
    },
    twakeDepartmentPath: {
      type: 'string',
      role: 'organizationPath',
      generated: true,
    },
    twakeAccountStatus: {
      type: 'pointer',
      role: 'accountStatus',
      generated: true,
      states: { enabled: 'cn=active', disabled: 'cn=disabled' },
    },
  },
};

const users: EntityDescriptor = {
  key: 'users',
  pluralName: 'users',
  singularName: 'user',
  mainAttribute: 'uid',
  base: 'ou=users,dc=example,dc=com',
  schema: usersSchema,
  endpoint: '/api/v1/ldap/users',
  kind: 'flat',
  organizationLink: 'twakeDepartmentLink',
  organizationPath: 'twakeDepartmentPath',
  accountStatus: 'twakeAccountStatus',
  password: 'userPassword',
};

const groups: EntityDescriptor = {
  key: 'groups',
  pluralName: 'groups',
  singularName: 'group',
  mainAttribute: 'cn',
  base: 'ou=groups,dc=example,dc=com',
  schema: {
    attributes: {
      cn: { type: 'string', role: 'identifier', required: true },
      description: { type: 'string' },
      member: { type: 'array', role: 'members', items: { type: 'string' } },
    },
  },
  endpoint: '/api/v1/ldap/groups',
  kind: 'group',
};

/** A group as the directory holds it, before the form edits it. */
const staff: Entry = {
  dn: 'cn=staff,ou=groups,dc=example,dc=com',
  cn: 'staff',
  description: 'Staff',
  member: [
    'uid=alice,ou=users,dc=example,dc=com',
    'uid=bob,ou=users,dc=example,dc=com',
  ],
};

describe('Directory console', () => {
  afterEach(() => nock.cleanAll());

  describe('Translator', () => {
    it('should fall back to English for an unknown language', () => {
      expect(new Translator('xx').language).to.equal('en');
    });

    it('should read a region tag as its language', () => {
      expect(new Translator('fr-CA').language).to.equal('fr');
    });

    it('should substitute placeholders', () => {
      const t = new Translator('en');
      expect(t.t('list.count', { from: 1, to: 10, total: 42 })).to.equal(
        '1–10 of 42'
      );
    });

    it('should show an untranslated key rather than nothing', () => {
      expect(new Translator('en').t('no.such.key')).to.equal('no.such.key');
    });

    it('should translate every key of every catalogue', () => {
      const english = new Translator('en');
      const french = new Translator('fr');
      // A key present in one catalogue and missing from the other is exactly
      // the mixed-language interface this replaces.
      expect(french.t('list.perPage')).to.not.equal('list.perPage');
      expect(english.t('list.perPage')).to.not.equal('list.perPage');
    });
  });

  describe('localized text', () => {
    it('should take a plain string as the text itself', () => {
      expect(resolveText('Department', 'fr')).to.equal('Department');
    });

    it('should pick the language, then its base tag, then English', () => {
      const label = { en: 'Department', fr: 'Organisation' };
      expect(resolveText(label, 'fr')).to.equal('Organisation');
      expect(resolveText(label, 'fr-CA')).to.equal('Organisation');
      expect(resolveText(label, 'de')).to.equal('Department');
    });

    it('should show something rather than nothing for a partial schema', () => {
      // A schema translated into one language the reader does not speak is
      // still more useful than a blank label.
      expect(resolveText({ nl: 'Afdeling' }, 'fr')).to.equal('Afdeling');
    });

    it('should treat an absent or empty text as absent', () => {
      expect(resolveText(undefined, 'en')).to.be.undefined;
      expect(resolveText('', 'en')).to.be.undefined;
      expect(resolveText({}, 'en')).to.be.undefined;
    });

    it('should name an attribute in the reader’s language', () => {
      const attr = usersSchema.attributes.cn;
      expect(attributeLabel('cn', attr, 'fr')).to.equal('Nom');
      expect(attributeLabel('cn', attr, 'en')).to.equal('Name');
    });

    it('should make an unlabelled attribute readable rather than raw', () => {
      expect(
        attributeLabel('twakeDepartmentPath', { type: 'string' }, 'fr')
      ).to.equal('Twake Department Path');
    });
  });

  describe('reading a DN', () => {
    it('should read the value of the first RDN, escapes undone', () => {
      expect(rdnValue('uid=jsmith,ou=users,dc=example,dc=com')).to.equal(
        'jsmith'
      );
      // The comma inside a value is escaped, so the first comma of the DN is
      // not always the end of the first RDN: splitting on it navigated to
      // `Smith\` and the console answered "This entry no longer exists".
      expect(
        rdnValue('cn=Smith\\, John,ou=positions,dc=example,dc=com')
      ).to.equal('Smith, John');
      expect(rdnValue('not a dn')).to.equal('not a dn');
    });
  });

  describe('reading a failed read', () => {
    it('should say the entry is gone only when it is', () => {
      const translator = new Translator('en');
      const gone = Object.assign(new Error('Not found'), { status: 404 });
      expect(readFailure(gone, translator)).to.deep.equal({
        gone: true,
        message: 'This entry no longer exists',
      });
    });

    it('should show what a refusal said, not that the entry is gone', () => {
      // Telling the operator an entry no longer exists when they were in fact
      // refused sends them looking for the wrong problem. The organization
      // card said it for every failure; the entry card never did.
      const translator = new Translator('en');
      const refused = Object.assign(new Error('Out of your scope'), {
        status: 403,
      });
      expect(readFailure(refused, translator)).to.deep.equal({
        gone: false,
        message: 'Out of your scope',
      });
    });
  });

  describe('ConsoleApiClient', () => {
    it('should turn the server configuration into entities', async () => {
      nock(baseUrl)
        .get('/api/v1/config')
        .reply(200, {
          apiPrefix: '/api',
          ldapBase: 'dc=example,dc=com',
          features: {
            ldapFlatGeneric: {
              flatResources: [
                {
                  name: 'twakeUser',
                  singularName: 'user',
                  pluralName: 'users',
                  mainAttribute: 'uid',
                  base: 'ou=users,dc=example,dc=com',
                  schema: usersSchema,
                },
              ],
            },
            ldapGroups: {
              enabled: true,
              base: 'ou=groups,dc=example,dc=com',
              mainAttribute: 'cn',
              schema: { attributes: { cn: { type: 'string' } } },
            },
            ldapOrganizations: {
              enabled: true,
              topOrganization: 'ou=organization,dc=example,dc=com',
              pathSeparator: ' / ',
              schema: {
                attributes: {
                  ou: { type: 'string', role: 'identifier' },
                  twakeDepartmentPath: {
                    type: 'string',
                    role: 'organizationPath',
                  },
                },
              },
            },
          },
        });

      const client = new ConsoleApiClient(baseUrl);
      const entities = await client.discover();

      expect(entities.map(entity => entity.key)).to.deep.equal([
        'users',
        'groups',
        'organizations',
      ]);
      const user = entities[0];
      // The console never learns an attribute name: it asks for the role.
      expect(user.organizationLink).to.equal('twakeDepartmentLink');
      expect(user.accountStatus).to.equal('twakeAccountStatus');
      expect(user.password).to.equal('userPassword');
      expect(client.organizationPathSeparator).to.equal(' / ');
      expect(client.organizationRoot).to.equal(
        'ou=organization,dc=example,dc=com'
      );
    });

    it('should take an entity’s own names from its schema metadata', async () => {
      nock(baseUrl)
        .get('/api/v1/config')
        .reply(200, {
          apiPrefix: '/api',
          ldapBase: 'dc=example,dc=com',
          features: {
            ldapGroups: {
              enabled: true,
              base: 'ou=groups,dc=example,dc=com',
              mainAttribute: 'cn',
              schema: {
                entity: {
                  label: { en: 'Groups', fr: 'Groupes' },
                  singularLabel: { en: 'group', fr: 'groupe' },
                },
                attributes: { cn: { type: 'string' } },
              },
            },
          },
        });
      const [groups] = await new ConsoleApiClient(baseUrl).discover();
      expect(resolveText(groups.label, 'fr')).to.equal('Groupes');
      expect(resolveText(groups.singularLabel, 'fr')).to.equal('groupe');
    });

    it('should ignore an entity whose schema the server did not serve', async () => {
      nock(baseUrl)
        .get('/api/v1/config')
        .reply(200, {
          apiPrefix: '/api',
          ldapBase: 'dc=example,dc=com',
          features: { ldapGroups: { enabled: true, base: 'ou=groups' } },
        });
      expect(await new ConsoleApiClient(baseUrl).discover()).to.deep.equal([]);
    });

    it('should report the server’s own refusal, not a generic failure', async () => {
      nock(baseUrl)
        .post('/api/v1/ldap/users')
        .reply(409, { error: 'This email address is already used' });

      const client = new ConsoleApiClient(baseUrl);
      try {
        await client.create(users, { mail: 'taken@example.com' });
        expect.fail('the creation should have been refused');
      } catch (err) {
        expect((err as Error).message).to.equal(
          'This email address is already used'
        );
        expect((err as Error & { status: number }).status).to.equal(409);
      }
    });

    it('should search on the chosen attribute', async () => {
      nock(baseUrl)
        .get('/api/v1/ldap/users')
        .query({ match: 'smith', attribute: 'cn' })
        .reply(200, { jsmith: { dn: 'uid=jsmith', uid: 'jsmith' } });

      const result = await new ConsoleApiClient(baseUrl).list(
        users,
        'smith',
        'cn'
      );
      expect(result).to.have.property('jsmith');
    });

    it('should send only what changed, and what was cleared', async () => {
      let body: unknown;
      nock(baseUrl)
        .put('/api/v1/ldap/users/jsmith', received => {
          body = received;
          return true;
        })
        .reply(200, { success: true });

      await new ConsoleApiClient(baseUrl).update(
        users,
        'jsmith',
        { cn: 'John Smith' },
        ['telephoneNumber']
      );
      expect(body).to.deep.equal({
        replace: { cn: 'John Smith' },
        delete: ['telephoneNumber'],
      });
    });

    it('should not issue an empty update', async () => {
      // No interceptor: a request here would fail the test.
      await new ConsoleApiClient(baseUrl).update(users, 'jsmith', {}, []);
    });

    it('should ask an organization for its child organizations only', async () => {
      // `subnodes` answers with the child OUs *and* the entries linked to the
      // node — up to fifty accounts, plus a `moreIndicator` row counting the
      // rest. Unfiltered, all of that was drawn as organizations: a member
      // clicked in the tree answered "no longer exists", and the department
      // select of every form offered user DNs as candidate organizations.
      const dn = 'ou=Sales,ou=organization,dc=example,dc=com';
      nock(baseUrl)
        .get(`/api/v1/ldap/organizations/${encodeURIComponent(dn)}/subnodes`)
        .query({ objectClass: 'organizationalUnit' })
        .reply(200, [
          {
            dn: `ou=EU,${dn}`,
            ou: ['EU'],
            twakeDepartmentPath: ['Sales / EU'],
          },
        ]);

      const children = await new ConsoleApiClient(baseUrl).organizationChildren(
        dn
      );
      expect(children.map(node => node.name)).to.deep.equal(['EU']);
    });

    it('should not offer the truncation row as a member', async () => {
      // Past `ldap_organization_max_subnodes` the endpoint appends a row that
      // is not an entry: its DN is `more-` plus the organization's own, and
      // nothing answers there. Listed among the members it read as a colleague
      // named after the department, and opening it went nowhere.
      const dn = 'ou=Sales,ou=organization,dc=example,dc=com';
      nock(baseUrl)
        .get(`/api/v1/ldap/organizations/${encodeURIComponent(dn)}/subnodes`)
        .reply(200, [
          {
            dn: `ou=EU,${dn}`,
            ou: ['EU'],
            objectClass: ['organizationalUnit'],
          },
          {
            dn: `uid=jsmith,ou=users,dc=example,dc=com`,
            objectClass: ['inetOrgPerson'],
          },
          {
            dn: `more-${dn}`,
            objectClass: ['moreIndicator'],
            _isMoreIndicator: 'true',
            _totalCount: '312',
          },
        ]);

      const members = await new ConsoleApiClient(baseUrl).organizationMembers(
        dn
      );
      expect(members.map(member => member.label)).to.deep.equal(['jsmith']);
    });

    it('should read the configuration at the prefix it was given', async () => {
      // Every other call uses the prefix the configuration advertises. The
      // call that reads the configuration has nothing to read it from, so a
      // server behind `--api-prefix /ldap` has to be told once.
      nock(baseUrl).get('/ldap/v1/config').reply(200, {
        apiPrefix: '/ldap',
        ldapBase: 'dc=example,dc=com',
        features: {},
      });
      expect(
        await new ConsoleApiClient(baseUrl, '/ldap').discover()
      ).to.deep.equal([]);
    });

    it('should not turn a membership edit into a request the server refuses', async () => {
      // `modifyGroup` answers `Use dedicated API to replace members` to
      // `replace.member`, and the same to `delete: ['member']`: every
      // membership edit made from the form came back as a 500. The form edits
      // the list, as it should; what the server takes is who joined and who
      // left, through the endpoints it keeps for them.
      let modified: unknown;
      let joined: unknown;
      // The interceptors are the assertion: the DELETE names the member that
      // left, and a request nobody declared reaches nothing and fails.
      const scope = nock(baseUrl)
        .put('/api/v1/ldap/groups/staff', received => {
          modified = received;
          return true;
        })
        .reply(200, { success: true })
        .post('/api/v1/ldap/groups/staff/members', received => {
          joined = received;
          return true;
        })
        .reply(200, { success: true })
        .delete(
          '/api/v1/ldap/groups/staff/members/' +
            encodeURIComponent('uid=bob,ou=users,dc=example,dc=com')
        )
        .reply(200, { success: true });

      await new ConsoleApiClient(baseUrl).update(
        groups,
        'staff',
        {
          description: 'All staff',
          member: [
            'uid=alice,ou=users,dc=example,dc=com',
            'uid=carol,ou=users,dc=example,dc=com',
          ],
        },
        [],
        staff
      );

      expect(modified).to.deep.equal({ replace: { description: 'All staff' } });
      expect(joined).to.deep.equal({
        member: ['uid=carol,ou=users,dc=example,dc=com'],
      });
      expect(scope.isDone()).to.be.true;
    });

    it('should empty a membership through the endpoint that takes it', async () => {
      // Clearing the field is `delete: ['member']`, refused just the same.
      // Nothing else was edited, so there is no modify request left to make:
      // an interceptor is declared for the two departures only, and a PUT
      // here would fail the test.
      const scope = nock(baseUrl)
        .delete(
          '/api/v1/ldap/groups/staff/members/' +
            encodeURIComponent('uid=alice,ou=users,dc=example,dc=com')
        )
        .reply(200, { success: true })
        .delete(
          '/api/v1/ldap/groups/staff/members/' +
            encodeURIComponent('uid=bob,ou=users,dc=example,dc=com')
        )
        .reply(200, { success: true });

      await new ConsoleApiClient(baseUrl).update(
        groups,
        'staff',
        {},
        ['member'],
        staff
      );
      expect(scope.isDone()).to.be.true;
    });

    it('should leave an entity that is not a group alone', async () => {
      // The dedicated endpoints are the group plugin's; an attribute named
      // `member` on a flat entity is an attribute like any other.
      let body: unknown;
      nock(baseUrl)
        .put('/api/v1/ldap/users/jsmith', received => {
          body = received;
          return true;
        })
        .reply(200, { success: true });
      await new ConsoleApiClient(baseUrl).update(users, 'jsmith', {
        mailAlternateAddress: ['j@example.com'],
      });
      expect(body).to.deep.equal({
        replace: { mailAlternateAddress: ['j@example.com'] },
      });
    });

    it('should read the escaped RDN of an organization as its name', async () => {
      // A DN escapes the comma inside a value: splitting on the first one cut
      // `ou=Sales\, EU` down to `Sales\`.
      const dn = 'ou=organization,dc=example,dc=com';
      nock(baseUrl)
        .get(`/api/v1/ldap/organizations/${encodeURIComponent(dn)}/subnodes`)
        .query({ objectClass: 'organizationalUnit' })
        .reply(200, [{ dn: `ou=Sales\\, EU,${dn}` }]);

      const children = await new ConsoleApiClient(baseUrl).organizationChildren(
        dn
      );
      expect(children.map(node => node.name)).to.deep.equal(['Sales, EU']);
    });

    it('should label a raw branch by the value of its RDN', async () => {
      const branch = 'ou=positions,ou=nomenclature,dc=example,dc=com';
      nock(baseUrl)
        .get(`/api/v1/ldap/raw/children/${encodeURIComponent(branch)}`)
        .reply(200, {
          children: [
            {
              dn: `cn=Smith\\, John,${branch}`,
              rdn: 'cn=Smith\\, John',
            },
          ],
        });

      const options = await new ConsoleApiClient(baseUrl).pointerOptions(
        branch,
        []
      );
      expect(options.map(option => option.label)).to.deep.equal([
        'Smith, John',
      ]);
    });

    it('should give a failure its status whatever the body it came with', async () => {
      // Not every answer comes from the API: Express's own 404 page and a
      // proxy's 502 are HTML, and reading the body as JSON first threw a
      // `SyntaxError` carrying no status at all. `scope()` then read a server
      // without `auth/authzScope` as a refusal and hid every write button.
      nock(baseUrl)
        .get('/api/v1/authz/scope')
        .reply(404, '<!DOCTYPE html><title>Error</title>', {
          'Content-Type': 'text/html',
        });
      expect(await new ConsoleApiClient(baseUrl).scope()).to.equal(null);

      nock(baseUrl)
        .get('/api/v1/ldap/users')
        .reply(502, '<html><body>Bad gateway</body></html>', {
          'Content-Type': 'text/html',
        });
      try {
        await new ConsoleApiClient(baseUrl).list(users);
        expect.fail('the failure should have been raised');
      } catch (err) {
        expect((err as Error & { status: number }).status).to.equal(502);
        expect((err as Error).message).to.contain('502');
      }
    });

    it('should tell an absent organization tree from one it could not read', async () => {
      // A 404 is a server with no top organization: there is no tree to draw.
      nock(baseUrl)
        .get('/api/v1/ldap/organizations/top')
        .reply(404, { error: 'Not found' });
      expect(await new ConsoleApiClient(baseUrl).organizationTop()).to.equal(
        null
      );

      // Anything else is a failure, and reading it as "no tree" left the tree
      // on its loading message and every department select empty.
      nock(baseUrl)
        .get('/api/v1/ldap/organizations/top')
        .reply(403, { error: 'Out of your scope' });
      try {
        await new ConsoleApiClient(baseUrl).organizationTop();
        expect.fail('the refusal should have been raised');
      } catch (err) {
        expect((err as Error).message).to.equal('Out of your scope');
        expect((err as Error & { status: number }).status).to.equal(403);
      }
    });

    it('should tell a scope the server does not serve from one it refused', async () => {
      // No `auth/authzScope` is a 404 and means the server restricts nothing.
      nock(baseUrl)
        .get('/api/v1/authz/scope')
        .reply(404, { error: 'Not found' });
      expect(await new ConsoleApiClient(baseUrl).scope()).to.equal(null);

      // Anything else is a failure, and reading it as "unrestricted" would
      // show every button to a caller who was just refused.
      nock(baseUrl)
        .get('/api/v1/authz/scope')
        .reply(401, { error: 'No authenticated user' });
      try {
        await new ConsoleApiClient(baseUrl).scope();
        expect.fail('the refusal should have been raised');
      } catch (err) {
        expect((err as Error).message).to.equal('No authenticated user');
      }
    });
  });

  describe('EntityList', () => {
    it('should build its columns from the roles, identifier first', () => {
      expect(EntityList.chooseColumns(users)).to.deep.equal([
        'uid',
        'cn',
        'mail',
        'twakeDepartmentPath',
        'twakeAccountStatus',
      ]);
    });

    it('should still build a table for a schema with no roles', () => {
      const bare: EntityDescriptor = {
        ...users,
        schema: {
          attributes: {
            cn: { type: 'string' },
            description: { type: 'string' },
            objectClass: { type: 'array' },
          },
        },
        mainAttribute: 'cn',
      };
      expect(EntityList.chooseColumns(bare)).to.deep.equal([
        'cn',
        'description',
      ]);
    });

    it('should keep the root and the leaf of a deep path', () => {
      // The separators the shortened form adds are literal; the ones inside a
      // short path come through the shared HTML escaper, which encodes `/`.
      expect(EntityList.shortenPath('A / B / C / D')).to.equal('A / … / D');
      expect(EntityList.shortenPath('A / B')).to.equal('A &#x2F; B');
      expect(EntityList.shortenPath('A')).to.equal('A');
    });

    it('should not cut a path up with a scanner that squares its length', () => {
      // `path.split(/\s*\/\s*/)` walks back over the run of blanks before
      // every position it tries, so a path holding one long run costs the
      // square of its length — and a path is whatever the directory holds.
      // The shortened form is the same either way; the time it takes is not:
      // this input took over seven seconds before, and no measurable time
      // now.
      const path = `A / B${' '.repeat(100000)}x / C`;
      const started = Date.now();
      expect(EntityList.shortenPath(path)).to.equal('A / … / C');
      expect(Date.now() - started).to.be.below(1000);
    });

    it('should escape a path it shortens', () => {
      expect(EntityList.shortenPath('<A> / B / <D>')).to.equal(
        '&lt;A&gt; / … / &lt;D&gt;'
      );
    });

    it('should search every field the schema marks, not just the identifier', async () => {
      // Looking for a person by surname meant knowing which attribute holds
      // it and switching a selector to it first — schema knowledge asked of
      // someone searching precisely because they lack it.
      const asked: string[] = [];
      const list = new EntityList({
        entity: {
          ...users,
          schema: {
            attributes: {
              uid: { type: 'string', role: 'identifier', searchable: true },
              sn: { type: 'string', searchable: true },
              userPassword: { type: 'string', neverReturn: true },
              twakeSecret: { type: 'string' },
            },
          },
        },
        translator: new Translator('en'),
        load: (_search: string, attribute: string) => {
          asked.push(attribute);
          return Promise.resolve({});
        },
        listable: true,
        onOpen: () => undefined,
        onDelete: () => Promise.resolve(),
        canDelete: false,
      });
      await list.render(stubContainer());
      // Marked attributes only: an unmarked one is not offered, because the
      // marker says which the directory indexed.
      expect(asked).to.deep.equal(['uid,sn']);
    });

    it('should guess when the schema marks nothing', async () => {
      const asked: string[] = [];
      const list = new EntityList({
        entity: {
          ...users,
          schema: {
            attributes: {
              objectClass: { type: 'array' },
              uid: { type: 'string' },
              userPassword: { type: 'string', neverReturn: true },
              manager: { type: 'pointer' },
            },
          },
        },
        translator: new Translator('en'),
        load: (_search: string, attribute: string) => {
          asked.push(attribute);
          return Promise.resolve({});
        },
        listable: true,
        onOpen: () => undefined,
        onDelete: () => Promise.resolve(),
        canDelete: false,
      });
      await list.render(stubContainer());
      // Everything returnable, single-valued and not a DN.
      expect(asked).to.deep.equal(['uid']);
    });

    it('should show the answer to the last search, not the last answer', async () => {
      // Typing is debounced, not serialised: two loads are in flight whenever
      // the operator keeps typing, and the slow one used to overwrite the
      // fast one — the box saying "smith" over a table of "smi" results.
      const pending: ((value: Record<string, Entry>) => void)[] = [];
      const list = new EntityList({
        entity: users,
        translator: new Translator('en'),
        load: () =>
          new Promise<Record<string, Entry>>(resolve => pending.push(resolve)),
        listable: true,
        onOpen: () => undefined,
        onDelete: () => Promise.resolve(),
        canDelete: false,
      });
      const container = stubContainer();

      const first = list.render(container);
      const second = list.refresh();
      expect(pending).to.have.length(2);

      // The newer search answers first, the older one after it.
      pending[1]({ smith: { dn: 'uid=smith', uid: 'smith' } });
      pending[0]({ smi: { dn: 'uid=smi', uid: 'smi' } });
      await Promise.all([first, second]);

      expect(container.innerHTML).to.contain('smith');
      expect(container.innerHTML).to.not.contain('>smi<');
    });

    it('should not let an exported cell become a formula', () => {
      // A directory holds what was written into it, and a spreadsheet reads a
      // cell opening on one of these as a formula. Quoting does not help: the
      // quotes are stripped on import and the formula still runs.
      expect(csvCell('=HYPERLINK("http://evil.example")')).to.equal(
        '"\'=HYPERLINK(""http://evil.example"")"'
      );
      expect(csvCell('@SUM(A1)')).to.equal("'@SUM(A1)");
      expect(csvCell('-1+1')).to.equal("'-1+1");
      // Ordinary values are left alone, quoted only when they need it.
      expect(csvCell('John Smith')).to.equal('John Smith');
      expect(csvCell('Smith, John')).to.equal('"Smith, John"');
    });
  });

  describe('formatByteSize', () => {
    it('should say a size the way it was set', () => {
      // `normalize: byteSize` stores what `parseByteSize` computed, so a quota
      // set as `4GB` reads back as ten digits nobody counts at a glance.
      expect(formatByteSize('2000000000')).to.equal('2 GB');
      expect(formatByteSize('1500000')).to.equal('1.5 MB');
      expect(formatByteSize('999')).to.equal('999 B');
      expect(formatByteSize('0')).to.equal('0 B');
    });

    it('should say it only when the short form is the same number', () => {
      // The form hands what it shows back to the server, which reads it with
      // `parseByteSize`: a rounded size would write a different quota than the
      // one displayed. A value no unit states exactly stays as it is.
      expect(formatByteSize('2000000001')).to.equal('2000000001');
      expect(formatByteSize('1099511627776')).to.equal('1099511627776');
      expect(formatByteSize('not a number')).to.equal('not a number');
    });

    it('should round-trip every value it chooses to format', () => {
      for (const raw of ['2000000000', '2048', '1500000', '512000000000']) {
        const shown = formatByteSize(raw);
        expect(String(parseByteSize(shown)), shown).to.equal(raw);
      }
    });
  });

  describe('EntityForm', () => {
    const build = (entry?: Record<string, string | string[]>): EntityForm =>
      new EntityForm({
        entity: users,
        entry,
        translator: new Translator('en'),
        pointerOptions: () => Promise.resolve([]),
        onSubmit: () => Promise.resolve(),
        onCancel: () => undefined,
      });

    it('should offer neither computed nor read-only attributes', async () => {
      const container = stubContainer();
      await build().render(container);
      expect(container.innerHTML).to.not.include('data-field="uid"');
      expect(container.innerHTML).to.not.include(
        'data-field="twakeDepartmentPath"'
      );
      expect(container.innerHTML).to.not.include('data-field="memberOf"');
      expect(container.innerHTML).to.include('data-field="mail"');
    });

    it('should show the hint under the field, not only on failure', async () => {
      const container = stubContainer();
      await build().render(container);
      expect(container.innerHTML).to.include('Expected pattern 999 9999');
      expect(container.innerHTML).to.include('Expected an email address');
    });

    it('should mark required fields and say what the mark means', async () => {
      const container = stubContainer();
      await build().render(container);
      expect(container.innerHTML).to.include('dc-required');
      expect(container.innerHTML).to.include(
        'Fields marked with * are required'
      );
    });

    it('should ask for a token list on a multi-valued attribute', async () => {
      const container = stubContainer();
      await build().render(container);
      expect(container.innerHTML).to.include(
        'data-tokens="mailAlternateAddress"'
      );
      expect(container.innerHTML).to.include('Press Enter to add a value');
    });

    it('should not offer the identifier for editing once it exists', async () => {
      const container = stubContainer();
      await build({ uid: 'jsmith', cn: 'John' }).render(container);
      expect(container.innerHTML).to.not.include('data-field="uid"');
    });

    it('should stay a modal while the form is short', () => {
      // Six editable fields: a dialog still fits on screen.
      expect(build().wantsPanel).to.be.false;
    });

    it('should become a panel when the form gets long', () => {
      const attributes: EntitySchema['attributes'] = {};
      for (let i = 0; i < 20; i++) attributes[`a${i}`] = { type: 'string' };
      const long: EntityDescriptor = { ...users, schema: { attributes } };
      expect(
        new EntityForm({
          entity: long,
          translator: new Translator('en'),
          pointerOptions: () => Promise.resolve([]),
          onSubmit: () => Promise.resolve(),
          onCancel: () => undefined,
        }).wantsPanel
      ).to.be.true;
    });

    it('should convert between the directory’s date and the browser’s', () => {
      expect(EntityForm.toDateInput('20240930220000Z')).to.equal('2024-09-30');
      expect(EntityForm.toDateInput('2024-09-30T22:00:00Z')).to.equal(
        '2024-09-30'
      );
      expect(EntityForm.toDateInput('nonsense')).to.equal('');
      expect(EntityForm.toDirectoryDate('2024-09-30')).to.equal(
        '20240930000000Z'
      );
      expect(EntityForm.toDirectoryDate('')).to.equal('');
    });
  });

  describe('EntityDetail', () => {
    const render = (entry: Record<string, string | string[]>): string => {
      const container = stubContainer();
      new EntityDetail({
        entity: users,
        entry,
        translator: new Translator('en'),
        canWrite: true,
        canDelete: true,
        onEdit: () => undefined,
        onDelete: () => undefined,
        onStatus: () => undefined,
        onResetPassword: () => undefined,
      }).render(container);
      return container.innerHTML;
    };

    it('should name attributes in the reader’s language', () => {
      const container = stubContainer();
      new EntityDetail({
        entity: users,
        entry: { uid: 'jsmith' },
        translator: new Translator('fr'),
        canWrite: true,
        canDelete: true,
        onEdit: () => undefined,
        onDelete: () => undefined,
        onStatus: () => undefined,
        onResetPassword: () => undefined,
      }).render(container);
      expect(container.innerHTML).to.include('Nom');
    });

    it('should translate the states it knows and keep the ones it does not', () => {
      const entity: EntityDescriptor = {
        ...users,
        schema: {
          attributes: {
            ...usersSchema.attributes,
            twakeAccountStatus: {
              type: 'pointer',
              role: 'accountStatus',
              states: { disabled: 'cn=disabled', seconded: 'cn=seconded' },
            },
          },
        },
      };
      const container = stubContainer();
      new EntityDetail({
        entity,
        entry: { uid: 'jsmith' },
        translator: new Translator('fr'),
        canWrite: true,
        canDelete: true,
        onEdit: () => undefined,
        onDelete: () => undefined,
        onStatus: () => undefined,
        onResetPassword: () => undefined,
      }).render(container);
      expect(container.innerHTML).to.include('>Désactivé<');
      // A state the deployment invented keeps the name the deployment gave it.
      expect(container.innerHTML).to.include('>seconded<');
    });

    it('should show every attribute, empty ones included', () => {
      const html = render({ uid: 'jsmith', cn: 'John Smith' });
      // The defect this replaces: a card showing two fields, the rest only
      // reachable by opening the edit dialog.
      expect(html).to.include('Name');
      expect(html).to.include('Telephone Number');
      expect(html).to.include('Twake Department Link');
    });

    it('should never show a write-only attribute', () => {
      expect(render({ uid: 'jsmith' })).to.not.include('userPassword');
    });

    it('should offer the states the schema declares, and no others', () => {
      const html = render({ uid: 'jsmith' });
      expect(html).to.include('value="enabled"');
      expect(html).to.include('value="disabled"');
      expect(html).to.not.include('value="retired"');
    });

    it('should hide every action from a reader', () => {
      const container = stubContainer();
      new EntityDetail({
        entity: users,
        entry: { uid: 'jsmith' },
        translator: new Translator('en'),
        canWrite: false,
        canDelete: false,
        onEdit: () => undefined,
        onDelete: () => undefined,
        onStatus: () => undefined,
        onResetPassword: () => undefined,
      }).render(container);
      expect(container.innerHTML).to.not.include('data-edit');
      expect(container.innerHTML).to.not.include('data-delete');
      expect(container.innerHTML).to.not.include('data-status');
      expect(container.innerHTML).to.not.include('data-password');
    });

    it('should escape what the directory holds', () => {
      const html = render({ uid: '<script>alert(1)</script>' });
      expect(html).to.not.include('<script>alert(1)</script>');
      expect(html).to.include('&lt;script&gt;');
    });
  });
});
