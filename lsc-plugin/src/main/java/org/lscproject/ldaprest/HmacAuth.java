/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.Objects;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * HMAC-SHA256 request signing matching the ldap-rest server-side
 * verification. The signing string is:
 *
 * <pre>
 *   signingString = METHOD + "|" + PATH + "|" + timestamp + "|" + bodyHash
 *   bodyHash      = sha256_hex(body)            (POST/PUT/PATCH)
 *                 = ""                          (GET/DELETE/HEAD)
 *   timestamp     = currentTimeMillis()         (milliseconds)
 *   signature     = hmac_sha256_hex(secret, signingString)
 *   header        = "HMAC-SHA256 <serviceId>:<timestamp>:<signature>"
 * </pre>
 *
 * <p>The body bytes used for {@code bodyHash} <strong>must</strong>
 * be the exact bytes sent on the wire (UTF-8 encoded JSON in our
 * case). The HTTP client takes care of feeding the same byte array
 * to both the signature and the request body.</p>
 */
public final class HmacAuth implements LdapRestAuth {

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private final String serviceId;
    private final String secret;
    private final TimestampSource clock;

    public HmacAuth(String serviceId, String secret) {
        this(serviceId, secret, System::currentTimeMillis);
    }

    /**
     * Test-only constructor injecting a fixed timestamp source so
     * signatures are reproducible.
     */
    public HmacAuth(String serviceId, String secret, TimestampSource clock) {
        this.serviceId = Objects.requireNonNull(serviceId, "serviceId");
        this.secret = Objects.requireNonNull(secret, "secret");
        this.clock = Objects.requireNonNull(clock, "clock");
        if (serviceId.isEmpty() || secret.isEmpty()) {
            throw new IllegalArgumentException("serviceId and secret must not be empty");
        }
    }

    @Override
    public void apply(HttpRequest.Builder builder, String method, String path, byte[] body) {
        long ts = clock.now();
        String upper = method.toUpperCase(Locale.ROOT);
        boolean hasBody = upper.equals("POST") || upper.equals("PUT") || upper.equals("PATCH");
        String bodyHash = hasBody ? sha256Hex(body == null ? new byte[0] : body) : "";
        String signingString = upper + "|" + path + "|" + ts + "|" + bodyHash;
        String signature = hmacSha256Hex(secret, signingString);
        String headerValue = "HMAC-SHA256 " + serviceId + ":" + ts + ":" + signature;
        builder.header("Authorization", headerValue);
    }

    /**
     * Compute the signature for given inputs without sending a
     * request. Exposed so callers (and tests) can pre-compute
     * expected values.
     */
    public static String computeSignature(String secret,
                                          String method,
                                          String path,
                                          long timestamp,
                                          byte[] body) {
        String upper = method.toUpperCase(Locale.ROOT);
        boolean hasBody = upper.equals("POST") || upper.equals("PUT") || upper.equals("PATCH");
        String bodyHash = hasBody ? sha256Hex(body == null ? new byte[0] : body) : "";
        String signingString = upper + "|" + path + "|" + timestamp + "|" + bodyHash;
        return hmacSha256Hex(secret, signingString);
    }

    static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return toHex(md.digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    static String hmacSha256Hex(String secret, String signingString) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] sig = mac.doFinal(signingString.getBytes(StandardCharsets.UTF_8));
            return toHex(sig);
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }

    static String toHex(byte[] data) {
        char[] out = new char[data.length * 2];
        for (int i = 0; i < data.length; i++) {
            int v = data[i] & 0xff;
            out[i * 2] = HEX[v >>> 4];
            out[i * 2 + 1] = HEX[v & 0x0f];
        }
        return new String(out);
    }

    /** Test seam for clock injection. */
    @FunctionalInterface
    public interface TimestampSource {
        long now();
    }
}
