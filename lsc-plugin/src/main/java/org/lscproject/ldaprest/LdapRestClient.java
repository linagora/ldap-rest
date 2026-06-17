/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Objects;

import org.lsc.exception.LscServiceException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Thin wrapper around {@link HttpClient} for talking to ldap-rest.
 *
 * <p>Responsibilities:</p>
 * <ul>
 *     <li>Apply the configured {@link LdapRestAuth} on every request,
 *         feeding it the same body bytes that go on the wire so that
 *         HMAC signatures match.</li>
 *     <li>Build the absolute URL from a base URL and path.</li>
 *     <li>Retry transient errors (5xx, IOException) with capped
 *         exponential backoff.</li>
 *     <li>Translate non-2xx responses into {@link LscServiceException}.</li>
 * </ul>
 *
 * <p>Idempotent special cases (404 on DELETE) are handled by the
 * caller, not here, so the client stays generic.</p>
 */
public class LdapRestClient {

    private static final Logger LOG = LoggerFactory.getLogger(LdapRestClient.class);

    private final String baseUrl;
    private final LdapRestAuth auth;
    private final long timeoutMs;
    private final int retries;
    private final HttpClient http;
    private final Sleeper sleeper;

    public LdapRestClient(String baseUrl, LdapRestAuth auth, long timeoutMs, int retries) {
        this(baseUrl, auth, timeoutMs, retries,
                HttpClient.newBuilder()
                        .connectTimeout(Duration.ofMillis(Math.max(1000, timeoutMs)))
                        .build(),
                ms -> {
                    try {
                        Thread.sleep(ms);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
    }

    /** Test-friendly constructor allowing HttpClient and Sleeper injection. */
    public LdapRestClient(String baseUrl, LdapRestAuth auth, long timeoutMs, int retries,
                          HttpClient http, Sleeper sleeper) {
        this.baseUrl = stripTrailingSlash(Objects.requireNonNull(baseUrl, "baseUrl"));
        this.auth = Objects.requireNonNull(auth, "auth");
        if (timeoutMs <= 0) {
            throw new IllegalArgumentException("timeoutMs must be positive");
        }
        if (retries < 0) {
            throw new IllegalArgumentException("retries must be >= 0");
        }
        this.timeoutMs = timeoutMs;
        this.retries = retries;
        this.http = Objects.requireNonNull(http, "http");
        this.sleeper = Objects.requireNonNull(sleeper, "sleeper");
    }

    public HttpResponse<String> get(String path) throws LscServiceException {
        return send("GET", path, null);
    }

    public HttpResponse<String> delete(String path) throws LscServiceException {
        return send("DELETE", path, null);
    }

    public HttpResponse<String> post(String path, String jsonBody) throws LscServiceException {
        return send("POST", path, jsonBody == null ? new byte[0] : jsonBody.getBytes(StandardCharsets.UTF_8));
    }

    public HttpResponse<String> put(String path, String jsonBody) throws LscServiceException {
        return send("PUT", path, jsonBody == null ? new byte[0] : jsonBody.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Low-level send with retry and auth. {@code body} is the exact
     * payload bytes sent to the server; the same array is used to
     * compute the HMAC signature.
     */
    public HttpResponse<String> send(String method, String path, byte[] body) throws LscServiceException {
        Objects.requireNonNull(method, "method");
        Objects.requireNonNull(path, "path");
        URI uri = URI.create(baseUrl + path);
        IOException lastIo = null;
        HttpResponse<String> last5xx = null;
        for (int attempt = 0; attempt <= retries; attempt++) {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(uri)
                    .timeout(Duration.ofMillis(timeoutMs));
            byte[] bodyBytes = body == null ? new byte[0] : body;
            switch (method) {
                case "GET":
                    builder.GET();
                    break;
                case "DELETE":
                    builder.DELETE();
                    break;
                case "POST":
                    builder.header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofByteArray(bodyBytes));
                    break;
                case "PUT":
                    builder.header("Content-Type", "application/json")
                            .PUT(HttpRequest.BodyPublishers.ofByteArray(bodyBytes));
                    break;
                default:
                    throw new LscServiceException("Unsupported HTTP method: " + method);
            }
            builder.header("Accept", "application/json");
            // Auth must run after Content-Type so headers are visible
            // but before send so the timestamp is fresh per attempt.
            auth.apply(builder, method, path, bodyBytes);
            HttpRequest req = builder.build();
            try {
                HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                int code = resp.statusCode();
                if (code >= 200 && code < 300) {
                    return resp;
                }
                if (code >= 500 && attempt < retries) {
                    last5xx = resp;
                    long wait = backoffMillis(attempt);
                    LOG.warn("ldap-rest {} {} returned {}, retrying in {}ms (attempt {}/{})",
                            method, path, code, wait, attempt + 1, retries);
                    sleeper.sleep(wait);
                    continue;
                }
                // Non-retryable error
                throw new LscServiceException("ldap-rest " + method + " " + path
                        + " failed with HTTP " + code + ": " + truncate(resp.body()));
            } catch (IOException ioe) {
                lastIo = ioe;
                if (attempt < retries) {
                    long wait = backoffMillis(attempt);
                    LOG.warn("ldap-rest {} {} I/O error: {}, retrying in {}ms (attempt {}/{})",
                            method, path, ioe.getMessage(), wait, attempt + 1, retries);
                    sleeper.sleep(wait);
                    continue;
                }
                throw new LscServiceException("ldap-rest " + method + " " + path + " failed: " + ioe.getMessage(), ioe);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw new LscServiceException("ldap-rest " + method + " " + path + " interrupted", ie);
            }
        }
        if (last5xx != null) {
            throw new LscServiceException("ldap-rest " + method + " " + path
                    + " failed after " + retries + " retries with HTTP "
                    + last5xx.statusCode() + ": " + truncate(last5xx.body()));
        }
        throw new LscServiceException("ldap-rest " + method + " " + path
                + " failed after " + retries + " retries", lastIo);
    }

    private static long backoffMillis(int attempt) {
        // 100ms, 200ms, 400ms, 800ms, capped at 5s
        long base = 100L * (1L << Math.min(attempt, 6));
        return Math.min(base, 5000L);
    }

    private static String truncate(String s) {
        if (s == null) return "";
        return s.length() > 500 ? s.substring(0, 500) + "..." : s;
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    /** Test seam for backoff sleep. */
    @FunctionalInterface
    public interface Sleeper {
        void sleep(long ms);
    }
}
