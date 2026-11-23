# JWT Access Tokens

`core/auth/jwt` makes LDAP-Rest an OAuth 2.0 resource server: a client
presents an access token issued by an identity provider
(`Authorization: Bearer <JWT>`), typically obtained with the
`client_credentials` grant, and the plugin checks it against the provider's
published keys. No secret is shared with LDAP-Rest.

Unlike [OpenID Connect](oidc.md), which signs a person in through a browser
and keeps a session cookie, this plugin holds no session: every request
carries its token.

## Configuration

```bash
--plugin core/auth/jwt \
--jwt-issuer https://sso.example.com/realms/acme \
--jwt-audience ldap-rest \
--jwt-allowed-client backup-service \
--jwt-allowed-client sync-service
```

| Option                  | Default            | Meaning                                                                 |
| ----------------------- | ------------------ | ----------------------------------------------------------------------- |
| `--jwt-issuer`          | (required)         | Expected `iss`; the discovery document is read under it                 |
| `--jwt-jwks-uri`        | from discovery     | The provider's JWKS, when it publishes no discovery document            |
| `--jwt-audience`        | none               | Accepted `aud` values; a token must name one of them                    |
| `--jwt-algorithm`       | every asymmetric   | Accepted signature algorithms (`RS*`, `PS*`, `ES*`, `EdDSA`, `Ed25519`) |
| `--jwt-clock-tolerance` | `30`               | Seconds of clock skew allowed on `exp` and `nbf`                        |
| `--jwt-identity-claim`  | `client_id`        | Claim published as `req.user` and `req.userName`                        |
| `--jwt-allowed-client`  | none: every client | Identities allowed in; another valid token is answered 403              |
| `--jwt-type`            | none               | Required `typ` header, such as `at+jwt` (RFC 9068); unset, not checked  |

Each has an environment variable, see
[configuration](../../configuration.md#coreauthjwt).

## What is checked

- The signature, with a key from the provider's JWKS, read from
  `--jwt-jwks-uri` or from the `jwks_uri` of
  `<issuer>/.well-known/openid-configuration`, whose `issuer` must be
  `--jwt-issuer` exactly. Discovery runs once and follows no redirect: a
  provider moving its JWKS needs a restart. The set is cached for 10 minutes,
  and fetched again sooner when a token names a key it does not hold, at most
  every 30 seconds, so key rotation needs no restart.
- The algorithm: only those listed. HMAC algorithms and `none` are refused at
  startup, since a JWKS publishes public keys, which must never be read as a
  shared secret.
- `iss`, `exp` (required), `nbf`, `aud` when `--jwt-audience` is set, and the
  `typ` header when `--jwt-type` is.
- The identity claim: a token without it is refused.

The issuer and the JWKS must be `http` or `https` URLs. Plain `http` to
another host is accepted with a warning: whoever can alter the keys on their
way can sign any identity.

Without `--jwt-audience`, any token the provider signs for any of its clients
is accepted, and the plugin says so at startup. Set it to the audience the
provider puts in the tokens meant for LDAP-Rest (Keycloak: an audience mapper
on the client scope; Microsoft Entra: the application ID URI), and never to
the client id of a console signing people in through
[OpenID Connect](oidc.md): its ID tokens carry that audience too, and would be
accepted here. A provider issuing RFC 9068 tokens lets `--jwt-type at+jwt`
refuse anything else; Keycloak and Entra send `typ: JWT` for both kinds.

The plugin checks no scope: any client the provider signs a token for, with
that audience, gets in. Where clients can register themselves, list the
expected ones in `--jwt-allowed-client`.

## Answers

| Case                                       | Status | `WWW-Authenticate`             |
| ------------------------------------------ | ------ | ------------------------------ |
| No bearer token                            | 401    | `Bearer`                       |
| Token refused (signature, claims, expired) | 401    | `Bearer error="invalid_token"` |
| Valid token, client not in the allow-list  | 403    |                                |
| Keys unavailable (provider down, bad JWKS) | 503    |                                |

A failed discovery or JWKS fetch is retried after 30 seconds, not on every
request. Meanwhile the keys last fetched still verify tokens, so an outage of
the provider stops new keys only; before any fetch has succeeded, requests
are answered 503.

## Identity

The value of `--jwt-identity-claim` is published as both `req.user` and
`req.userName`, so authorization plugins key their rules on the client.
RFC 9068 names the client `client_id`. `azp` (Keycloak, Microsoft Entra v2.0)
and `appid` (Entra v1.0) name it too, but also in the tokens a client obtains
for a person, and `sub` names the person there: keyed on them, a person
signing in through an allowed client passes as that client. Prefer a claim
only machine tokens carry, or a client that has no flow for people.

Scope it with `--auth-path-prefix` to serve machines on one branch of the API
and administrators signed in through OpenID Connect on another, see
[several populations](README.md#serving-several-populations-from-one-server).

## Dependencies

The plugin needs the optional dependency `jose`.
