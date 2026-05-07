/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

import org.junit.jupiter.api.Test;
import org.lsc.configuration.PluginDestinationServiceType;
import org.lsc.configuration.TaskType;
import org.lsc.exception.LscServiceException;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

class LdapRestDstServiceConfigTest {

    /**
     * Build a TaskType where {@code getPluginDestinationService().getAny()}
     * returns the given DOM elements.
     */
    private TaskType taskWithConfig(String xmlBody) throws Exception {
        String xml = "<root xmlns=\"http://lsc-project.org/XSD/lsc-core-2.2.xsd\">"
                + xmlBody + "</root>";
        DocumentBuilder db = DocumentBuilderFactory.newInstance().newDocumentBuilder();
        Document doc = db.parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
        NodeList children = doc.getDocumentElement().getChildNodes();
        List<Object> any = new ArrayList<>();
        for (int i = 0; i < children.getLength(); i++) {
            if (children.item(i) instanceof Element) {
                any.add(children.item(i));
            }
        }
        TaskType task = new TaskType();
        PluginDestinationServiceType plugin = new PluginDestinationServiceType();
        // Inject the parsed elements via reflection on the JAXB any list.
        // PluginDestinationServiceType.getAny() returns the underlying mutable list.
        Method getAny = plugin.getClass().getMethod("getAny");
        @SuppressWarnings("unchecked")
        List<Object> live = (List<Object>) getAny.invoke(plugin);
        live.addAll(any);
        // task.setPluginDestinationService(plugin)
        task.setPluginDestinationService(plugin);
        return task;
    }

    @Test
    void parsesBaseUrlAndResourceTypeAndBearer() throws Exception {
        TaskType task = taskWithConfig(
                "<baseUrl>https://api.test/</baseUrl>"
                        + "<resourceType>users</resourceType>"
                        + "<auth><bearer>tok</bearer></auth>"
                        + "<timeoutMs>2500</timeoutMs>"
                        + "<retries>5</retries>");
        LdapRestDstService.Config cfg = LdapRestDstService.parseConfig(task);
        assertEquals("https://api.test/", cfg.baseUrl);
        assertEquals("users", cfg.resourceType);
        assertEquals(2500L, cfg.timeoutMs);
        assertEquals(5, cfg.retries);
        assertTrue(cfg.auth instanceof BearerAuth);
    }

    @Test
    void parsesHmacAuth() throws Exception {
        TaskType task = taskWithConfig(
                "<baseUrl>https://api.test</baseUrl>"
                        + "<resourceType>groups</resourceType>"
                        + "<auth>"
                        + "  <hmacServiceId>lsc</hmacServiceId>"
                        + "  <hmacSecret>secret-32-chars-min-aaaaaaaaaaaaa</hmacSecret>"
                        + "</auth>");
        LdapRestDstService.Config cfg = LdapRestDstService.parseConfig(task);
        assertTrue(cfg.auth instanceof HmacAuth);
    }

    @Test
    void requiresBaseUrl() throws Exception {
        TaskType task = taskWithConfig(
                "<resourceType>users</resourceType>"
                        + "<auth><bearer>t</bearer></auth>");
        LscServiceException ex = assertThrows(LscServiceException.class,
                () -> LdapRestDstService.parseConfig(task));
        assertTrue(ex.getMessage().contains("baseUrl"));
    }

    @Test
    void requiresResourceType() throws Exception {
        TaskType task = taskWithConfig(
                "<baseUrl>https://api.test</baseUrl>"
                        + "<auth><bearer>t</bearer></auth>");
        LscServiceException ex = assertThrows(LscServiceException.class,
                () -> LdapRestDstService.parseConfig(task));
        assertTrue(ex.getMessage().contains("resourceType"));
    }

    @Test
    void requiresAuth() throws Exception {
        TaskType task = taskWithConfig(
                "<baseUrl>https://api.test</baseUrl>"
                        + "<resourceType>users</resourceType>");
        LscServiceException ex = assertThrows(LscServiceException.class,
                () -> LdapRestDstService.parseConfig(task));
        assertTrue(ex.getMessage().contains("auth"));
    }

    @Test
    void requiresAuthCredentials() throws Exception {
        TaskType task = taskWithConfig(
                "<baseUrl>https://api.test</baseUrl>"
                        + "<resourceType>users</resourceType>"
                        + "<auth></auth>");
        LscServiceException ex = assertThrows(LscServiceException.class,
                () -> LdapRestDstService.parseConfig(task));
        assertTrue(ex.getMessage().contains("bearer") || ex.getMessage().contains("hmac"));
    }

    @Test
    void defaultsAreApplied() throws Exception {
        TaskType task = taskWithConfig(
                "<baseUrl>https://api.test</baseUrl>"
                        + "<resourceType>users</resourceType>"
                        + "<auth><bearer>t</bearer></auth>");
        LdapRestDstService.Config cfg = LdapRestDstService.parseConfig(task);
        assertEquals(10_000L, cfg.timeoutMs);
        assertEquals(3, cfg.retries);
        assertEquals("/api", cfg.apiPrefix);
    }
}
