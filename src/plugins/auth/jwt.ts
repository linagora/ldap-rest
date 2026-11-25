/**
 * @module plugins/auth/jwt
 *
 * Bearer JWT access tokens issued by an OAuth 2.0 / OpenID Connect provider,
 * checked against the provider's published keys: ldap-rest as a resource
 * server, for machine clients using the client_credentials grant.
 * See `docs/usage/plugins/auth/jwt.md`.
 * @group Plugins
 */
import { performance } from 'perf_hooks';

import type { Response } from 'express';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
  type RemoteJWKSetOptions,
} from 'jose';

import AuthBase, { type DmRequest } from '../../lib/auth/base.js';
import {
  forbidden,
  serviceUnavailable,
  unauthorized,
} from '../../lib/expressFormatedResponses.js';
import type { Role } from '../../abstract/plugin.js';

import {
  JWT_ALGORITHMS,
  jwtOptions,
  type JwtIssuerSettings,
  type JwtOptions,
} from './auth.options.js';

const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * What jose throws for a token it refuses, as opposed to keys it could not
 * get: the first answers 401, the second 503, since the caller's token may
 * well be valid.
 */
const TOKEN_ERRORS = new Set([
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
]);

const BEARER = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

const codeOf = (err: unknown): unknown =>
  err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;

/**
 * The keys are unavailable, and the failure was logged where it happened:
 * the requests answered 503 meanwhile log it at debug level only
 */
class KeysUnavailable extends Error {}

/** Whether a URL reaches this host only, where plain http carries no risk */
const loopback = (url: URL): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

/** The fields an entry of `--jwt-issuers` may hold, and their type */
const ISSUER_FIELDS: Record<keyof JwtIssuerSettings, 'string' | 'array'> = {
  jwks_uri: 'string',
  audience: 'array',
  algorithm: 'array',
  identity_claim: 'string',
  allowed_client: 'array',
  type: 'string',
  identity_prefix: 'string',
};

/**
 * An issuer this server trusts, with its own keys: a provider that cannot be
 * reached answers 503 for its own tokens only.
 */
interface Trusted {
  issuer: string;
  /** Where the administrator names it, for the messages */
  option: string;
  jwksUri?: URL;
  claim: string;
  /** Put before the identity, so that two issuers' clients stay apart */
  prefix: string;
  allowed: string[];
  algorithms: string[];
  verifyOptions: JWTVerifyOptions;
  keys?: Promise<JWTVerifyGetKey>;
  /** `performance.now()` of the last failed discovery, immune to clock steps */
  failedAt?: number;
}

export default class AuthJwt extends AuthBase {
  static optionDefinitions = jwtOptions;
  /**
   * How long a failure to get the keys — discovery or JWKS — is kept before
   * a request tries again, so that a provider outage does not turn every
   * request into an outbound fetch
   */
  static retryMs = 30_000;
  /** jose's cache settings, left to its defaults outside the tests */
  static remoteOptions: RemoteJWKSetOptions = {};

  name = 'authJwt';
  roles: Role[] = ['auth'] as const;

  private readonly settings: JwtOptions;
  /** The trusted issuers, by the exact `iss` their tokens carry */
  private readonly trusted = new Map<string, Trusted>();
  /** Whether `--jwt-issuers` lists them, rather than `--jwt-issuer` */
  private readonly several: boolean;

  constructor(...args: ConstructorParameters<typeof AuthBase>) {
    super(...args);
    this.settings = this.options(jwtOptions);
    const issuers = Object.entries(this.settings.jwt_issuers ?? {});
    this.several = issuers.length > 0;
    if (!this.several) {
      // A value from a secret file often ends with a newline
      const issuer = this.settings.jwt_issuer.trim();
      if (!issuer)
        throw new Error(
          `${this.name}: --jwt-issuer is required, unless --jwt-issuers is set`
        );
      this.trust(issuer, {}, '');
      return;
    }
    // Two sources of trust would leave it unclear which one a token answers to
    if (this.settings.jwt_issuer.trim() || this.settings.jwt_jwks_uri.trim())
      throw new Error(
        `${this.name}: --jwt-issuers replaces --jwt-issuer and --jwt-jwks-uri; ` +
          'name every issuer, and its jwks_uri, in --jwt-issuers'
      );
    for (const [issuer, entry] of issuers) {
      const where = `--jwt-issuers "${issuer}": `;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error(`${this.name}: ${where}must be a JSON object`);
      // An unknown field is refused rather than ignored: `audiences` for
      // `audience` would otherwise drop the audience check without a word
      for (const [field, value] of Object.entries(entry)) {
        const kind = ISSUER_FIELDS[field as keyof JwtIssuerSettings];
        if (!kind)
          throw new Error(
            `${this.name}: ${where}unknown field "${field}" ` +
              `(expected ${Object.keys(ISSUER_FIELDS).join(', ')})`
          );
        const ok =
          kind === 'string'
            ? typeof value === 'string'
            : Array.isArray(value) && value.every(v => typeof v === 'string');
        if (!ok)
          throw new Error(
            `${this.name}: ${where}"${field}" must be ` +
              (kind === 'string' ? 'a string' : 'a list of strings')
          );
      }
      // The key is compared with the token's iss as is: no trimming
      if (issuer !== issuer.trim() || !issuer)
        throw new Error(
          `${this.name}: ${where}an issuer is named exactly as its tokens carry it`
        );
      this.trust(issuer, entry, where);
    }
    if (this.trusted.size > 1) this.checkPrefixes();
  }

