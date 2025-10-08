import { expect } from 'chai';
import nock from 'nock';

import { LdapGroupEditor } from '../../src/browser/ldap-group-editor/index.js';

describe('Browser LDAP Group Editor', () => {
  const baseUrl = 'http://localhost:8081';
  const containerId = 'test-container';
  let editor: LdapGroupEditor;

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Constructor', () => {
    it('should create instance with group-specific options', () => {
      let savedGroupDn: string | undefined;

      editor = new LdapGroupEditor({
        containerId,
        apiBaseUrl: baseUrl,
        onGroupSaved: (groupDn: string) => {
          savedGroupDn = groupDn;
        },
        onError: (error: Error) => {
          console.error(error);
        },
      });

      expect(editor).to.be.instanceOf(LdapGroupEditor);
    });

    it('should work without optional callbacks', () => {
      editor = new LdapGroupEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });

      expect(editor).to.be.instanceOf(LdapGroupEditor);
    });
  });

  describe('API delegation', () => {
    beforeEach(() => {
      editor = new LdapGroupEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });
    });

    it('should delegate getApi to user editor', () => {
      // Test that getApi method exists and can be called
      const api = editor.getApi();
      expect(api).to.exist;
      expect(api).to.have.property('getConfig');
    });

    it('should delegate getConfig to user editor', () => {
      // Test that getConfig method exists and can be called
      // Returns null initially since init() hasn't been called
      const config = editor.getConfig();
      expect(config).to.be.null;
    });
  });

  describe('Context methods', () => {
    beforeEach(() => {
      editor = new LdapGroupEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });
    });

    it('should get current organization DN', () => {
      // Test without init() - should return null initially
      const orgDn = editor.getCurrentOrgDn();
      expect(orgDn).to.be.null;
    });

    it('should get current group DN (mapped from getCurrentUserDn)', () => {
      // Test without init() - should return null initially
      const groupDn = editor.getCurrentUserDn();
      expect(groupDn).to.be.null;
    });
  });

  describe('CRUD operations', () => {
    beforeEach(() => {
      editor = new LdapGroupEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });
    });

    it('should have createUser method for creating groups', () => {
      // Test that the method exists and is callable
      expect(editor).to.have.property('createUser');
      expect(editor.createUser).to.be.a('function');
    });

    it('should have deleteUser method for deleting groups', () => {
      // Test that the method exists and is callable
      expect(editor).to.have.property('deleteUser');
      expect(editor.deleteUser).to.be.a('function');
    });
  });

  describe('Initialization', () => {
    it('should have init method', () => {
      editor = new LdapGroupEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });

      expect(editor).to.have.property('init');
      expect(editor.init).to.be.a('function');
    });
  });

  describe('Callback mapping', () => {
    it('should accept onGroupSaved callback in constructor', () => {
      const callback = (groupDn: string) => {
        // Mock callback
      };

      editor = new LdapGroupEditor({
        containerId,
        apiBaseUrl: baseUrl,
        onGroupSaved: callback,
      });

      expect(editor).to.be.instanceOf(LdapGroupEditor);
    });

    it('should accept onError callback in constructor', () => {
      const callback = (error: Error) => {
        // Mock callback
      };

      editor = new LdapGroupEditor({
        containerId,
        apiBaseUrl: baseUrl,
        onError: callback,
      });

      expect(editor).to.be.instanceOf(LdapGroupEditor);
    });
  });
});
