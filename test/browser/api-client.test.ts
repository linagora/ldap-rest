import { expect } from 'chai';
import nock from 'nock';

import { LdapApiClient } from '../../src/browser/ldap-tree-viewer/api/LdapApiClient';

describe('Browser LDAP API Client', () => {
  const baseUrl = 'http://localhost:8081';
  let client: LdapApiClient;

  beforeEach(() => {
    client = new LdapApiClient(baseUrl);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('getTopOrganization', () => {
    it('should fetch top organization', async () => {
      const mockResponse = {
        dn: 'ou=organization,dc=example,dc=com',
        ou: 'organization',
      };

      nock(baseUrl)
        .get('/api/v1/ldap/organizations/top')
        .reply(200, mockResponse);

      const result = await client.getTopOrganization();
      expect(result).to.deep.equal(mockResponse);
    });

    it('should throw error on failed request', async () => {
      nock(baseUrl)
        .get('/api/v1/ldap/organizations/top')
        .reply(404, 'Not Found');

      try {
        await client.getTopOrganization();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('404');
      }
    });
  });

  describe('getOrganization', () => {
    it('should fetch organization by DN', async () => {
      const dn = 'ou=test,ou=organization,dc=example,dc=com';
      const encodedDn = encodeURIComponent(dn);
      const mockResponse = {
        dn,
        ou: 'test',
      };

      nock(baseUrl)
        .get(`/api/v1/ldap/organizations/${encodedDn}`)
        .reply(200, mockResponse);

      const result = await client.getOrganization(dn);
      expect(result).to.deep.equal(mockResponse);
    });

    it('should properly encode DN with special characters', async () => {
      const dn = 'ou=Test & Dev,ou=organization,dc=example,dc=com';
      const encodedDn = encodeURIComponent(dn);
      const mockResponse = {
        dn,
        ou: 'Test & Dev',
      };

      nock(baseUrl)
        .get(`/api/v1/ldap/organizations/${encodedDn}`)
        .reply(200, mockResponse);

      const result = await client.getOrganization(dn);
      expect(result).to.deep.equal(mockResponse);
    });
  });

  describe('getOrganizationSubnodes', () => {
    it('should fetch organization subnodes', async () => {
      const dn = 'ou=test,ou=organization,dc=example,dc=com';
      const encodedDn = encodeURIComponent(dn);
      const mockResponse = [
        {
          dn: 'ou=child1,ou=test,ou=organization,dc=example,dc=com',
          type: 'organization',
        },
        { dn: 'uid=user1,ou=test,ou=organization,dc=example,dc=com', type: 'user' },
      ];

      nock(baseUrl)
        .get(`/api/v1/ldap/organizations/${encodedDn}/subnodes`)
        .reply(200, mockResponse);

      const result = await client.getOrganizationSubnodes(dn);
      expect(result).to.deep.equal(mockResponse);
    });

    it('should return empty array for organization with no subnodes', async () => {
      const dn = 'ou=empty,ou=organization,dc=example,dc=com';
      const encodedDn = encodeURIComponent(dn);

      nock(baseUrl)
        .get(`/api/v1/ldap/organizations/${encodedDn}/subnodes`)
        .reply(200, []);

      const result = await client.getOrganizationSubnodes(dn);
      expect(result).to.be.an('array').that.is.empty;
    });
  });

  describe('searchOrganizationSubnodes', () => {
    it('should search organization subnodes', async () => {
      const dn = 'ou=test,ou=organization,dc=example,dc=com';
      const query = 'john';
      const encodedDn = encodeURIComponent(dn);
      const encodedQuery = encodeURIComponent(query);
      const mockResponse = [
        { dn: 'uid=john.doe,ou=test,ou=organization,dc=example,dc=com', type: 'user' },
      ];

      nock(baseUrl)
        .get(
          `/api/v1/ldap/organizations/${encodedDn}/subnodes/search?q=${encodedQuery}`
        )
        .reply(200, mockResponse);

      const result = await client.searchOrganizationSubnodes(dn, query);
      expect(result).to.deep.equal(mockResponse);
    });

    it('should properly encode search query with special characters', async () => {
      const dn = 'ou=test,ou=organization,dc=example,dc=com';
      const query = 'test & dev';
      const encodedDn = encodeURIComponent(dn);
      const encodedQuery = encodeURIComponent(query);

      nock(baseUrl)
        .get(
          `/api/v1/ldap/organizations/${encodedDn}/subnodes/search?q=${encodedQuery}`
        )
        .reply(200, []);

      const result = await client.searchOrganizationSubnodes(dn, query);
      expect(result).to.be.an('array');
    });
  });

  describe('getUsers', () => {
    it('should fetch users without filter', async () => {
      const mockResponse = {
        entries: [
          { uid: 'user1', mail: 'user1@test.org' },
          { uid: 'user2', mail: 'user2@test.org' },
        ],
        total: 2,
      };

      nock(baseUrl).get('/api/v1/ldap/users').reply(200, mockResponse);

      const result = await client.getUsers();
      expect(result).to.deep.equal(mockResponse);
    });

    it('should fetch users with filter', async () => {
      const filter = 'john';
      const mockResponse = {
        entries: [{ uid: 'john.doe', mail: 'john@test.org' }],
        total: 1,
      };

      nock(baseUrl)
        .get(`/api/v1/ldap/users?filter=${encodeURIComponent(filter)}`)
        .reply(200, mockResponse);

      const result = await client.getUsers(filter);
      expect(result).to.deep.equal(mockResponse);
    });
  });

  describe('getGroups', () => {
    it('should fetch groups without filter', async () => {
      const mockResponse = {
        entries: [
          { cn: 'group1', mail: 'group1@test.org' },
          { cn: 'group2', mail: 'group2@test.org' },
        ],
        total: 2,
      };

      nock(baseUrl).get('/api/v1/ldap/groups').reply(200, mockResponse);

      const result = await client.getGroups();
      expect(result).to.deep.equal(mockResponse);
    });

    it('should fetch groups with filter', async () => {
      const filter = 'admin';
      const mockResponse = {
        entries: [{ cn: 'admins', mail: 'admins@test.org' }],
        total: 1,
      };

      nock(baseUrl)
        .get(`/api/v1/ldap/groups?filter=${encodeURIComponent(filter)}`)
        .reply(200, mockResponse);

      const result = await client.getGroups(filter);
      expect(result).to.deep.equal(mockResponse);
    });
  });

  describe('Authentication', () => {
    it('should include Authorization header when token is provided', async () => {
      const token = 'test-token-123';
      const clientWithAuth = new LdapApiClient(baseUrl, token);

      nock(baseUrl)
        .get('/api/v1/ldap/organizations/top')
        .matchHeader('Authorization', `Bearer ${token}`)
        .reply(200, { dn: 'ou=org,dc=example,dc=com' });

      await clientWithAuth.getTopOrganization();
    });

    it('should not include Authorization header when no token', async () => {
      nock(baseUrl)
        .get('/api/v1/ldap/organizations/top')
        .matchHeader('Authorization', val => val === undefined)
        .reply(200, { dn: 'ou=org,dc=example,dc=com' });

      await client.getTopOrganization();
    });
  });

  describe('Error handling', () => {
    it('should handle 500 server errors', async () => {
      nock(baseUrl)
        .get('/api/v1/ldap/organizations/top')
        .reply(500, 'Internal Server Error');

      try {
        await client.getTopOrganization();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('500');
      }
    });

    it('should handle network errors', async () => {
      nock(baseUrl)
        .get('/api/v1/ldap/organizations/top')
        .replyWithError('Network error');

      try {
        await client.getTopOrganization();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
      }
    });
  });
});
