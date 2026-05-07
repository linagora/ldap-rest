/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.delete;
import static com.github.tomakehurst.wiremock.client.WireMock.deleteRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.put;
import static com.github.tomakehurst.wiremock.client.WireMock.putRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.Collections;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.lsc.LscDatasetModification;
import org.lsc.LscDatasetModification.LscDatasetModificationType;
import org.lsc.LscModificationType;
import org.lsc.LscModifications;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;

class LdapRestDstServiceIntegrationTest {

    private WireMockServer server;
    private String baseUrl;

    @BeforeEach
    void start() {
        server = new WireMockServer(WireMockConfiguration.options().dynamicPort());
        server.start();
        baseUrl = "http://127.0.0.1:" + server.port();
    }

    @AfterEach
    void stop() {
        if (server != null) server.stop();
    }

    private LdapRestDstService usersService() {
        ResourceMapper mapper = new ResourceMapper("users");
        LdapRestClient client = new LdapRestClient(baseUrl, new BearerAuth("t"), 5000, 0);
        return new LdapRestDstService(client, mapper);
    }

    private LdapRestDstService groupsService() {
        ResourceMapper mapper = new ResourceMapper("groups");
        LdapRestClient client = new LdapRestClient(baseUrl, new BearerAuth("t"), 5000, 0);
        return new LdapRestDstService(client, mapper);
    }

    private LdapRestDstService orgsService() {
        ResourceMapper mapper = new ResourceMapper("organizations");
        LdapRestClient client = new LdapRestClient(baseUrl, new BearerAuth("t"), 5000, 0);
        return new LdapRestDstService(client, mapper);
    }

    private LscModifications lm(LscModificationType op, String main) {
        LscModifications m = new LscModifications(op, "task");
        m.setMainIdentifer(main);
        return m;
    }

    private LscDatasetModification rep(String name, Object... vals) {
        return new LscDatasetModification(LscDatasetModificationType.REPLACE_VALUES,
                name, Arrays.asList(vals));
    }

    private LscDatasetModification add(String name, Object... vals) {
        return new LscDatasetModification(LscDatasetModificationType.ADD_VALUES,
                name, Arrays.asList(vals));
    }

    private LscDatasetModification del(String name, Object... vals) {
        return new LscDatasetModification(LscDatasetModificationType.DELETE_VALUES,
                name, Arrays.asList(vals));
    }

    @Test
    void createUserPostsCollection() throws Exception {
        server.stubFor(post(urlEqualTo("/api/v1/ldap/users"))
                .willReturn(aResponse().withStatus(201).withBody("{}")));
        LscModifications m = lm(LscModificationType.CREATE_OBJECT, "uid=alice,ou=users,dc=ex,dc=org");
        m.setLscAttributeModifications(Arrays.asList(
                rep("uid", "alice"),
                rep("sn", "Doe"),
                rep("cn", "Alice Doe")));
        assertTrue(usersService().apply(m));
        server.verify(postRequestedFor(urlEqualTo("/api/v1/ldap/users"))
                .withRequestBody(equalToJson("{\"uid\":\"alice\",\"sn\":\"Doe\",\"cn\":\"Alice Doe\"}"))
                .withHeader("Authorization", equalTo("Bearer t")));
    }

    @Test
    void updateUserPutsItem() throws Exception {
        server.stubFor(put(urlEqualTo("/api/v1/ldap/users/alice"))
                .willReturn(aResponse().withStatus(200).withBody("{}")));
        LscModifications m = lm(LscModificationType.UPDATE_OBJECT, "uid=alice,ou=users,dc=ex,dc=org");
        m.setLscAttributeModifications(Arrays.asList(
                rep("sn", "NewName"),
                add("mail", "a@x.fr"),
                del("description")));
        assertTrue(usersService().apply(m));
        server.verify(putRequestedFor(urlEqualTo("/api/v1/ldap/users/alice"))
                .withRequestBody(equalToJson(
                        "{\"replace\":{\"sn\":[\"NewName\"]},\"add\":{\"mail\":[\"a@x.fr\"]},\"delete\":[\"description\"]}")));
    }

