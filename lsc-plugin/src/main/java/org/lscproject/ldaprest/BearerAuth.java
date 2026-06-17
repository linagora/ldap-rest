/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import java.net.http.HttpRequest;
import java.util.Objects;

/**
 * Static bearer-token authentication.
 *
 * <p>Adds {@code Authorization: Bearer &lt;token&gt;} to every
 * outgoing request. The token is supposed to be opaque to the client
 * and is provided by the ldap-rest deployment (typically through an
 * environment variable expanded in {@code lsc.xml}).</p>
 */
public final class BearerAuth implements LdapRestAuth {

    private final String token;

    public BearerAuth(String token) {
        this.token = Objects.requireNonNull(token, "token");
        if (token.isEmpty()) {
            throw new IllegalArgumentException("bearer token must not be empty");
        }
    }

    @Override
    public void apply(HttpRequest.Builder builder, String method, String path, byte[] body) {
        builder.header("Authorization", "Bearer " + token);
    }
}
