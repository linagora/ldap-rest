/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class ResourceMapperTest {

    @Test
    void rdnValueExtractsSimpleUid() {
        assertEquals("alice", ResourceMapper.rdnValue("uid=alice,ou=users,dc=ex,dc=org"));
    }

    @Test
    void rdnValueExtractsCn() {
        assertEquals("admins", ResourceMapper.rdnValue("cn=admins,ou=groups,dc=ex,dc=org"));
    }

    @Test
    void rdnValueOnBareValue() {
        assertEquals("alice", ResourceMapper.rdnValue("alice"));
    }

    @Test
    void rdnValueHandlesEscapedComma() {
        assertEquals("Doe\\, John",
                ResourceMapper.rdnValue("cn=Doe\\, John,ou=users,dc=ex,dc=org"));
    }

    @Test
    void rdnValueTrimsWhitespace() {
        assertEquals("alice", ResourceMapper.rdnValue("uid= alice ,ou=x"));
    }

    @Test
    void parentDnReturnsTail() {
        assertEquals("ou=users,dc=ex,dc=org",
                ResourceMapper.parentDn("uid=alice,ou=users,dc=ex,dc=org"));
    }

    @Test
    void parentDnEmptyForRdnOnly() {
        assertEquals("", ResourceMapper.parentDn("uid=alice"));
    }

    @Test
    void firstRdnHandlesEscapedComma() {
        assertEquals("cn=Doe\\, John",
                ResourceMapper.firstRdn("cn=Doe\\, John,ou=users,dc=ex,dc=org"));
    }

    @Test
    void collectionPathFlat() {
        ResourceMapper m = new ResourceMapper("users");
        assertEquals("/api/v1/ldap/users", m.collectionPath());
    }

    @Test
    void itemPathFlatUsesRdnValue() {
        ResourceMapper m = new ResourceMapper("users");
        assertEquals("/api/v1/ldap/users/alice",
                m.itemPath("uid=alice,ou=users,dc=ex,dc=org"));
    }

    @Test
    void itemPathOrgUsesEncodedDn() {
        ResourceMapper m = new ResourceMapper("organizations");
        String got = m.itemPath("ou=sales,dc=ex,dc=org");
        // commas and equals are URL-encoded
        assertEquals("/api/v1/ldap/organizations/ou%3Dsales%2Cdc%3Dex%2Cdc%3Dorg", got);
    }

    @Test
    void movePathFlat() {
        ResourceMapper m = new ResourceMapper("users");
        assertEquals("/api/v1/ldap/users/alice/move",
                m.movePath("uid=alice,ou=users"));
    }

    @Test
    void renamePathOnlyForGroups() {
        ResourceMapper g = new ResourceMapper("groups");
        assertEquals("/api/v1/ldap/groups/admins/rename",
                g.renamePath("cn=admins,ou=groups"));
        ResourceMapper u = new ResourceMapper("users");
        assertThrows(IllegalStateException.class, () -> u.renamePath("uid=x"));
    }

    @Test
    void membersPath() {
        ResourceMapper g = new ResourceMapper("groups");
        assertEquals("/api/v1/ldap/groups/admins/members",
                g.membersPath("cn=admins,ou=groups"));
    }

    @Test
    void memberItemPathEncodesMemberDn() {
        ResourceMapper g = new ResourceMapper("groups");
        String p = g.memberItemPath("cn=admins,ou=groups", "uid=alice,ou=users,dc=ex,dc=org");
        assertEquals(
                "/api/v1/ldap/groups/admins/members/uid%3Dalice%2Cou%3Dusers%2Cdc%3Dex%2Cdc%3Dorg",
                p);
    }

    @Test
    void resourceTypeIsCaseInsensitive() {
        ResourceMapper m = new ResourceMapper("Groups");
        assertEquals(ResourceMapper.Family.GROUPS, m.getFamily());
    }
}