    @Test
    void deleteUser() throws Exception {
        server.stubFor(delete(urlEqualTo("/api/v1/ldap/users/alice"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.DELETE_OBJECT, "uid=alice,ou=users,dc=ex,dc=org");
        assertTrue(usersService().apply(m));
        server.verify(deleteRequestedFor(urlEqualTo("/api/v1/ldap/users/alice")));
    }

    @Test
    void deleteUser404IsTreatedAsSuccess() throws Exception {
        server.stubFor(delete(urlEqualTo("/api/v1/ldap/users/ghost"))
                .willReturn(aResponse().withStatus(404).withBody("{\"error\":\"not found\"}")));
        LscModifications m = lm(LscModificationType.DELETE_OBJECT, "uid=ghost,ou=users,dc=ex,dc=org");
        assertTrue(usersService().apply(m));
    }

    @Test
    void modrdnUserCallsMove() throws Exception {
        server.stubFor(post(urlEqualTo("/api/v1/ldap/users/alice/move"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.CHANGE_ID, "uid=alice,ou=users,dc=ex,dc=org");
        m.setNewMainIdentifier("uid=alice,ou=admins,dc=ex,dc=org");
        assertTrue(usersService().apply(m));
        server.verify(postRequestedFor(urlEqualTo("/api/v1/ldap/users/alice/move"))
                .withRequestBody(equalToJson("{\"targetOrgDn\":\"ou=admins,dc=ex,dc=org\"}")));
    }

    @Test
    void createGroupPostsCollection() throws Exception {
        server.stubFor(post(urlEqualTo("/api/v1/ldap/groups"))
                .willReturn(aResponse().withStatus(201)));
        LscModifications m = lm(LscModificationType.CREATE_OBJECT, "cn=admins,ou=groups,dc=ex,dc=org");
        m.setLscAttributeModifications(Arrays.asList(
                rep("cn", "admins"),
                rep("description", "Admins"),
                rep("member", "uid=alice,ou=users,dc=ex,dc=org")));
        assertTrue(groupsService().apply(m));
        server.verify(postRequestedFor(urlEqualTo("/api/v1/ldap/groups"))
                .withRequestBody(equalToJson(
                        "{\"cn\":\"admins\",\"description\":\"Admins\",\"member\":\"uid=alice,ou=users,dc=ex,dc=org\"}")));
    }

    @Test
    void updateGroupAddMemberUsesMembersEndpoint() throws Exception {
        server.stubFor(post(urlEqualTo("/api/v1/ldap/groups/admins/members"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.UPDATE_OBJECT, "cn=admins,ou=groups,dc=ex,dc=org");
        m.setLscAttributeModifications(Collections.singletonList(
                add("member", "uid=alice,ou=users,dc=ex,dc=org")));
        assertTrue(groupsService().apply(m));
        server.verify(postRequestedFor(urlEqualTo("/api/v1/ldap/groups/admins/members"))
                .withRequestBody(equalToJson(
                        "{\"member\":\"uid=alice,ou=users,dc=ex,dc=org\"}")));
    }

    @Test
    void updateGroupDeleteMemberUsesMembersEndpoint() throws Exception {
        server.stubFor(delete(urlEqualTo("/api/v1/ldap/groups/admins/members/uid%3Dalice%2Cou%3Dusers%2Cdc%3Dex%2Cdc%3Dorg"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.UPDATE_OBJECT, "cn=admins,ou=groups,dc=ex,dc=org");
        m.setLscAttributeModifications(Collections.singletonList(
                del("member", "uid=alice,ou=users,dc=ex,dc=org")));
        assertTrue(groupsService().apply(m));
    }

    @Test
    void updateGroupNonMemberAttributeUsesPut() throws Exception {
        server.stubFor(put(urlEqualTo("/api/v1/ldap/groups/admins"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.UPDATE_OBJECT, "cn=admins,ou=groups,dc=ex,dc=org");
        m.setLscAttributeModifications(Collections.singletonList(
                rep("description", "New Description")));
        assertTrue(groupsService().apply(m));
        server.verify(putRequestedFor(urlEqualTo("/api/v1/ldap/groups/admins"))
                .withRequestBody(equalToJson(
                        "{\"replace\":{\"description\":[\"New Description\"]}}")));
    }

    @Test
    void deleteGroup() throws Exception {
        server.stubFor(delete(urlEqualTo("/api/v1/ldap/groups/admins"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.DELETE_OBJECT, "cn=admins,ou=groups,dc=ex,dc=org");
        assertTrue(groupsService().apply(m));
    }

    @Test
    void renameGroupUsesRenameEndpoint() throws Exception {
        server.stubFor(post(urlEqualTo("/api/v1/ldap/groups/oldcn/rename"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.CHANGE_ID, "cn=oldcn,ou=groups,dc=ex,dc=org");
        m.setNewMainIdentifier("cn=newcn,ou=groups,dc=ex,dc=org");
        assertTrue(groupsService().apply(m));
        server.verify(postRequestedFor(urlEqualTo("/api/v1/ldap/groups/oldcn/rename"))
                .withRequestBody(equalToJson("{\"newCn\":\"newcn\"}")));
    }

    @Test
    void createOrganizationPostsCollection() throws Exception {
        server.stubFor(post(urlEqualTo("/api/v1/ldap/organizations"))
                .willReturn(aResponse().withStatus(201)));
        LscModifications m = lm(LscModificationType.CREATE_OBJECT, "ou=sales,dc=ex,dc=org");
        m.setLscAttributeModifications(Arrays.asList(
                rep("ou", "sales"),
                rep("description", "Sales")));
        assertTrue(orgsService().apply(m));
        server.verify(postRequestedFor(urlEqualTo("/api/v1/ldap/organizations"))
                .withRequestBody(equalToJson("{\"ou\":\"sales\",\"description\":\"Sales\"}")));
    }

    @Test
    void deleteOrganizationUsesEncodedDn() throws Exception {
        server.stubFor(delete(urlEqualTo("/api/v1/ldap/organizations/ou%3Dsales%2Cdc%3Dex%2Cdc%3Dorg"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.DELETE_OBJECT, "ou=sales,dc=ex,dc=org");
        assertTrue(orgsService().apply(m));
    }

    @Test
    void updateOrganizationPutsEncodedDn() throws Exception {
        server.stubFor(put(urlEqualTo("/api/v1/ldap/organizations/ou%3Dsales%2Cdc%3Dex%2Cdc%3Dorg"))
                .willReturn(aResponse().withStatus(200)));
        LscModifications m = lm(LscModificationType.UPDATE_OBJECT, "ou=sales,dc=ex,dc=org");
        m.setLscAttributeModifications(Collections.singletonList(rep("description", "Up")));
        assertTrue(orgsService().apply(m));
    }

    @Test
    void readMethodsAreEmpty() throws Exception {
        LdapRestDstService svc = usersService();
        assertEquals(null, svc.getBean("alice", new org.lsc.LscDatasets(), false));
        assertTrue(svc.getListPivots().isEmpty());
        assertTrue(svc.getSupportedConnectionType().isEmpty());
        assertTrue(svc.getWriteDatasetIds().isEmpty());
    }
}
