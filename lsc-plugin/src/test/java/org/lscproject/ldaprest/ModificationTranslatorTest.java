/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.lsc.LscDatasetModification;
import org.lsc.LscDatasetModification.LscDatasetModificationType;
import org.lsc.LscModificationType;
import org.lsc.LscModifications;
import org.lsc.exception.LscServiceException;

import com.fasterxml.jackson.databind.ObjectMapper;

class ModificationTranslatorTest {

    private static final ObjectMapper M = new ObjectMapper();

    private LscModifications mods(LscModificationType op, String mainId,
                                  LscDatasetModification... attrs) {
        LscModifications m = new LscModifications(op, "test-task");
        m.setMainIdentifer(mainId);
        m.setLscAttributeModifications(Arrays.asList(attrs));
        return m;
    }

    private LscDatasetModification attr(LscDatasetModificationType op, String name, Object... vals) {
        return new LscDatasetModification(op, name, Arrays.asList(vals));
    }

    private Map<?, ?> parse(String json) throws Exception {
        return M.readValue(json, Map.class);
    }

    // ---------------- CREATE ----------------
    @Test
    void createFlatSingleValue() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.CREATE_OBJECT, "uid=alice,ou=users",
                attr(LscDatasetModificationType.REPLACE_VALUES, "uid", "alice"),
                attr(LscDatasetModificationType.REPLACE_VALUES, "sn", "Doe"));
        String json = t.buildCreateBody(lm);
        Map<?, ?> m = parse(json);
        assertEquals("alice", m.get("uid"));
        assertEquals("Doe", m.get("sn"));
    }

    @Test
    void createFlatMultiValueAsArray() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.CREATE_OBJECT, "uid=bob",
                attr(LscDatasetModificationType.REPLACE_VALUES, "objectClass", "top", "person"));
        String json = t.buildCreateBody(lm);
        Map<?, ?> m = parse(json);
        assertEquals(Arrays.asList("top", "person"), m.get("objectClass"));
    }

    @Test
    void createGroup() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("groups"));
        LscModifications lm = mods(LscModificationType.CREATE_OBJECT, "cn=admins,ou=groups",
                attr(LscDatasetModificationType.REPLACE_VALUES, "cn", "admins"),
                attr(LscDatasetModificationType.REPLACE_VALUES, "description", "Administrators"),
                attr(LscDatasetModificationType.REPLACE_VALUES, "member",
                        "uid=alice,ou=users", "uid=bob,ou=users"));
        String json = t.buildCreateBody(lm);
        Map<?, ?> m = parse(json);
        assertEquals("admins", m.get("cn"));
        assertEquals("Administrators", m.get("description"));
        assertEquals(Arrays.asList("uid=alice,ou=users", "uid=bob,ou=users"), m.get("member"));
    }

    @Test
    void createOrganization() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("organizations"));
        LscModifications lm = mods(LscModificationType.CREATE_OBJECT, "ou=sales,dc=ex,dc=org",
                attr(LscDatasetModificationType.REPLACE_VALUES, "ou", "sales"),
                attr(LscDatasetModificationType.REPLACE_VALUES, "description", "Sales team"));
        String json = t.buildCreateBody(lm);
        Map<?, ?> m = parse(json);
        assertEquals("sales", m.get("ou"));
        assertEquals("Sales team", m.get("description"));
    }

    // ---------------- UPDATE ----------------
    @Test
    void updateReplaceOnly() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.UPDATE_OBJECT, "uid=alice,ou=users",
                attr(LscDatasetModificationType.REPLACE_VALUES, "sn", "NewName"));
        Map<?, ?> m = parse(t.buildUpdateBody(lm));
        assertTrue(m.containsKey("replace"));
        Map<?, ?> rep = (Map<?, ?>) m.get("replace");
        assertEquals(Collections.singletonList("NewName"), rep.get("sn"));
        assertTrue(!m.containsKey("add"));
        assertTrue(!m.containsKey("delete"));
    }

    @Test
    void updateAddOnly() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.UPDATE_OBJECT, "uid=alice",
                attr(LscDatasetModificationType.ADD_VALUES, "mail", "a@x.fr"));
        Map<?, ?> m = parse(t.buildUpdateBody(lm));
        assertTrue(m.containsKey("add"));
        Map<?, ?> add = (Map<?, ?>) m.get("add");
        assertEquals(Collections.singletonList("a@x.fr"), add.get("mail"));
    }

    @Test
    void updateDeleteAttributeWide() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.UPDATE_OBJECT, "uid=alice",
                new LscDatasetModification(LscDatasetModificationType.DELETE_VALUES,
                        "telephoneNumber", Collections.emptyList()));
        Map<?, ?> m = parse(t.buildUpdateBody(lm));
        assertEquals(Collections.singletonList("telephoneNumber"), m.get("delete"));
    }

    @Test
    void updateDeleteSpecificValues() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.UPDATE_OBJECT, "uid=alice",
                attr(LscDatasetModificationType.DELETE_VALUES, "mail", "old@x.fr"));
        Map<?, ?> m = parse(t.buildUpdateBody(lm));
        Map<?, ?> del = (Map<?, ?>) m.get("delete");
        assertEquals(Collections.singletonList("old@x.fr"), del.get("mail"));
    }

    @Test
    void updateMixReplaceAddDelete() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.UPDATE_OBJECT, "uid=alice",
                attr(LscDatasetModificationType.REPLACE_VALUES, "sn", "Doe"),
                attr(LscDatasetModificationType.ADD_VALUES, "mail", "n@x.fr"),
                attr(LscDatasetModificationType.DELETE_VALUES, "mail", "o@x.fr"),
                new LscDatasetModification(LscDatasetModificationType.DELETE_VALUES,
                        "telephoneNumber", Collections.emptyList()));
        Map<?, ?> m = parse(t.buildUpdateBody(lm));
        assertTrue(m.containsKey("replace"));
        assertTrue(m.containsKey("add"));
        // delete merged: telephoneNumber → [], mail → [o@x.fr]
        Map<?, ?> del = (Map<?, ?>) m.get("delete");
        assertEquals(Collections.singletonList("o@x.fr"), del.get("mail"));
        assertEquals(Collections.emptyList(), del.get("telephoneNumber"));
    }

    @Test
    void updateGroupShape() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("groups"));
        LscModifications lm = mods(LscModificationType.UPDATE_OBJECT, "cn=admins",
                attr(LscDatasetModificationType.REPLACE_VALUES, "description", "New desc"));
        Map<?, ?> m = parse(t.buildUpdateBody(lm));
        Map<?, ?> rep = (Map<?, ?>) m.get("replace");
        assertEquals(Collections.singletonList("New desc"), rep.get("description"));
    }

    @Test
    void updateOrgShape() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("organizations"));
        LscModifications lm = mods(LscModificationType.UPDATE_OBJECT, "ou=sales,dc=ex,dc=org",
                attr(LscDatasetModificationType.REPLACE_VALUES, "description", "Updated"));
        Map<?, ?> m = parse(t.buildUpdateBody(lm));
        assertTrue(m.containsKey("replace"));
    }

    // ---------------- MODRDN ----------------
    @Test
    void modrdnFlatProducesMoveTargetOrgDn() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.CHANGE_ID, "uid=alice,ou=users,dc=ex,dc=org");
        lm.setNewMainIdentifier("uid=alice,ou=admins,dc=ex,dc=org");
        ModificationTranslator.ModrdnPayload p = t.buildModrdnPayload(lm);
        assertEquals(ModificationTranslator.ModrdnKind.MOVE, p.kind);
        Map<?, ?> m = parse(p.body);
        assertEquals("ou=admins,dc=ex,dc=org", m.get("targetOrgDn"));
    }

    @Test
    void modrdnGroupSameParentProducesRename() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("groups"));
        LscModifications lm = mods(LscModificationType.CHANGE_ID, "cn=oldname,ou=groups,dc=ex,dc=org");
        lm.setNewMainIdentifier("cn=newname,ou=groups,dc=ex,dc=org");
        ModificationTranslator.ModrdnPayload p = t.buildModrdnPayload(lm);
        assertEquals(ModificationTranslator.ModrdnKind.RENAME, p.kind);
        Map<?, ?> m = parse(p.body);
        assertEquals("newname", m.get("newCn"));
    }

    @Test
    void modrdnGroupDifferentParentProducesMove() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("groups"));
        LscModifications lm = mods(LscModificationType.CHANGE_ID, "cn=admins,ou=groups,dc=ex,dc=org");
        lm.setNewMainIdentifier("cn=admins,ou=other,dc=ex,dc=org");
        ModificationTranslator.ModrdnPayload p = t.buildModrdnPayload(lm);
        assertEquals(ModificationTranslator.ModrdnKind.MOVE, p.kind);
    }

    @Test
    void modrdnOrgProducesMove() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("organizations"));
        LscModifications lm = mods(LscModificationType.CHANGE_ID, "ou=sales,dc=ex,dc=org");
        lm.setNewMainIdentifier("ou=sales,ou=parent,dc=ex,dc=org");
        ModificationTranslator.ModrdnPayload p = t.buildModrdnPayload(lm);
        assertEquals(ModificationTranslator.ModrdnKind.MOVE, p.kind);
        Map<?, ?> m = parse(p.body);
        assertEquals("ou=parent,dc=ex,dc=org", m.get("targetOrgDn"));
    }

    @Test
    void modrdnFailsWithoutNewMainIdentifier() {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.CHANGE_ID, "uid=alice");
        assertThrows(LscServiceException.class, () -> t.buildModrdnPayload(lm));
    }

    // ---------------- BINARY ----------------
    @Test
    void binaryAttributeRejected() {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        byte[] notUtf8 = new byte[] { (byte) 0xff, (byte) 0xfe, (byte) 0xc3, 0x28 };
        LscModifications lm = mods(LscModificationType.CREATE_OBJECT, "uid=alice",
                new LscDatasetModification(LscDatasetModificationType.REPLACE_VALUES,
                        "jpegPhoto", java.util.Collections.singletonList(notUtf8)));
        LscServiceException ex = assertThrows(LscServiceException.class, () -> t.buildCreateBody(lm));
        assertTrue(ex.getMessage().contains("binary"));
        assertTrue(ex.getMessage().contains("jpegPhoto"));
    }

    @Test
    void utf8BinaryIsAcceptedAsString() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        byte[] utf8 = "héllo".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        LscModifications lm = mods(LscModificationType.CREATE_OBJECT, "uid=alice",
                new LscDatasetModification(LscDatasetModificationType.REPLACE_VALUES,
                        "description", java.util.Collections.singletonList(utf8)));
        Map<?, ?> m = parse(t.buildCreateBody(lm));
        assertEquals("héllo", m.get("description"));
    }

    // ---------------- JSON shape (signature stability) ----------------
    @Test
    void jsonOutputIsCompactNoExtraSpaces() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        LscModifications lm = mods(LscModificationType.CREATE_OBJECT, "uid=alice",
                attr(LscDatasetModificationType.REPLACE_VALUES, "uid", "alice"));
        String json = t.buildCreateBody(lm);
        // No pretty print: no spaces after ':' or ','
        assertEquals("{\"uid\":\"alice\"}", json);
    }

    @Test
    void jsonOutputPreservesInsertionOrder() throws Exception {
        ModificationTranslator t = new ModificationTranslator(new ResourceMapper("users"));
        // Insertion order matters for HMAC stability
        LscModifications lm = mods(LscModificationType.CREATE_OBJECT, "uid=alice",
                attr(LscDatasetModificationType.REPLACE_VALUES, "z", "1"),
                attr(LscDatasetModificationType.REPLACE_VALUES, "a", "2"));
        assertEquals("{\"z\":\"1\",\"a\":\"2\"}", t.buildCreateBody(lm));
    }

    @Test
    void writeJsonHelperIsCompact() throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("a", 1);
        body.put("b", "two");
        assertEquals("{\"a\":1,\"b\":\"two\"}", ModificationTranslator.writeJson(body));
    }
}