  /**
   * The published identity is the prefix followed by the token's identity:
   * with one prefix starting another, or empty, two issuers could publish
   * the same one ("b:" + "admin" from B, "" + "b:admin" from A). Prefixes
   * none of which starts another keep every issuer's identities apart.
   */
  private checkPrefixes(): void {
    const all = [...this.trusted.values()];
    for (const t of all)
      if (!t.prefix)
        throw new Error(
          `${this.name}: ${t.option}: identity_prefix is required when ` +
            'several issuers are trusted, so that their identities stay apart'
        );
    for (const t of all)
      for (const other of all)
        if (other !== t && t.prefix.startsWith(other.prefix))
          throw new Error(
            `${this.name}: identity_prefix ${JSON.stringify(t.prefix)} of ` +
              `${t.issuer} starts with ${JSON.stringify(other.prefix)} of ` +
              `${other.issuer}: an identity of one could be taken for one ` +
              'of the other'
          );
  }

  /**
   * Check one issuer's settings, fill in the `--jwt-*` defaults and add it
   * to the trusted ones. `where` names the entry of `--jwt-issuers`, empty
   * for `--jwt-issuer`.
   */
  private trust(issuer: string, entry: JwtIssuerSettings, where: string): void {
    const s = this.settings;
    const option = (field: string): string =>
      where ? `${where}${field}` : `--jwt-${field.replace(/_/g, '-')}`;
    const claim = (entry.identity_claim ?? s.jwt_identity_claim).trim();
    const jwksUri = (entry.jwks_uri ?? (where ? '' : s.jwt_jwks_uri)).trim();
    const audience = (entry.audience ?? s.jwt_audience)
      .map(a => a.trim())
      .filter(Boolean);
    const type = (entry.type ?? s.jwt_type).trim();
    const allowed = (entry.allowed_client ?? s.jwt_allowed_client)
      .map(c => c.trim())
      .filter(Boolean);
    const algorithms = entry.algorithm ?? s.jwt_algorithm;
    if (!claim)
      throw new Error(`${this.name}: ${option('identity_claim')} is empty`);
    if (algorithms.length === 0)
      throw new Error(
        `${this.name}: ${option('algorithm')} lists no algorithm`
      );
    // HS* would verify with a public key read as an HMAC secret: anyone
    // holding the published key could sign tokens
    const refused = algorithms.filter(alg => !JWT_ALGORITHMS.includes(alg));
    if (refused.length > 0)
      throw new Error(
        `${this.name}: ${option('algorithm')} ${refused.join(', ')} refused; ` +
          `known asymmetric algorithms: ${JWT_ALGORITHMS.join(', ')}`
      );
    this.httpUrl(issuer, where ? `--jwt-issuers "${issuer}"` : '--jwt-issuer');
    this.trusted.set(issuer, {
      issuer,
      option: where ? `--jwt-issuers "${issuer}"` : '--jwt-issuer',
      jwksUri: jwksUri ? this.httpUrl(jwksUri, option('jwks_uri')) : undefined,
      claim,
      prefix: entry.identity_prefix ?? '',
      allowed,
      algorithms,
      verifyOptions: {
        issuer,
        audience: audience.length > 0 ? audience : undefined,
        algorithms,
        clockTolerance: s.jwt_clock_tolerance,
        requiredClaims: ['exp'],
        ...(type ? { typ: type } : {}),
      },
    });
  }

