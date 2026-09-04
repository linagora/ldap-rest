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
import { EntityDetail } from '../../src/browser/directory-console/components/EntityDetail';
import { EntityForm } from '../../src/browser/directory-console/components/EntityForm';
import {
  EntityList,
  csvCell,
} from '../../src/browser/directory-console/components/EntityList';
import { Translator } from '../../src/browser/directory-console/i18n';
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
    cn: { type: 'string', role: 'displayName', required: true },
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

    it('should escape a path it shortens', () => {
      expect(EntityList.shortenPath('<A> / B / <D>')).to.equal(
        '&lt;A&gt; / … / &lt;D&gt;'
      );
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

    it('should show every attribute, empty ones included', () => {
      const html = render({ uid: 'jsmith', cn: 'John Smith' });
      // The defect this replaces: a card showing two fields, the rest only
      // reachable by opening the edit dialog.
      expect(html).to.include('cn');
      expect(html).to.include('telephoneNumber');
      expect(html).to.include('twakeDepartmentLink');
    });

    it('should never show a write-only attribute', () => {
      expect(render({ uid: 'jsmith' })).to.not.include('userPassword');
    });

    it('should offer the states the schema declares, and no others', () => {
      const html = render({ uid: 'jsmith' });
      expect(html).to.include('>enabled<');
      expect(html).to.include('>disabled<');
      expect(html).to.not.include('>retired<');
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
