/**
 * Rendering tests for the ldap-browser components.
 *
 * The components only ever write into `container.innerHTML` and register
 * listeners on the container, so a minimal stub element is enough to exercise
 * the whole HTML generation path without a DOM implementation.
 */
import { expect } from 'chai';
import nock from 'nock';

import { EntryView } from '../../src/browser/ldap-browser/components/EntryView';
import { EntryTree } from '../../src/browser/ldap-browser/components/EntryTree';
import { RawApiClient } from '../../src/browser/ldap-browser/api/RawApiClient';
import { SchemaView } from '../../src/browser/ldap-browser/schema';
import type {
  LdapSchema,
  RawEntry,
} from '../../src/browser/ldap-browser/types';

/** Minimal stand-in for the container element the components render into */
function stubContainer(): HTMLElement & { innerHTML: string } {
  return {
    innerHTML: '',
    classList: { add: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLElement & { innerHTML: string };
}

const schema: LdapSchema = {
  objectClasses: [
    {
      oid: '2.5.6.0',
      names: ['top'],
      obsolete: false,
      sup: [],
      kind: 'ABSTRACT',
      must: ['objectClass'],
      may: [],
    },
    {
      oid: '2.5.6.6',
      names: ['person'],
      desc: 'RFC2256: a person',
      obsolete: false,
      sup: ['top'],
      kind: 'STRUCTURAL',
      must: ['sn', 'cn'],
      may: ['userPassword', 'description'],
    },
    {
      oid: '2.16.840.1.113730.3.2.2',
      names: ['inetOrgPerson'],
      obsolete: false,
      sup: ['person'],
      kind: 'STRUCTURAL',
      must: [],
      may: ['uid', 'mail', 'jpegPhoto'],
    },
  ],
  attributeTypes: [
    {
      oid: '2.5.4.3',
      names: ['cn'],
      desc: 'Common name',
      obsolete: false,
      syntax: '1.3.6.1.4.1.1466.115.121.1.15',
      singleValue: false,
      collective: false,
      noUserModification: false,
      usage: 'userApplications',
    },
    {
      oid: '0.9.2342.19200300.100.1.60',
      names: ['jpegPhoto'],
      obsolete: false,
      syntax: '1.3.6.1.4.1.1466.115.121.1.28',
      singleValue: false,
      collective: false,
      noUserModification: false,
      usage: 'userApplications',
    },
    {
      oid: '1.3.6.1.1.16.4',
      names: ['entryUUID'],
      obsolete: false,
      syntax: '1.3.6.1.1.16.1',
      singleValue: true,
      collective: false,
      noUserModification: true,
      usage: 'directoryOperation',
    },
  ],
  syntaxes: [],
  matchingRules: [],
};

const entry: RawEntry = {
  dn: 'uid=alice,ou=users,dc=example,dc=com',
  attributes: {
    objectClass: { values: ['top', 'inetOrgPerson'], binary: false },
    uid: { values: ['alice'], binary: false },
    cn: { values: ['Alice Smith'], binary: false },
    sn: { values: ['Smith'], binary: false },
    jpegPhoto: { values: ['/9j/4AAQSkZJRg=='], binary: true },
    entryUUID: { values: ['9c1c-2e8a'], binary: false },
  },
};

describe('Browser LDAP Browser rendering', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  describe('EntryView', () => {
    it('should render the DN, object classes and attribute table', () => {
      const container = stubContainer();
      new EntryView(container, new SchemaView(schema)).render(entry);

      expect(container.innerHTML).to.contain(
        'uid=alice,ou=users,dc=example,dc=com'
      );
      expect(container.innerHTML).to.contain('inetOrgPerson');
      expect(container.innerHTML).to.contain('Alice Smith');
      // The schema description ends up in the attribute tooltip
      expect(container.innerHTML).to.contain('Common name');
    });

    it('should mark mandatory attributes', () => {
      const container = stubContainer();
      new EntryView(container, new SchemaView(schema)).render(entry);
      expect(container.innerHTML).to.contain('ldap-browser-attr--must');
    });

    it('should split operational attributes into their own table', () => {
      const container = stubContainer();
      new EntryView(container, new SchemaView(schema)).render(entry);
      expect(container.innerHTML).to.contain('Operational attributes');
    });

    it('should render binary values as images or base64 blocks', () => {
      const container = stubContainer();
      new EntryView(container, new SchemaView(schema)).render(entry);
      expect(container.innerHTML).to.contain('data:image/jpeg;base64,');

      const withBlob = stubContainer();
      new EntryView(withBlob, new SchemaView(schema)).render({
        dn: 'cn=cert,dc=example,dc=com',
        attributes: {
          userCertificate: { values: ['AAECAwQ='], binary: true },
        },
      });
      expect(withBlob.innerHTML).to.contain('bytes (base64)');
      expect(withBlob.innerHTML).to.contain('AAECAwQ=');
    });

    it('should warn about missing mandatory attributes', () => {
      const container = stubContainer();
      new EntryView(container, new SchemaView(schema)).render({
        dn: 'uid=bob,ou=users,dc=example,dc=com',
        attributes: {
          objectClass: { values: ['top', 'person'], binary: false },
          cn: { values: ['Bob'], binary: false },
        },
      });
      expect(container.innerHTML).to.contain('Missing mandatory attribute');
      expect(container.innerHTML).to.contain('sn');
    });

    it('should flag object classes and attributes absent from the schema', () => {
      const container = stubContainer();
      new EntryView(container, new SchemaView(schema)).render({
        dn: 'cn=weird,dc=example,dc=com',
        attributes: {
          objectClass: { values: ['unknownClass'], binary: false },
          weirdAttribute: { values: ['x'], binary: false },
        },
      });
      expect(container.innerHTML).to.contain('ldap-browser-chip--unknown');
      expect(container.innerHTML).to.contain('ldap-browser-attr--unknown');
    });

    it('should render without a schema', () => {
      const container = stubContainer();
      new EntryView(container, null).render(entry);
      expect(container.innerHTML).to.contain('Alice Smith');
      expect(container.innerHTML).to.not.contain('ldap-browser-attr--must');
    });

    it('should escape values instead of injecting markup', () => {
      const container = stubContainer();
      new EntryView(container, null).render({
        dn: 'cn=xss,dc=example,dc=com',
        attributes: {
          description: {
            values: ['<img src=x onerror=alert(1)>'],
            binary: false,
          },
        },
      });
      expect(container.innerHTML).to.not.contain('<img src=x');
      expect(container.innerHTML).to.contain('&lt;img');
    });

    it('should render the empty, loading and error states', () => {
      const container = stubContainer();
      const view = new EntryView(container, null);

      view.renderEmpty();
      expect(container.innerHTML).to.contain('Select an entry');

      view.renderLoading();
      expect(container.innerHTML).to.contain('Loading');

      view.renderError('boom');
      expect(container.innerHTML).to.contain('boom');
    });
  });

  describe('EntryTree', () => {
    const baseUrl = 'http://localhost:8081';
    const prefix = '/api/v1/ldap/raw';
    const root = 'dc=example,dc=com';

    it('should expand the first root and render its children', async () => {
      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(root)}`)
        .query({ children: '1' })
        .reply(200, {
          children: [
            {
              dn: `ou=users,${root}`,
              rdn: 'ou=users',
              objectClass: ['organizationalUnit'],
              hasChildren: true,
            },
            {
              dn: `uid=alice,${root}`,
              rdn: 'uid=alice',
              objectClass: ['inetOrgPerson'],
              hasChildren: false,
            },
          ],
          truncated: false,
        });

      const container = stubContainer();
      const tree = new EntryTree(
        container,
        new RawApiClient(baseUrl),
        () => undefined,
        error => expect.fail(error.message)
      );
      await tree.init([root]);

      expect(container.innerHTML).to.contain('ou=users');
      expect(container.innerHTML).to.contain('uid=alice');
      // Folder icon for the OU, person icon for the user
      expect(container.innerHTML).to.contain('folder');
      expect(container.innerHTML).to.contain('person');
      // Only the node flagged hasChildren gets an expand arrow
      expect(container.innerHTML).to.contain('chevron_right');
      tree.destroy();
    });

    it('should render an empty node without children', async () => {
      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(root)}`)
        .query({ children: '1' })
        .reply(200, { children: [], truncated: false });

      const container = stubContainer();
      const tree = new EntryTree(
        container,
        new RawApiClient(baseUrl),
        () => undefined,
        () => undefined
      );
      await tree.init([root]);
      expect(container.innerHTML).to.contain('(no child)');
      tree.destroy();
    });

    it('should tell the user when a branch was truncated', async () => {
      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(root)}`)
        .query({ children: '1' })
        .reply(200, {
          children: [
            {
              dn: `uid=alice,${root}`,
              rdn: 'uid=alice',
              objectClass: ['inetOrgPerson'],
              hasChildren: false,
            },
          ],
          truncated: true,
        });

      const container = stubContainer();
      const tree = new EntryTree(
        container,
        new RawApiClient(baseUrl),
        () => undefined,
        () => undefined
      );
      await tree.init([root]);
      expect(container.innerHTML).to.contain('ldap-browser-tree__truncated');
      expect(container.innerHTML).to.contain('first 1 entries only');
      tree.destroy();
    });

    it('should report a failing expansion and stay usable', async () => {
      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(root)}`)
        .query({ children: '1' })
        .reply(403, { error: 'forbidden' });

      const errors: Error[] = [];
      const container = stubContainer();
      const tree = new EntryTree(
        container,
        new RawApiClient(baseUrl),
        () => undefined,
        error => errors.push(error)
      );
      await tree.init([root]);

      expect(errors).to.have.length(1);
      expect(errors[0].message).to.contain('403');
      expect(container.innerHTML).to.contain(root);
      tree.destroy();
    });

    it('should notify and highlight the selected DN', async () => {
      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(root)}`)
        .query({ children: '1' })
        .reply(200, { children: [], truncated: false });

      const selected: string[] = [];
      const container = stubContainer();
      const tree = new EntryTree(
        container,
        new RawApiClient(baseUrl),
        dn => {
          selected.push(dn);
        },
        () => undefined
      );
      await tree.init([root]);
      await tree.select(root);

      expect(selected).to.deep.equal([root]);
      expect(tree.getSelectedDn()).to.equal(root);
      expect(container.innerHTML).to.contain(
        'ldap-browser-tree__node--selected'
      );
      tree.destroy();
    });

    it('should expand every ancestor when revealing a deep DN', async () => {
      const target = `uid=alice,ou=users,${root}`;
      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(root)}`)
        .query({ children: '1' })
        .reply(200, {
          children: [
            {
              dn: `ou=users,${root}`,
              rdn: 'ou=users',
              objectClass: ['organizationalUnit'],
              hasChildren: true,
            },
          ],
          truncated: false,
        });
      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(`ou=users,${root}`)}`)
        .query({ children: '1' })
        .reply(200, {
          children: [
            {
              dn: target,
              rdn: 'uid=alice',
              objectClass: ['inetOrgPerson'],
              hasChildren: false,
            },
          ],
          truncated: false,
        });

      const container = stubContainer();
      const tree = new EntryTree(
        container,
        new RawApiClient(baseUrl),
        () => undefined,
        error => expect.fail(error.message)
      );
      await tree.init([root]);
      await tree.revealAndSelect(target);

      expect(tree.getSelectedDn()).to.equal(target);
      expect(container.innerHTML).to.contain('uid=alice');
      expect(nock.isDone()).to.equal(true);
      tree.destroy();
    });

    it('should refetch children after invalidation', async () => {
      const container = stubContainer();
      const tree = new EntryTree(
        container,
        new RawApiClient(baseUrl),
        () => undefined,
        () => undefined
      );

      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(root)}`)
        .query({ children: '1' })
        .reply(200, { children: [], truncated: false });
      await tree.init([root]);

      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(root)}`)
        .query({ children: '1' })
        .reply(200, {
          children: [
            {
              dn: `ou=new,${root}`,
              rdn: 'ou=new',
              objectClass: ['organizationalUnit'],
              hasChildren: false,
            },
          ],
          truncated: false,
        });
      tree.invalidate();
      await tree.revealAndSelect(root);

      expect(container.innerHTML).to.contain('ou=new');
      tree.destroy();
    });
  });
});
