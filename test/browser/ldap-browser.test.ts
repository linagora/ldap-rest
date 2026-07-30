import { expect } from 'chai';
import nock from 'nock';

import { RawApiClient } from '../../src/browser/ldap-browser/api/RawApiClient';
import { SchemaView } from '../../src/browser/ldap-browser/schema';
import { LdapBrowser } from '../../src/browser/ldap-browser/LdapBrowser';
import type { LdapSchema } from '../../src/browser/ldap-browser/types';

describe('Browser LDAP Browser', () => {
  const baseUrl = 'http://localhost:8081';
  const prefix = '/api/v1/ldap/raw';

  afterEach(() => {
    nock.cleanAll();
  });

  describe('RawApiClient', () => {
    let client: RawApiClient;

    beforeEach(() => {
      client = new RawApiClient(baseUrl);
    });

    it('should list the exposed bases', async () => {
      nock(baseUrl)
        .get(`${prefix}/bases`)
        .reply(200, { bases: ['dc=example,dc=com'] });
      expect(await client.getBases()).to.deep.equal(['dc=example,dc=com']);
    });

    it('should URL-encode the DN of an entry', async () => {
      const dn = 'uid=alice,ou=users,dc=example,dc=com';
      nock(baseUrl)
        .get(`${prefix}/entry/${encodeURIComponent(dn)}`)
        .reply(200, { dn, attributes: {} });
      const entry = await client.getEntry(dn);
      expect(entry.dn).to.equal(dn);
    });

    it('should ask for the hasChildren flag by default', async () => {
      const dn = 'dc=example,dc=com';
      nock(baseUrl)
        .get(`${prefix}/children/${encodeURIComponent(dn)}`)
        .query({ children: '1' })
        .reply(200, { children: [], truncated: false });
      expect(await client.getChildren(dn)).to.deep.equal({
        children: [],
        truncated: false,
      });
    });

    it('should build the search query', async () => {
      nock(baseUrl)
        .get(`${prefix}/search`)
        .query({
          base: 'dc=example,dc=com',
          scope: 'one',
          filter: '(uid=alice)',
          attributes: 'uid,cn',
          limit: '10',
        })
        .reply(200, { entries: [], truncated: false });

      const result = await client.search({
        base: 'dc=example,dc=com',
        scope: 'one',
        filter: '(uid=alice)',
        attributes: ['uid', 'cn'],
        limit: 10,
      });
      expect(result.truncated).to.equal(false);
    });

    it('should surface the server error message', async () => {
      nock(baseUrl)
        .get(
          `${prefix}/entry/${encodeURIComponent('ou=nope,dc=example,dc=com')}`
        )
        .reply(404, { error: 'Entry ou=nope,dc=example,dc=com not found' });

      try {
        await client.getEntry('ou=nope,dc=example,dc=com');
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).to.contain('404');
        expect((error as Error).message).to.contain('not found');
      }
    });

    it('should fall back to the status text on a non-JSON error', async () => {
      nock(baseUrl).get(`${prefix}/bases`).reply(500, 'boom');
      try {
        await client.getBases();
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).to.contain('500');
      }
    });

    it('should send the bearer token when given', async () => {
      const authenticated = new RawApiClient(baseUrl, 'secret-token');
      nock(baseUrl, { reqheaders: { Authorization: 'Bearer secret-token' } })
        .get(`${prefix}/bases`)
        .reply(200, { bases: [] });
      expect(await authenticated.getBases()).to.deep.equal([]);
    });

    it('should tolerate a trailing slash in the base URL', async () => {
      const trailing = new RawApiClient(`${baseUrl}/`);
      nock(baseUrl).get(`${prefix}/bases`).reply(200, { bases: [] });
      expect(await trailing.getBases()).to.deep.equal([]);
    });
  });

  describe('SchemaView', () => {
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
          may: ['uid', 'mail', 'jpegPhoto', 'cn'],
        },
      ],
      attributeTypes: [
        {
          oid: '2.5.4.41',
          names: ['name'],
          obsolete: false,
          syntax: '1.3.6.1.4.1.1466.115.121.1.15',
          singleValue: false,
          collective: false,
          noUserModification: false,
          usage: 'userApplications',
        },
        {
          oid: '2.5.4.3',
          names: ['cn', 'commonName'],
          obsolete: false,
          sup: 'name',
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
      ],
      syntaxes: [],
      matchingRules: [],
    };
    const view = new SchemaView(schema);

    it('should look up classes and attributes by name, alias and OID', () => {
      expect(view.getObjectClass('PERSON')!.oid).to.equal('2.5.6.6');
      expect(view.getAttributeType('commonName')!.oid).to.equal('2.5.4.3');
      expect(view.getAttributeType('2.5.4.3')!.names).to.contain('cn');
      expect(view.getObjectClass('nope')).to.equal(undefined);
    });

    it('should resolve the syntax through the SUP chain', () => {
      expect(view.getAttributeSyntax('cn')).to.equal(
        '1.3.6.1.4.1.1466.115.121.1.15'
      );
    });

    it('should collect MUST and MAY through inheritance', () => {
      const { must, may } = view.resolveAttributes(['inetOrgPerson']);
      expect(must.sort()).to.deep.equal(['cn', 'objectClass', 'sn']);
      expect(may).to.contain('mail');
      expect(may).to.not.contain('cn');
    });

    it('should detect binary and image attributes', () => {
      expect(view.isBinaryAttribute('jpegPhoto')).to.equal(true);
      expect(view.isBinaryAttribute('cn')).to.equal(false);
      expect(view.isBinaryAttribute('cn;binary')).to.equal(true);
      expect(view.isImageAttribute('jpegPhoto')).to.equal(true);
      expect(view.isImageAttribute('cn')).to.equal(false);
    });
  });

  describe('LdapBrowser', () => {
    /**
     * Minimal stand-in for the page: `init()` looks the container up by id,
     * writes its layout into it, then picks the panels back with
     * `querySelector`. Each selector returns its own stub element.
     */
    function installDocumentStub(): {
      panels: Map<string, { innerHTML: string; hidden?: boolean }>;
      restore: () => void;
    } {
      const panels = new Map<string, { innerHTML: string; hidden?: boolean }>();
      const element = (): Record<string, unknown> => ({
        innerHTML: '',
        hidden: false,
        value: '',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        classList: { add: () => undefined },
      });
      const container = {
        ...element(),
        querySelector: (selector: string) => {
          if (!panels.has(selector))
            panels.set(
              selector,
              element() as unknown as { innerHTML: string; hidden?: boolean }
            );
          return panels.get(selector);
        },
      };
      const previous = (globalThis as Record<string, unknown>).document;
      (globalThis as Record<string, unknown>).document = {
        getElementById: (id: string) =>
          id === 'ldap-browser' ? container : null,
      };
      return {
        panels,
        restore: () => {
          (globalThis as Record<string, unknown>).document = previous;
        },
      };
    }

    it('should load bases, schema and the initial entry on init', async () => {
      const dom = installDocumentStub();
      try {
        nock(baseUrl)
          .get(`${prefix}/bases`)
          .reply(200, { bases: ['dc=example,dc=com'] });
        nock(baseUrl).get(`${prefix}/schema`).reply(200, {
          objectClasses: [],
          attributeTypes: [],
          syntaxes: [],
          matchingRules: [],
        });
        nock(baseUrl)
          .get(`${prefix}/children/${encodeURIComponent('dc=example,dc=com')}`)
          .query({ children: '1' })
          .reply(200, { children: [], truncated: false });
        nock(baseUrl)
          .get(`${prefix}/entry/${encodeURIComponent('dc=example,dc=com')}`)
          .reply(200, {
            dn: 'dc=example,dc=com',
            attributes: {
              objectClass: { values: ['top', 'domain'], binary: false },
              dc: { values: ['example'], binary: false },
            },
          });

        const selected: string[] = [];
        const browser = new LdapBrowser({
          containerId: 'ldap-browser',
          apiBaseUrl: baseUrl,
          onEntrySelected: dn => selected.push(dn),
          onError: error => expect.fail(error.message),
        });
        await browser.init();

        expect(browser.getCurrentDn()).to.equal('dc=example,dc=com');
        expect(selected).to.deep.equal(['dc=example,dc=com']);
        expect(dom.panels.get('.ldap-browser__entry')!.innerHTML).to.contain(
          'example'
        );
        expect(nock.isDone()).to.equal(true);
        browser.destroy();
      } finally {
        dom.restore();
      }
    });

    it('should keep browsing when the schema cannot be read', async () => {
      const dom = installDocumentStub();
      try {
        nock(baseUrl)
          .get(`${prefix}/bases`)
          .reply(200, { bases: ['dc=example,dc=com'] });
        nock(baseUrl).get(`${prefix}/schema`).reply(403, { error: 'nope' });
        nock(baseUrl)
          .get(`${prefix}/children/${encodeURIComponent('dc=example,dc=com')}`)
          .query({ children: '1' })
          .reply(200, { children: [], truncated: false });
        nock(baseUrl)
          .get(`${prefix}/entry/${encodeURIComponent('dc=example,dc=com')}`)
          .reply(200, { dn: 'dc=example,dc=com', attributes: {} });

        const errors: Error[] = [];
        const browser = new LdapBrowser({
          containerId: 'ldap-browser',
          apiBaseUrl: baseUrl,
          onError: error => errors.push(error),
        });
        await browser.init();

        expect(errors).to.have.length(1);
        expect(errors[0].message).to.contain('403');
        expect(browser.getCurrentDn()).to.equal('dc=example,dc=com');
        browser.destroy();
      } finally {
        dom.restore();
      }
    });

    it('should throw when the container does not exist', async () => {
      const dom = installDocumentStub();
      try {
        const browser = new LdapBrowser({
          containerId: 'missing',
          apiBaseUrl: baseUrl,
        });
        try {
          await browser.init();
          expect.fail('Should have thrown');
        } catch (error) {
          expect((error as Error).message).to.contain('not found');
        }
      } finally {
        dom.restore();
      }
    });

    it('should build with minimal options', () => {
      const browser = new LdapBrowser({
        containerId: 'ldap-browser',
        apiBaseUrl: baseUrl,
      });
      expect(browser).to.be.instanceOf(LdapBrowser);
      expect(browser.getCurrentDn()).to.equal(null);
    });

    it('should accept callbacks', () => {
      const browser = new LdapBrowser({
        containerId: 'ldap-browser',
        apiBaseUrl: baseUrl,
        initialDn: 'dc=example,dc=com',
        onEntrySelected: () => undefined,
        onError: () => undefined,
      });
      expect(browser).to.be.instanceOf(LdapBrowser);
    });
  });
});
