/**
 * @module plugins/auth/jwt
 *
 * Bearer JWT access tokens issued by an OAuth 2.0 / OpenID Connect provider,
 * checked against the provider's published keys: ldap-rest as a resource
 * server, for machine clients using the client_credentials grant.
 * See `docs/usage/plugins/auth/jwt.md`.
 * @group Plugins
 */
import type { Response } from 'express';
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

import AuthBase, { type DmRequest } from '../../lib/auth/base.js';
import {
  forbidden,
  serviceUnavailable,
  unauthorized,
} from '../../lib/expressFormatedResponses.js';
import type { Role } from '../../abstract/plugin.js';

import { JWT_ALGORITHMS, jwtOptions, type JwtOptions } from './auth.options.js';

/** How long a failed discovery is kept before the next request retries it */
const DISCOVERY_RETRY_MS = 30_000;
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
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

const BEARER = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

export default class AuthJwt extends AuthBase {
  static optionDefinitions = jwtOptions;

  name = 'authJwt';
  roles: Role[] = ['auth'] as const;

  private readonly settings: JwtOptions;
  private keys?: Promise<JWTVerifyGetKey>;
  private keysFailedAt = 0;

  constructor(...args: ConstructorParameters<typeof AuthBase>) {
    super(...args);
    this.settings = this.options(jwtOptions);
    const { jwt_issuer, jwt_algorithm, jwt_identity_claim } = this.settings;
    if (!jwt_issuer.trim())
      throw new Error(`${this.name}: --jwt-issuer is required`);
    if (!jwt_identity_claim.trim())
      throw new Error(`${this.name}: --jwt-identity-claim is empty`);
    if (jwt_algorithm.length === 0)
      throw new Error(`${this.name}: --jwt-algorithm lists no algorithm`);
    // HS* would verify with a public key read as an HMAC secret: anyone
    // holding the published key could sign tokens
    const refused = jwt_algorithm.filter(alg => !JWT_ALGORITHMS.includes(alg));
    if (refused.length > 0)
      throw new Error(
        `${this.name}: --jwt-algorithm ${refused.join(', ')} refused; ` +
          `known asymmetric algorithms: ${JWT_ALGORITHMS.join(', ')}`
      );
    for (const uri of [this.settings.jwt_jwks_uri, jwt_issuer])
      if (uri && !URL.canParse(uri))
        throw new Error(`${this.name}: "${uri}" is not a URL`);
  }

  protected knownIdentities(): string[] | undefined {
    const allowed = this.settings.jwt_allowed_client;
    return allowed.length > 0 ? allowed : undefined;
  }

  protected identitySource(): string {
    return `req.user and req.userName: the token's "${this.settings.jwt_identity_claim}" claim`;
  }

  afterLoad(): void {
    super.afterLoad();
    if (this.settings.jwt_audience.length === 0)
      this.logger.warn(
        `${this.name}: no --jwt-audience, so a token ${this.settings.jwt_issuer} ` +
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
    if (typeof alg !== 'string' || !this.settings.jwt_algorithm.includes(alg)) {
      this.logger.warn(
        `${this.name}: token refused: unreadable or alg not allowed`
      );
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return unauthorized(res);
    }
    let keys: JWTVerifyGetKey;
    try {
      keys = await this.keySet();
    } catch (err) {
      this.logger.error(`${this.name}: no signing keys: ${String(err)}`);
      return serviceUnavailable(res);
    }
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: this.settings.jwt_issuer,
        audience:
          this.settings.jwt_audience.length > 0
            ? this.settings.jwt_audience
            : undefined,
        algorithms: this.settings.jwt_algorithm,
        clockTolerance: this.settings.jwt_clock_tolerance,
        requiredClaims: ['exp'],
      }));
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string' && TOKEN_ERRORS.has(code)) {
        this.logger.warn(`${this.name}: token refused: ${code}`);
        res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
        return unauthorized(res);
      }
      this.logger.error(`${this.name}: cannot verify tokens: ${String(err)}`);
      return serviceUnavailable(res);
    }
    const identity = payload[this.settings.jwt_identity_claim];
    if (typeof identity !== 'string' || identity.length === 0) {
      this.logger.warn(
        `${this.name}: token refused: no "${this.settings.jwt_identity_claim}" claim`
      );
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return unauthorized(res);
    }
    const allowed = this.settings.jwt_allowed_client;
    if (allowed.length > 0 && !allowed.includes(identity)) {
      this.logger.warn(`${this.name}: client ${identity} is not allowed`);
      return forbidden(res);
    }
    this.publishIdentity(req, identity);
    next();
  }

  /**
   * The provider's keys, fetched once and refreshed by jose when a token
   * names a key it does not hold. A failed discovery is retried after a
   * delay, not on every request while the provider is down.
   */
  private keySet(): Promise<JWTVerifyGetKey> {
    if (
      !this.keys ||
      (this.keysFailedAt &&
        Date.now() - this.keysFailedAt >= DISCOVERY_RETRY_MS)
    ) {
      this.keysFailedAt = 0;
      this.keys = this.jwksUri().then(uri =>
        createRemoteJWKSet(uri, {
          [customFetch]: (url, init) => this.fetch(url, init),
        })
      );
      this.keys.catch(() => {
        this.keysFailedAt = Date.now();
      });
    }
    return this.keys;
  }

  private async jwksUri(): Promise<URL> {
    if (this.settings.jwt_jwks_uri) return new URL(this.settings.jwt_jwks_uri);
    const issuer = this.settings.jwt_issuer;
    const where = `${issuer.endsWith('/') ? issuer.slice(0, -1) : issuer}/.well-known/openid-configuration`;
    const response = await this.fetch(where, {
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
    if (
      typeof document.jwks_uri !== 'string' ||
      !URL.canParse(document.jwks_uri)
    )
      throw new Error(`${where} names no jwks_uri`);
    return new URL(document.jwks_uri);
  }
}
