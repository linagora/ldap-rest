/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.util.Optional;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.junit.jupiter.api.Test;

class LdapRestAuthTest {

    @Test
    void bearerSetsAuthorizationHeader() {
        BearerAuth auth = new BearerAuth("abc-123");
        HttpRequest.Builder b = HttpRequest.newBuilder().uri(URI.create("http://x/y"));
        auth.apply(b, "POST", "/api/v1/ldap/users", "{\"x\":1}".getBytes(StandardCharsets.UTF_8));
        HttpRequest req = b.GET().build();
        Optional<String> h = req.headers().firstValue("Authorization");
        assertTrue(h.isPresent());
        assertEquals("Bearer abc-123", h.get());
    }

    /**
     * Cross-implementation contract test. The Node server in
     * test/plugins/auth/hmac.test.ts ("Cross-impl vector") hard-codes the
     * same expected signature. If either side drifts (signing string format,
     * body hashing rule, timestamp encoding), both tests fail.
     *
     * Vector: secret="test-secret-min-32-chars-long-xxx", method=POST,
     * path=/api/v1/ldap/users, ts=1700000000000, body={"uid":"alice"}.
     */
    @Test
    void hmacCrossImplVector() {
        String secret = "test-secret-min-32-chars-long-xxx";
        String method = "POST";
        String path = "/api/v1/ldap/users";
        long ts = 1_700_000_000_000L;
        byte[] body = "{\"uid\":\"alice\"}".getBytes(StandardCharsets.UTF_8);
        String expected = "65b065ff10ab2a54de0ab4db485c5744fcdd32a98e2fd24a8cef5240b43bbc94";
        assertEquals(expected, HmacAuth.computeSignature(secret, method, path, ts, body),
                "HMAC signature must match the Node server's vector — see test/plugins/auth/hmac.test.ts");
    }

    @Test
    void hmacReproducibleSignature() throws Exception {
        // Reference vector — values are also used by the cross-check
        // implemented by hand below.
        String secret = "test-secret-min-32-chars-long-xxx";
        String serviceId = "lsc";
        String method = "POST";
        String path = "/api/v1/ldap/users";
        // Body uses LinkedHashMap-style insertion order: {"uid":"alice"}.
        // That's exactly what the translator produces.
        String body = "{\"uid\":\"alice\"}";
        long fixedTs = 1_700_000_000_000L;

        // Compute expected signature manually with javax.crypto.Mac
        String bodyHash = HmacAuth.sha256Hex(body.getBytes(StandardCharsets.UTF_8));
        String signingString = method + "|" + path + "|" + fixedTs + "|" + bodyHash;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] expectedSig = mac.doFinal(signingString.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : expectedSig) hex.append(String.format("%02x", b));
        String expectedHex = hex.toString();

        // computeSignature should match
        String computed = HmacAuth.computeSignature(secret, method, path, fixedTs,
                body.getBytes(StandardCharsets.UTF_8));
        assertEquals(expectedHex, computed, "computeSignature must match Mac directly");

        // apply() must produce the same signature in the header
        HmacAuth auth = new HmacAuth(serviceId, secret, () -> fixedTs);
        HttpRequest.Builder b = HttpRequest.newBuilder().uri(URI.create("http://x" + path));
        auth.apply(b, method, path, body.getBytes(StandardCharsets.UTF_8));
        HttpRequest req = b.POST(HttpRequest.BodyPublishers.ofString(body)).build();
        String headerValue = req.headers().firstValue("Authorization").orElseThrow();
        assertEquals("HMAC-SHA256 " + serviceId + ":" + fixedTs + ":" + expectedHex, headerValue);
    }

    @Test
    void hmacUsesEmptyBodyHashForGet() {
        long ts = 1_700_000_000_000L;
        String secret = "secret";
        String path = "/api/v1/ldap/users";
        // For GET, bodyHash must be the empty string and body is ignored.
        String sigGet = HmacAuth.computeSignature(secret, "GET", path, ts, "ignored".getBytes());
        // signing string is METHOD|PATH|TS| (with empty bodyHash)
        String expectedSigningString = "GET|" + path + "|" + ts + "|";
        String expected = HmacAuth.hmacSha256Hex(secret, expectedSigningString);
        assertEquals(expected, sigGet);
    }

    @Test
    void hmacDeleteUsesEmptyBodyHash() {
        long ts = 42L;
        String secret = "k";
        String path = "/api/v1/ldap/users/alice";
        String sig = HmacAuth.computeSignature(secret, "DELETE", path, ts, null);
        String expected = HmacAuth.hmacSha256Hex(secret, "DELETE|" + path + "|" + ts + "|");
        assertEquals(expected, sig);
    }

    @Test
    void sha256HexKnownVector() {
        // Empty input vector
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                HmacAuth.sha256Hex(new byte[0]));
        // "abc" vector
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                HmacAuth.sha256Hex("abc".getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void hmacSignatureNonEmpty() {
        String sig = HmacAuth.computeSignature("key", "POST", "/x", 1L, "body".getBytes());
        assertNotNull(sig);
        assertEquals(64, sig.length()); // 32 bytes hex
    }
}
