/*
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * LSC ldap-rest plugin - authentication strategies.
 */
package org.lscproject.ldaprest;

import java.net.http.HttpRequest;

/**
 * Pluggable authentication strategy that adds the relevant
 * Authorization header on an outgoing HTTP request to ldap-rest.
 *
 * <p>The strategy receives the parsed components of the request
 * ({@code method}, {@code path}, {@code body}) so that signed schemes
 * (HMAC) can compute their signature. Stateless schemes (Bearer)
 * simply add a static header.</p>
 *
 * <p>Implementations <strong>must</strong> be safe for concurrent use
 * across multiple HTTP clients/threads.</p>
 */
public interface LdapRestAuth {

    /**
     * Apply this auth strategy to {@code builder}, signing the
     * outgoing request based on its method, path and body.
     *
     * @param builder the {@link HttpRequest.Builder} being built
     * @param method  the HTTP method, upper case (e.g. {@code POST})
     * @param path    the request path, e.g. {@code /api/v1/ldap/users}
     * @param body    the body bytes that will be sent, or empty for
     *                methods without a body (GET, DELETE, HEAD)
     */
    void apply(HttpRequest.Builder builder, String method, String path, byte[] body);
}
