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

import { JWT_ALGORITHMS, jwtOptions, type JwtOptions } from './auth.options.js';

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

/** Whether a URL reaches this host only, where plain http carries no risk */
const loopback = (url: URL): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

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
  private readonly issuer: string;
  private readonly jwksUri?: URL;
  private readonly claim: string;
  private readonly verifyOptions: JWTVerifyOptions;
  private keys?: Promise<JWTVerifyGetKey>;
  /** `performance.now()` of the last failed discovery, immune to clock steps */
  private failedAt?: number;

  constructor(...args: ConstructorParameters<typeof AuthBase>) {
    super(...args);
    this.settings = this.options(jwtOptions);
    // A value from a secret file often ends with a newline
    this.issuer = this.settings.jwt_issuer.trim();
    this.claim = this.settings.jwt_identity_claim.trim();
    const jwksUri = this.settings.jwt_jwks_uri.trim();
    const audience = this.settings.jwt_audience
      .map(a => a.trim())
      .filter(Boolean);
    const type = this.settings.jwt_type.trim();
    const algorithms = this.settings.jwt_algorithm;
    if (!this.issuer) throw new Error(`${this.name}: --jwt-issuer is required`);
    if (!this.claim)
      throw new Error(`${this.name}: --jwt-identity-claim is empty`);
    if (algorithms.length === 0)
      throw new Error(`${this.name}: --jwt-algorithm lists no algorithm`);
    // HS* would verify with a public key read as an HMAC secret: anyone
    // holding the published key could sign tokens
    const refused = algorithms.filter(alg => !JWT_ALGORITHMS.includes(alg));
    if (refused.length > 0)
      throw new Error(
        `${this.name}: --jwt-algorithm ${refused.join(', ')} refused; ` +
          `known asymmetric algorithms: ${JWT_ALGORITHMS.join(', ')}`
      );
    this.httpUrl(this.issuer, '--jwt-issuer');
    if (jwksUri) this.jwksUri = this.httpUrl(jwksUri, '--jwt-jwks-uri');
    this.verifyOptions = {
      issuer: this.issuer,
      audience: audience.length > 0 ? audience : undefined,
      algorithms,
      clockTolerance: this.settings.jwt_clock_tolerance,
      requiredClaims: ['exp'],
      ...(type ? { typ: type } : {}),
    };
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

  protected knownIdentities(): string[] | undefined {
    const allowed = this.settings.jwt_allowed_client;
    return allowed.length > 0 ? allowed : undefined;
  }

  protected identitySource(): string {
    return `req.user and req.userName: the token's "${this.claim}" claim`;
  }

  afterLoad(): void {
    super.afterLoad();
    if (!this.verifyOptions.audience)
      this.logger.warn(
        `${this.name}: no --jwt-audience, so a token ${this.issuer} ` +
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
    if (typeof alg !== 'string' || !this.settings.jwt_algorithm.includes(alg))
      return this.refuse(res, 'unreadable, or alg not allowed');
    let payload: JWTPayload;
    try {
      payload = await this.verified(token);
    } catch (err) {
      const code = codeOf(err);
      if (typeof code === 'string' && TOKEN_ERRORS.has(code))
        return this.refuse(res, code);
      this.logger.error(`${this.name}: cannot verify tokens: ${String(err)}`);
      return serviceUnavailable(res);
    }
    const identity = payload[this.claim];
    if (typeof identity !== 'string' || identity.length === 0)
      return this.refuse(res, `no "${this.claim}" claim`);
    const allowed = this.settings.jwt_allowed_client;
    if (allowed.length > 0 && !allowed.includes(identity)) {
      this.logger.warn(`${this.name}: client ${identity} is not allowed`);
      return forbidden(res);
    }
    this.publishIdentity(req, identity);
    next();
  }

  private async verified(token: string): Promise<JWTPayload> {
    const keys = await this.keySet();
    try {
      return (await jwtVerify(token, keys, this.verifyOptions)).payload;
    } catch (err) {
      // A set whose keys carry no `kid` can offer several candidates: jose
      // hands them over rather than trying each one
      if (codeOf(err) !== 'ERR_JWKS_MULTIPLE_MATCHING_KEYS') throw err;
      for await (const key of err as AsyncIterable<CryptoKey>) {
        try {
          return (await jwtVerify(token, key, this.verifyOptions)).payload;
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
  private keySet(): Promise<JWTVerifyGetKey> {
    if (this.keys && this.failedAt === undefined) return this.keys;
    if (
      this.failedAt !== undefined &&
      performance.now() - this.failedAt < AuthJwt.retryMs
    )
      return Promise.reject(new Error('discovery failed, retrying shortly'));
    this.failedAt = undefined;
    this.keys = this.locateJwks().then(uri => this.remoteSet(uri));
    this.keys.catch(() => {
      this.failedAt = performance.now();
    });
    return this.keys;
  }

  /**
   * jose caches the set for 10 minutes and fetches it again sooner for a
   * token naming a key it does not hold, at most every 30 seconds after a
   * success. After a failure it neither waits nor keeps the keys it held:
   * here a failed fetch is followed by {@link AuthJwt.retryMs} without fetching,
   * during which the last keys fetched still verify tokens.
   */
  private remoteSet(uri: URL): JWTVerifyGetKey {
    const remote = createRemoteJWKSet(uri, {
      ...AuthJwt.remoteOptions,
      [customFetch]: (url, init) => this.fetch(url, init),
    });
    let failedAt: number | undefined;
    const held: JWTVerifyGetKey = (...args) => {
      const jwks = remote.jwks();
      if (!jwks)
        return Promise.reject(
          new Error('the JWKS could not be fetched, retrying shortly')
        );
      return createLocalJWKSet(jwks)(...args);
    };
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
          `${this.name}: cannot fetch the JWKS: ${String(err)}`
        );
        failedAt = performance.now();
        return held(...args);
      }
    };
  }

  /** Read once: a provider moving its JWKS needs a restart */
  private async locateJwks(): Promise<URL> {
    if (this.jwksUri) return this.jwksUri;
    const issuer = this.issuer;
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
        `${where} names issuer ${JSON.stringify(document.issuer)}, not ${issuer}`
      );
    if (typeof document.jwks_uri !== 'string')
      throw new Error(`${where} names no jwks_uri`);
    return this.httpUrl(document.jwks_uri, `${where} jwks_uri`);
  }
}
