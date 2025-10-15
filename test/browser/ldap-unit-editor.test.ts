import { expect } from 'chai';
import nock from 'nock';

import { LdapUnitEditor } from '../../src/browser/ldap-unit-editor/index.js';

describe('Browser LDAP Unit Editor', () => {
  const baseUrl = 'http://localhost:8081';
  const containerId = 'test-container';
  let editor: LdapUnitEditor;

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Constructor', () => {
    it('should create instance with unit-specific options', () => {
      let savedUnitDn: string | undefined;

      editor = new LdapUnitEditor({
        containerId,
        apiBaseUrl: baseUrl,
        onUnitSaved: (unitDn: string) => {
          savedUnitDn = unitDn;
        },
        onError: (error: Error) => {
          console.error(error);
        },
      });

      expect(editor).to.be.instanceOf(LdapUnitEditor);
    });

    it('should work without optional callbacks', () => {
      editor = new LdapUnitEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });

      expect(editor).to.be.instanceOf(LdapUnitEditor);
    });
  });

  describe('API delegation', () => {
    beforeEach(() => {
      editor = new LdapUnitEditor({
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
      editor = new LdapUnitEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });
    });

    it('should get current organization DN', () => {
      // Test without init() - should return null initially
      const orgDn = editor.getCurrentOrgDn();
      expect(orgDn).to.be.null;
    });

    it('should get current unit DN (mapped from getCurrentUserDn)', () => {
      // Test without init() - should return null initially
      const unitDn = editor.getCurrentUserDn();
      expect(unitDn).to.be.null;
    });
  });

  describe('CRUD operations', () => {
    beforeEach(() => {
      editor = new LdapUnitEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });
    });

    it('should have createUser method for creating units', () => {
      // Test that the method exists and is callable
      expect(editor).to.have.property('createUser');
      expect(editor.createUser).to.be.a('function');
    });

    it('should have deleteUser method for deleting units', () => {
      // Test that the method exists and is callable
      expect(editor).to.have.property('deleteUser');
      expect(editor.deleteUser).to.be.a('function');
    });
  });

  describe('Initialization', () => {
    it('should have init method', () => {
      editor = new LdapUnitEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });

      expect(editor).to.have.property('init');
      expect(editor.init).to.be.a('function');
    });
  });

  describe('Callback mapping', () => {
    it('should accept onUnitSaved callback in constructor', () => {
      const callback = (unitDn: string) => {
        // Mock callback
      };

      editor = new LdapUnitEditor({
        containerId,
        apiBaseUrl: baseUrl,
        onUnitSaved: callback,
      });

      expect(editor).to.be.instanceOf(LdapUnitEditor);
    });

    it('should accept onError callback in constructor', () => {
      const callback = (error: Error) => {
        // Mock callback
      };

      editor = new LdapUnitEditor({
        containerId,
        apiBaseUrl: baseUrl,
        onError: callback,
      });

      expect(editor).to.be.instanceOf(LdapUnitEditor);
    });
  });

  describe('Organization-specific behavior', () => {
    it('should be designed for organization management', () => {
      editor = new LdapUnitEditor({
        containerId,
        apiBaseUrl: baseUrl,
      });

      // LdapUnitEditor is a wrapper that delegates to LdapUserEditor
      // but provides organization-friendly naming
      expect(editor).to.be.instanceOf(LdapUnitEditor);
      expect(editor).to.have.property('getCurrentUserDn');
      expect(editor).to.have.property('getCurrentOrgDn');
    });
  });
});
