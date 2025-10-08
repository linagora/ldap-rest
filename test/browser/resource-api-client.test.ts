import { expect } from 'chai';
import nock from 'nock';

import { ResourceApiClient } from '../../src/browser/ldap-resource-editor/api/ResourceApiClient';

describe('Browser Resource API Client', () => {
  const baseUrl = 'http://localhost:8081';

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Users resource type', () => {
    let client: ResourceApiClient;

    beforeEach(() => {
      client = new ResourceApiClient('users', baseUrl);
    });

    it('should get resources', async () => {
      const mockResponse = [
        { dn: 'uid=user1,ou=users,o=gov,c=mu', uid: 'user1' },
        { dn: 'uid=user2,ou=users,o=gov,c=mu', uid: 'user2' },
      ];

      nock(baseUrl).get('/api/v1/ldap/users').reply(200, mockResponse);

      const result = await client.getResources();
      expect(result).to.deep.equal(mockResponse);
    });

    it('should get resources with search', async () => {
      const mockResponse = [
        { dn: 'uid=john,ou=users,o=gov,c=mu', uid: 'john' },
      ];

      nock(baseUrl)
        .get('/api/v1/ldap/users?match=john&attribute=uid')
        .reply(200, mockResponse);

      const result = await client.getResources('john');
      expect(result).to.deep.equal(mockResponse);
    });

    it('should handle object response format', async () => {
      const mockResponse = {
        user1: { dn: 'uid=user1,ou=users,o=gov,c=mu', uid: 'user1' },
        user2: { dn: 'uid=user2,ou=users,o=gov,c=mu', uid: 'user2' },
      };

      nock(baseUrl).get('/api/v1/ldap/users').reply(200, mockResponse);

      const result = await client.getResources();
      expect(result).to.be.an('array').with.lengthOf(2);
      expect(result[0]).to.have.property('dn');
    });

    it('should get single resource', async () => {
      const dn = 'uid=user1,ou=users,o=gov,c=mu';
      const mockResponse = { dn, uid: 'user1' };

      nock(baseUrl)
        .get(`/api/v1/ldap/users/${encodeURIComponent(dn)}`)
        .reply(200, mockResponse);

      const result = await client.getResource(dn);
      expect(result).to.deep.equal(mockResponse);
    });

    it('should update resource', async () => {
      const dn = 'uid=user1,ou=users,o=gov,c=mu';
      const data = { cn: 'Updated Name' };
      const mockResponse = { dn, uid: 'user1', cn: 'Updated Name' };

      nock(baseUrl)
        .put(`/api/v1/ldap/users/${encodeURIComponent(dn)}`, data)
        .reply(200, mockResponse);

      const result = await client.updateResource(dn, data);
      expect(result).to.deep.equal(mockResponse);
    });

    it('should create resource', async () => {
      const data = { uid: 'newuser', cn: 'New User' };
      const mockResponse = {
        dn: 'uid=newuser,ou=users,o=gov,c=mu',
        ...data,
      };

      nock(baseUrl)
        .post('/api/v1/ldap/users', data)
        .reply(200, mockResponse);

      const result = await client.createResource(data);
      expect(result).to.deep.equal(mockResponse);
    });

    it('should delete resource', async () => {
      const dn = 'uid=user1,ou=users,o=gov,c=mu';

      nock(baseUrl)
        .delete(`/api/v1/ldap/users/${encodeURIComponent(dn)}`)
        .reply(200);

      await client.deleteResource(dn);
    });
  });

  describe('Groups resource type', () => {
    let client: ResourceApiClient;

    beforeEach(() => {
      client = new ResourceApiClient('groups', baseUrl);
    });

    it('should use correct endpoint for groups', async () => {
      const mockResponse = [
        { dn: 'cn=group1,ou=groups,o=gov,c=mu', cn: 'group1' },
      ];

      nock(baseUrl).get('/api/v1/ldap/groups').reply(200, mockResponse);

      const result = await client.getResources();
      expect(result).to.deep.equal(mockResponse);
    });

    it('should use cn as main attribute', async () => {
      const mockResponse = [
        { dn: 'cn=admin,ou=groups,o=gov,c=mu', cn: 'admin' },
      ];

      nock(baseUrl)
        .get('/api/v1/ldap/groups?match=admin&attribute=cn')
        .reply(200, mockResponse);

      const result = await client.getResources('admin');
      expect(result).to.deep.equal(mockResponse);
    });
  });

  describe('Organizations resource type', () => {
    let client: ResourceApiClient;

    beforeEach(() => {
      client = new ResourceApiClient('organizations', baseUrl);
    });

    it('should use correct endpoint for organizations', async () => {
      const mockResponse = [
        { dn: 'ou=org1,ou=organization,o=gov,c=mu', ou: 'org1' },
      ];

      nock(baseUrl)
        .get('/api/v1/ldap/organizations')
        .reply(200, mockResponse);

      const result = await client.getResources();
      expect(result).to.deep.equal(mockResponse);
    });

    it('should use ou as main attribute', async () => {
      const mockResponse = [
        { dn: 'ou=HR,ou=organization,o=gov,c=mu', ou: 'HR' },
      ];

      nock(baseUrl)
        .get('/api/v1/ldap/organizations?match=HR&attribute=ou')
        .reply(200, mockResponse);

      const result = await client.getResources('HR');
      expect(result).to.deep.equal(mockResponse);
    });

    it('should create entry for organizations', async () => {
      const dn = 'ou=neworg,ou=organization,o=gov,c=mu';
      const data = { ou: 'neworg' };
      const mockResponse = { dn, ...data };

      nock(baseUrl)
        .put(`/api/v1/ldap/entry/${encodeURIComponent(dn)}`, data)
        .reply(200, mockResponse);

      const result = await client.createEntry(dn, data);
      expect(result).to.deep.equal(mockResponse);
    });

    it('should delete entry for organizations', async () => {
      const dn = 'ou=oldorg,ou=organization,o=gov,c=mu';

      nock(baseUrl)
        .delete(`/api/v1/ldap/entry/${encodeURIComponent(dn)}`)
        .reply(200);

      await client.deleteEntry(dn);
    });
  });

  describe('Config and Schema', () => {
    let client: ResourceApiClient;

    beforeEach(() => {
      client = new ResourceApiClient('users', baseUrl);
    });

    it('should get config', async () => {
      const mockConfig = {
        ldapBase: 'o=gov,c=mu',
        features: { flatResources: [] },
      };

      nock(baseUrl).get('/api/v1/config').reply(200, mockConfig);

      const result = await client.getConfig();
      expect(result).to.deep.equal(mockConfig);
    });

    it('should get schema', async () => {
      const schemaUrl = '/static/schemas/users.json';
      const mockSchema = {
        entity: { name: 'user' },
        attributes: {},
      };

      nock(baseUrl).get(schemaUrl).reply(200, mockSchema);

      const result = await client.getSchema(schemaUrl);
      expect(result).to.deep.equal(mockSchema);
    });
  });

  describe('Pointer Options', () => {
    let client: ResourceApiClient;

    beforeEach(() => {
      client = new ResourceApiClient('users', baseUrl);
    });

    it('should get pointer options', async () => {
      const branch = 'ou=users,o=gov,c=mu';
      const mockConfig = {
        features: {
          flatResources: [
            {
              base: branch,
              mainAttribute: 'uid',
              schemaUrl: '/static/schemas/users.json',
              endpoints: {
                list: '/api/v1/ldap/users',
              },
            },
          ],
        },
      };
      const mockSchema = {
        attributes: {
          cn: { role: 'displayName' },
        },
      };
      const mockUsers = [
        { dn: 'uid=user1,ou=users,o=gov,c=mu', uid: 'user1', cn: 'User One' },
        { dn: 'uid=user2,ou=users,o=gov,c=mu', uid: 'user2', cn: 'User Two' },
      ];

      nock(baseUrl).get('/api/v1/config').reply(200, mockConfig);
      nock(baseUrl)
        .get('/static/schemas/users.json')
        .reply(200, mockSchema);
      nock(baseUrl).get('/api/v1/ldap/users').reply(200, mockUsers);

      const result = await client.getPointerOptions(branch);
      expect(result).to.be.an('array').with.lengthOf(2);
      expect(result[0]).to.have.property('dn');
      expect(result[0]).to.have.property('label');
      expect(result[0].label).to.equal('User One');
    });

    it('should handle missing config gracefully', async () => {
      const branch = 'ou=unknown,o=gov,c=mu';
      const mockConfig = {
        features: { flatResources: [] },
      };

      nock(baseUrl).get('/api/v1/config').reply(200, mockConfig);

      const result = await client.getPointerOptions(branch);
      expect(result).to.be.an('array').that.is.empty;
    });
  });

  describe('Cache functionality', () => {
    let client: ResourceApiClient;

    beforeEach(() => {
      client = new ResourceApiClient('users', baseUrl);
    });

    it('should cache GET requests', async () => {
      const mockResponse = [{ dn: 'uid=user1,ou=users,o=gov,c=mu' }];

      // First request
      nock(baseUrl).get('/api/v1/ldap/users').reply(200, mockResponse);
      const result1 = await client.getResources();

      // Second request should use cache (nock won't match if called again)
      const result2 = await client.getResources();

      expect(result1).to.deep.equal(result2);
    });

    it('should not cache non-GET requests', async () => {
      const data = { uid: 'newuser' };
      const mockResponse = { dn: 'uid=newuser,ou=users,o=gov,c=mu', ...data };

      nock(baseUrl).post('/api/v1/ldap/users', data).reply(200, mockResponse);

      await client.createResource(data);

      // Cache stats should not include POST requests
      const stats = client.getCacheStats();
      expect(stats.keys).to.not.include('/api/v1/ldap/users');
    });

    it('should clear cache', async () => {
      const mockResponse = [{ dn: 'uid=user1,ou=users,o=gov,c=mu' }];

      nock(baseUrl).get('/api/v1/ldap/users').reply(200, mockResponse);
      await client.getResources();

      client.clearCache();

      const stats = client.getCacheStats();
      expect(stats.size).to.equal(0);
    });

    it('should invalidate cache by pattern', async () => {
      const mockUsers = [{ dn: 'uid=user1,ou=users,o=gov,c=mu' }];
      const mockConfig = { ldapBase: 'o=gov,c=mu' };

      nock(baseUrl).get('/api/v1/ldap/users').reply(200, mockUsers);
      nock(baseUrl).get('/api/v1/config').reply(200, mockConfig);

      await client.getResources();
      await client.getConfig();

      client.invalidateCache('*/ldap/users*');

      const stats = client.getCacheStats();
      // Config should still be cached
      expect(stats.keys.some(k => k.includes('/config'))).to.be.true;
    });
  });

  describe('Error handling', () => {
    let client: ResourceApiClient;

    beforeEach(() => {
      client = new ResourceApiClient('users', baseUrl);
    });

    it('should handle 404 errors', async () => {
      const dn = 'uid=notfound,ou=users,o=gov,c=mu';

      nock(baseUrl)
        .get(`/api/v1/ldap/users/${encodeURIComponent(dn)}`)
        .reply(404, 'Not Found');

      try {
        await client.getResource(dn);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('404');
      }
    });

    it('should handle update errors', async () => {
      const dn = 'uid=user1,ou=users,o=gov,c=mu';
      const data = { cn: 'Updated' };

      nock(baseUrl)
        .put(`/api/v1/ldap/users/${encodeURIComponent(dn)}`)
        .reply(500, 'Internal Server Error');

      try {
        await client.updateResource(dn, data);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('Failed to update users');
      }
    });

    it('should handle create errors', async () => {
      const data = { uid: 'newuser' };

      nock(baseUrl)
        .post('/api/v1/ldap/users')
        .reply(400, 'Invalid data');

      try {
        await client.createResource(data);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('Failed to create users');
      }
    });

    it('should handle delete errors', async () => {
      const dn = 'uid=user1,ou=users,o=gov,c=mu';

      nock(baseUrl)
        .delete(`/api/v1/ldap/users/${encodeURIComponent(dn)}`)
        .reply(403, 'Permission denied');

      try {
        await client.deleteResource(dn);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('Failed to delete users');
      }
    });
  });
});
