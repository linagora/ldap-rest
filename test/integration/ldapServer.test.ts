/**
 * Integration test for embedded LDAP server
 * Validates that the test LDAP server works correctly
 */

import { expect } from 'chai';
import { getTestLdapServer } from '../helpers/testSetup';
import { hasExternalLdap } from '../helpers/env';

describe('LDAP Test Server Integration', function () {
  // These tests validate the test infrastructure itself
  // Skip all tests if using external LDAP
  before(function () {
    if (hasExternalLdap()) {
      console.warn('Skipping LDAP Test Server Integration: using external LDAP');
      this.skip();
    }
  });

  it('should have started the LDAP server', function () {
    const server = getTestLdapServer();
    expect(server).to.exist;
    expect(server.port).to.be.a('number');
    expect(server.port).to.be.greaterThan(0);
  });

  it('should have set environment variables', function () {
    expect(process.env.DM_LDAP_URI).to.exist;
    expect(process.env.DM_LDAP_DN).to.exist;
    expect(process.env.DM_LDAP_PWD).to.exist;
    expect(process.env.DM_LDAP_BASE).to.equal('dc=example,dc=com');
  });

  it('should have loaded base structure', async function () {
    const server = getTestLdapServer();

    // Search for users branch
    const result = await server.search('(ou=users)', ['ou']);
    expect(result).to.include('ou=users');
  });

  it('should have test users in B2C branch', async function () {
    const server = getTestLdapServer();

    // Search for john.doe
    const result = await server.search('(uid=john.doe)', ['cn', 'mail']);
    expect(result).to.include('uid=john.doe');
    expect(result).to.include('cn: John Doe');
    expect(result).to.include('mail: john.doe@example.com');
  });

  it('should be able to load additional LDIF data', async function () {
    const server = getTestLdapServer();

    // Load B2B organizations
    const ldif = `
dn: uid=test-dynamic,ou=users,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: organizationalPerson
objectClass: person
uid: test-dynamic
cn: Test Dynamic
sn: Dynamic
mail: test-dynamic@example.com
userPassword: password123
`;

    await server.loadLdif(ldif);

    // Verify it was loaded
    const result = await server.search('(uid=test-dynamic)', ['cn']);
    expect(result).to.include('uid=test-dynamic');
    expect(result).to.include('cn: Test Dynamic');

    // Cleanup (optional - server is torn down after all tests anyway)
    try {
      await server.search('(uid=test-dynamic)', ['cn']);
      // If we want to clean up, we'd need to add a delete method
      // For now, the global teardown handles cleanup
    } catch (err) {
      // Ignore
    }
  });

  it('should have nomenclature data', async function () {
    const server = getTestLdapServer();

    // Check for title nomenclature
    const result = await server.search(
      '(cn=Dr)',
      ['cn', 'description']
    );
    expect(result).to.include('cn=Dr');
    expect(result).to.include('description: Doctor');
  });

  it('should have test groups', async function () {
    const server = getTestLdapServer();

    // Check for admins group
    const result = await server.search('(cn=admins)', ['cn', 'member']);
    expect(result).to.include('cn=admins');
    expect(result).to.include('member: uid=john.doe,ou=users,dc=example,dc=com');
  });
});
