/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Objects;

/**
 * Routes LSC operations to the right ldap-rest endpoint depending on
 * the configured resource type, and parses LSC-style DNs into
 * identifiers usable on the wire.
 *
 * <p>Three resource families are supported:</p>
 * <ul>
 *     <li>{@code groups} — endpoints under {@code /groups}, identified
 *         by the bare {@code cn} value.</li>
 *     <li>{@code organizations} — endpoints under {@code /organizations},
 *         identified by the URL-encoded full DN.</li>
 *     <li>everything else (e.g. {@code users}) — flat resources where
 *         the identifier is the RDN value (e.g. {@code uid=alice}'s
 *         {@code alice}).</li>
 * </ul>
 */
public class ResourceMapper {

    public enum Family { GROUPS, ORGANIZATIONS, FLAT }

    private final String resourceType;
    private final Family family;
    private final String apiPrefix;

    public ResourceMapper(String resourceType) {
        this(resourceType, "/api");
    }

    public ResourceMapper(String resourceType, String apiPrefix) {
        this.resourceType = Objects.requireNonNull(resourceType, "resourceType").toLowerCase(Locale.ROOT);
        this.apiPrefix = Objects.requireNonNull(apiPrefix, "apiPrefix");
        switch (this.resourceType) {
            case "groups":
                this.family = Family.GROUPS;
                break;
            case "organizations":
                this.family = Family.ORGANIZATIONS;
                break;
            default:
                this.family = Family.FLAT;
        }
    }

    public String getResourceType() {
        return resourceType;
    }

    public Family getFamily() {
        return family;
    }

    /** {@code /api/v1/ldap/{resource}} — for CREATE. */
    public String collectionPath() {
        return apiPrefix + "/v1/ldap/" + resourceType;
    }

    /** {@code /api/v1/ldap/{resource}/{id}} — for UPDATE/DELETE. */
    public String itemPath(String dn) {
        return collectionPath() + "/" + encodeId(dn);
    }

    /** {@code /api/v1/ldap/{resource}/{id}/move} — for MODRDN flat/org. */
    public String movePath(String dn) {
        return itemPath(dn) + "/move";
    }

    /** {@code /api/v1/ldap/groups/{cn}/rename} — for MODRDN groups. */
    public String renamePath(String dn) {
        if (family != Family.GROUPS) {
            throw new IllegalStateException("rename is only valid for groups");
        }
        return itemPath(dn) + "/rename";
    }

    /** {@code /api/v1/ldap/groups/{cn}/members} — group member add. */
    public String membersPath(String dn) {
        if (family != Family.GROUPS) {
            throw new IllegalStateException("members is only valid for groups");
        }
        return itemPath(dn) + "/members";
    }

    /** {@code /api/v1/ldap/groups/{cn}/members/{member}} — group member delete. */
    public String memberItemPath(String groupDn, String memberDn) {
        if (family != Family.GROUPS) {
            throw new IllegalStateException("members is only valid for groups");
        }
        return membersPath(groupDn) + "/" + encode(memberDn);
    }

    /**
     * Build the URL-suitable identifier from a LSC main identifier.
     * For groups/flat resources we want the bare RDN value (so
     * {@code uid=alice,ou=users,dc=...} → {@code alice}). For
     * organizations we want the entire DN URL-encoded.
     */
    public String encodeId(String dn) {
        Objects.requireNonNull(dn, "dn");
        switch (family) {
            case ORGANIZATIONS:
                return encode(dn);
            case GROUPS:
            case FLAT:
            default:
                return encode(rdnValue(dn));
        }
    }

    /**
     * Extract the RDN value from a DN. Examples:
     * <ul>
     *     <li>{@code uid=alice,ou=users,dc=ex,dc=org} → {@code alice}</li>
     *     <li>{@code cn=admins,ou=groups,dc=ex,dc=org} → {@code admins}</li>
     *     <li>{@code alice} → {@code alice} (already an RDN value)</li>
     * </ul>
     *
     * <p>This is a deliberately simple parser: split on the first
     * unescaped comma, then on the first {@code =}. Backslash escapes
     * are honoured. It does not normalise attribute types or unescape
     * special characters in values beyond removing leading/trailing
     * whitespace.</p>
     */
    public static String rdnValue(String dn) {
        Objects.requireNonNull(dn, "dn");
        String firstRdn = firstRdn(dn);
        int eq = firstRdn.indexOf('=');
        if (eq < 0) {
            return firstRdn.trim();
        }
        return firstRdn.substring(eq + 1).trim();
    }

    /** Return the parent DN (everything after the first unescaped comma) or {@code ""}. */
    public static String parentDn(String dn) {
        Objects.requireNonNull(dn, "dn");
        int idx = indexOfUnescapedComma(dn);
        if (idx < 0) {
            return "";
        }
        return dn.substring(idx + 1).trim();
    }

    /** Return the first RDN component (before the first unescaped comma). */
    public static String firstRdn(String dn) {
        int idx = indexOfUnescapedComma(dn);
        return idx < 0 ? dn.trim() : dn.substring(0, idx).trim();
    }

    private static int indexOfUnescapedComma(String dn) {
        boolean escaped = false;
        for (int i = 0; i < dn.length(); i++) {
            char c = dn.charAt(i);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (c == '\\') {
                escaped = true;
                continue;
            }
            if (c == ',') {
                return i;
            }
        }
        return -1;
    }

    static String encode(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8)
                // URLEncoder uses '+' for spaces; ldap-rest decodes
                // percent-encoded form but not application/x-www-form-urlencoded
                // for path components, so use %20 to be safe.
                .replace("+", "%20");
    }
}