  /**
   * An http(s) URL, or a startup refusal. Whoever can alter the keys on
   * their way can sign any identity, so plain http off this host is said.
   */
  private httpUrl(value: string, what: string): URL {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:'))
      throw new Error(`${this.name}: ${what} "${value}" is not an http(s) URL`);
    if (url.protocol === 'http:' && !loopback(url))
      this.logger.warn(
        `${this.name}: ${what} ${value} is plain http: the signing keys can ` +
          'be replaced on their way'
      );
    return url;
  }

  /** Unknown as soon as one issuer lets every one of its clients in */
  protected knownIdentities(): string[] | undefined {
    const known: string[] = [];
    for (const t of this.trusted.values()) {
      if (t.allowed.length === 0) return undefined;
      known.push(...t.allowed.map(c => t.prefix + c));
    }
    return known;
  }

  protected identitySource(): string {
    const claims = [...new Set([...this.trusted.values()].map(t => t.claim))];
    return (
      `req.user and req.userName: the token's ` +
      `${claims.map(c => `"${c}"`).join(' or ')} claim` +
      (this.several ? `, from ${this.trusted.size} issuers` : '')
    );
  }

  afterLoad(): void {
    super.afterLoad();
    for (const t of this.trusted.values())
      if (!t.verifyOptions.audience)
        this.logger.warn(
          `${this.name}: no audience for ${t.issuer}, so a token it ` +
            'signed for any other service is accepted here too'
        );
  }

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const match = BEARER.exec(req.headers.authorization ?? '');
    if (!match) {
      res.set('WWW-Authenticate', 'Bearer');
      return unauthorized(res);
    }
    void this.verify(match[1], req, res, next);
  }

  private refuse(res: Response, reason: string): void {
    this.logger.warn(`${this.name}: token refused: ${reason}`);
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    unauthorized(res);
  }

  private async verify(
    token: string,
    req: DmRequest,
    res: Response,
    next: () => void
  ): Promise<void> {
    // Refused before the keys are fetched: a token that cannot verify is
    // answered 401 even with the provider unreachable, and does not reach it
    let alg: unknown;
    try {
      ({ alg } = decodeProtectedHeader(token));
    } catch {
      alg = undefined;
    }
    const trusted = this.trustedFor(token);
    if (!trusted) return this.refuse(res, 'unreadable, or issuer not trusted');
    if (typeof alg !== 'string' || !trusted.algorithms.includes(alg))
      return this.refuse(res, 'unreadable, or alg not allowed');
    let payload: JWTPayload;
    try {
      payload = await this.verified(token, trusted);
    } catch (err) {
      const code = codeOf(err);
      if (typeof code === 'string' && TOKEN_ERRORS.has(code))
        return this.refuse(res, code);
      if (err instanceof KeysUnavailable)
        this.logger.debug(`${this.name}: 503: ${err.message}`);
      else
        this.logger.error(`${this.name}: cannot verify tokens: ${String(err)}`);
      return serviceUnavailable(res);
    }
    const identity = payload[trusted.claim];
    if (typeof identity !== 'string' || identity.length === 0)
      return this.refuse(res, `no "${trusted.claim}" claim`);
    if (trusted.allowed.length > 0 && !trusted.allowed.includes(identity)) {
      this.logger.warn(`${this.name}: client ${identity} is not allowed`);
      return forbidden(res);
    }
    this.publishIdentity(req, trusted.prefix + identity);
    next();
  }

  /**
   * The issuer whose keys judge a token, chosen by the `iss` the token
   * carries before its signature is checked. That only narrows the keys to
   * one issuer's, which must then verify it: the keys of every issuer are
   * never tried in turn, which would let any of them vouch for a token
   * naming another. An unknown issuer is refused without fetching anything.
   */
  private trustedFor(token: string): Trusted | undefined {
    let iss: unknown;
    try {
      ({ iss } = decodeJwt(token));
    } catch {
      return undefined;
    }
    return typeof iss === 'string' ? this.trusted.get(iss) : undefined;
  }

  private async verified(token: string, t: Trusted): Promise<JWTPayload> {
    const keys = await this.keySet(t);
    try {
      return (await jwtVerify(token, keys, t.verifyOptions)).payload;
    } catch (err) {
      // A set whose keys carry no `kid` can offer several candidates: jose
      // hands them over rather than trying each one
      if (codeOf(err) !== 'ERR_JWKS_MULTIPLE_MATCHING_KEYS') throw err;
      for await (const key of err as AsyncIterable<CryptoKey>) {
        try {
          return (await jwtVerify(token, key, t.verifyOptions)).payload;
        } catch (inner) {
          if (codeOf(inner) !== 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')
            throw inner;
        }
      }
      throw new errors.JWSSignatureVerificationFailed();
    }
  }

  /**
   * The provider's keys, once discovery has named them. A failed discovery
   * is answered 503 for {@link AuthJwt.retryMs} before a request tries again.
   */
  private keySet(t: Trusted): Promise<JWTVerifyGetKey> {
    if (t.keys && t.failedAt === undefined) return t.keys;
    if (
      t.failedAt !== undefined &&
      performance.now() - t.failedAt < AuthJwt.retryMs
    )
      return Promise.reject(
        new KeysUnavailable(`discovery of ${t.issuer} failed, retrying shortly`)
      );
    t.failedAt = undefined;
    t.keys = this.locateJwks(t).then(
      uri => this.remoteSet(t, uri),
      (err: unknown) => {
        t.failedAt = performance.now();
        this.logger.error(
          `${this.name}: discovery of ${t.issuer} failed: ${String(err)}`
        );
        throw new KeysUnavailable(
          `discovery of ${t.issuer} failed, retrying shortly`
        );
      }
    );
    return t.keys;
  }

  /**
   * jose caches the set for 10 minutes and fetches it again sooner for a
   * token naming a key it does not hold, at most every 30 seconds after a
   * success. After a failure it neither waits nor keeps the keys it held:
   * here a failed fetch is followed by {@link AuthJwt.retryMs} without fetching,
   * during which the last keys fetched still verify tokens.
   */
  private remoteSet(t: Trusted, uri: URL): JWTVerifyGetKey {
    const remote = createRemoteJWKSet(uri, {
      ...AuthJwt.remoteOptions,
      [customFetch]: (url, init) => this.fetch(url, init),
    });
    let failedAt: number | undefined;
    /** The keys held when the last fetch failed, imported once */
    let local: JWTVerifyGetKey | undefined;
    const held: JWTVerifyGetKey = (...args) =>
      local
        ? local(...args)
        : Promise.reject(
            new KeysUnavailable(
              `the JWKS of ${t.issuer} could not be fetched, retrying shortly`
            )
          );
    return async (...args) => {
      if (
        failedAt !== undefined &&
        performance.now() - failedAt < AuthJwt.retryMs
      )
        return held(...args);
      try {
        const key = await remote(...args);
        failedAt = undefined;
        return key;
      } catch (err) {
        const code = codeOf(err);
        if (
          typeof code === 'string' &&
          (TOKEN_ERRORS.has(code) || code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS')
        )
          throw err;
        this.logger.error(
          `${this.name}: cannot fetch the JWKS of ${t.issuer} at ` +
            `${uri.href}: ${String(err)}`
        );
        failedAt = performance.now();
        const jwks = remote.jwks();
        local = jwks ? createLocalJWKSet(jwks) : undefined;
        return held(...args);
      }
    };
  }

  /** Read once: a provider moving its JWKS needs a restart */
  private async locateJwks(t: Trusted): Promise<URL> {
    if (t.jwksUri) return t.jwksUri;
    const issuer = t.issuer;
    const where = `${issuer.endsWith('/') ? issuer.slice(0, -1) : issuer}/.well-known/openid-configuration`;
    // No redirect, as jose follows none for the JWKS
    const response = await this.fetch(where, {
      redirect: 'error',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${where} answered ${response.status}`);
    const document = (await response.json()) as {
      issuer?: unknown;
      jwks_uri?: unknown;
    };
    // OpenID Connect Discovery 1.0 section 4.3: a document naming another
    // issuer is not this provider's
    if (document.issuer !== issuer)
      throw new Error(
        `${where} names issuer ${JSON.stringify(document.issuer)}, not ${issuer}` +
          (typeof document.issuer === 'string' &&
          document.issuer.replace(/\/$/, '') === issuer.replace(/\/$/, '')
            ? `: write ${this.several ? 'the --jwt-issuers key' : '--jwt-issuer'} ` +
              'exactly as the provider names itself, ' +
              'trailing slash included, since tokens carry that value'
            : '')
      );
    if (typeof document.jwks_uri !== 'string')
      throw new Error(`${where} names no jwks_uri`);
    return this.httpUrl(document.jwks_uri, `${where} jwks_uri`);
  }
}
