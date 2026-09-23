/**
 * @module plugins/auth/authzDynamic
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * LDAP-backed authentication + per-branch authorization plugin.
 *
 * Tokens are stored as entries under a dedicated LDAP branch (one entry per
 * bearer token). The plugin caches them and enforces read / write / delete
 * permissions on subsequent LDAP operations — so each client is scoped to
 * its own subtree without touching the process configuration.
 *
 * Entry shape (conventions, overridable via CLI):
 *   dn: cn=<token-name>,<authz-dynamic-base>
 *   cn: <token-name>
 *   userPassword: {SSHA}…             ← secret, hashed
 *   description: {"tenant":"acme",     ← JSON config
 *                "bases":[
 *                  {"dn":"ou=users,ou=acme,dc=example,dc=com",
 *                   "read":true,"write":true,"delete":true}
 *                ]}
 *
 * The entry is treated as "token for tenant `acme`, permitted to read/write/
 * delete under `ou=users,ou=acme,…`". Multiple bases per token are allowed.
 * Sub-branch matching is used (a permission on `ou=acme` covers
 * `ou=users,ou=acme`).
 */
import { AsyncLocalStorage } from 'async_hooks';

import type { Express, Response } from 'express';
import type { SearchOptions } from 'ldapts';

import { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import AuthBase, {
  type DmRequest,
  prefixCoversPath,
} from '../../lib/auth/base';
import { ForbiddenError } from '../../lib/errors';
import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions';
import type { Hooks } from '../../hooks';
import { ok, unauthorized } from '../../lib/expressFormatedResponses';
import { asyncHandler, getParentDn } from '../../lib/utils';

import { verifyLdapPassword } from './authzDynamicHash';

export interface BranchAcl {
  dn: string;
  read?: boolean;
  write?: boolean;
  delete?: boolean;
}

export interface TokenConfig {
  tenant?: string;
  bases?: BranchAcl[];
}

export interface TokenEntry {
  dn: string;
  cn: string;
  tenant: string;
  hash: string;
  bases: BranchAcl[];
}

/** Extends DmRequest with the resolved token entry for downstream hooks. */
export interface AuthzDynamicRequest extends DmRequest {
  authzToken?: TokenEntry;
}

/** A request whose verdict waits for the end of the authentication chain. */
interface PendingRequest extends AuthzDynamicRequest {
  authzDynamicPending?: boolean;
  authzDynamicPendingReason?: string;
}

/**
 * Per-request async context holding the authenticated token.
 *
 * Core plugins (ldapGroups, ldapFlat, etc.) do not always forward the Express
 * `req` object down to `ldapActions.search()` / `.modify()`. Relying solely
 * on `req` would therefore let un-tracked operations bypass authorization.
 * Using AsyncLocalStorage gives us a request-scoped, ambient handle that the
 * authz hooks can read regardless of whether the caller threaded `req`.
 */
export const authzContext = new AsyncLocalStorage<TokenEntry>();

function asString(v: AttributeValue | undefined): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    const first = v[0];
    return first == null
      ? undefined
      : Buffer.isBuffer(first)
        ? first.toString()
        : String(first);
  }
  if (Buffer.isBuffer(v)) return v.toString();
  return String(v);
}

/** Case-insensitive sub-branch membership: `dn` is at or under `branch`. */
function isAtOrUnder(dn: string, branch: string): boolean {
  const a = dn.toLowerCase().trim();
  const b = branch.toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(',' + b);
}

export default class AuthzDynamic extends AuthBase {
  name = 'authzDynamic';
  roles: Role[] = ['auth', 'authz', 'configurable'] as const;

  private tokens: TokenEntry[] = [];
  private lastLoad = 0;
  private lastFailure = 0;
  private readonly cacheTtlMs: number;
  private readonly failureBackoffMs: number;
  private readonly base: string;
  private readonly tokenAttr: string;
  private readonly configAttr: string;
  private readonly tenantAttr: string;
  private readonly reloadEndpoint: boolean;
  private loading?: Promise<void>;

  constructor(server: DM) {
    super(server);
    this.base = (this.config.authz_dynamic_base as string) || '';
    this.cacheTtlMs =
      ((this.config.authz_dynamic_cache_ttl as number) || 60) * 1000;
    // Backoff window after a failed reload, so that LDAP outages don't turn
    // into a per-request retry storm. Defaults to max(1/4 × TTL, 5s).
    this.failureBackoffMs = Math.max(Math.floor(this.cacheTtlMs / 4), 5000);
    this.tokenAttr =
      (this.config.authz_dynamic_token_attribute as string) || 'userPassword';
    this.configAttr =
      (this.config.authz_dynamic_config_attribute as string) || 'description';
    this.tenantAttr =
      (this.config.authz_dynamic_tenant_attribute as string) || 'cn';
    this.reloadEndpoint = Boolean(this.config.authz_dynamic_reload_endpoint);

    if (!this.base) {
      throw new Error(
        'authzDynamic requires --authz-dynamic-base (the LDAP branch holding token entries)'
      );
    }
  }

  api(app: Express): void {
    // Register the AuthBase middleware (runs authMethod per request).
    super.api(app);

    // The `serverError()` helper and DM's core error middleware both check
    // for the `[authz-forbidden]` marker (added to ForbiddenError messages
    // thrown by our hooks). Downstream plugins that wrap LDAP errors into
    // plain `new Error(...)` drop the original `statusCode`; the marker
    // preserves the semantic 403 across those wraps.

    if (this.reloadEndpoint) {
      const prefix = this.config.api_prefix || '/api';
      /**
       * @openapi
       * summary: Reload the authz-dynamic token cache
       * description: |
       *   Forces an immediate reload of all token entries from the LDAP
       *   branch configured via `--authz-dynamic-base`.
       *
       *   **Conditional registration:** this endpoint is only added to the
       *   router when the server was started with
       *   `--authz-dynamic-reload-endpoint true`.  It will be absent
       *   (404) otherwise.
       *
       *   **Authentication required:** the request must carry a valid
       *   `Authorization: Bearer <token>` header that matches an existing
       *   entry in the token cache.  An unauthenticated or unrecognised
       *   token receives a `401` response.
       *
       *   On success the response includes the number of tokens now held
       *   in the in-memory cache.  This count can be used to verify that
       *   the expected entries are present after adding or removing tokens
       *   in LDAP.
       * security:
       *   - BearerAuth: []
       * responses:
       *   '200':
       *     description: Cache reloaded successfully.
       *     content:
       *       application/json:
       *         schema:
       *           type: object
       *           required: [success, tokens]
       *           properties:
       *             success:
       *               type: boolean
       *               example: true
       *             tokens:
       *               type: integer
       *               description: Number of token entries now in the cache.
       *               example: 3
       *         example:
       *           success: true
       *           tokens: 3
       *   '401':
       *     description: Missing, invalid, or unrecognised bearer token.
       */
      app.post(
        `${prefix}/v1/authz-dynamic/reload`,
        asyncHandler(async (req, res) => {
          // Only an already-authenticated token may trigger reload.
          const typed = req as AuthzDynamicRequest;
          if (!typed.authzToken) {
            unauthorized(res);
            return;
          }
          await this.reload();
          ok(res, { success: true, tokens: this.tokens.length });
        })
      );
      this.logger.info(
        `authzDynamic reload endpoint registered at ${prefix}/v1/authz-dynamic/reload`
      );
    }
  }

  /**
   * Load token entries from LDAP. Swallows errors so a transient LDAP hiccup
   * does not poison the cache — the previous snapshot stays in use.
   */
  async reload(): Promise<void> {
    try {
      const attrs = Array.from(
        new Set(['dn', 'cn', this.tokenAttr, this.configAttr, this.tenantAttr])
      );
      const result = (await this.server.ldap.search(
        {
          filter: '(objectClass=*)',
          scope: 'sub',
          paged: false,
          attributes: attrs,
        },
        this.base
      )) as SearchResult;

      const next: TokenEntry[] = [];
      for (const entry of result.searchEntries || []) {
        const dn = typeof entry.dn === 'string' ? entry.dn : String(entry.dn);
        const cn = asString(entry.cn as AttributeValue) || '';
        const hash = asString(entry[this.tokenAttr] as AttributeValue) || '';
        if (!hash) continue; // skip container OUs / entries without secret

        // Tenant: prefer the `tenant` field in the JSON config, fall back to
        // the configured tenant attribute (default `cn`).
        let tenantFromJson: string | undefined;

        let bases: BranchAcl[] = [];
        const cfgRaw = asString(entry[this.configAttr] as AttributeValue);
        if (cfgRaw) {
          try {
            const parsed = JSON.parse(cfgRaw) as TokenConfig;
            if (parsed && typeof parsed.tenant === 'string' && parsed.tenant) {
              tenantFromJson = parsed.tenant;
            }
            if (parsed && Array.isArray(parsed.bases)) {
              bases = parsed.bases
                .filter(b => b && typeof b.dn === 'string' && b.dn.length > 0)
                .map(b => ({
                  dn: b.dn,
                  read: Boolean(b.read),
                  write: Boolean(b.write),
                  delete: Boolean(b.delete),
                }));
            }
          } catch (err) {
            this.logger.warn(
              `authzDynamic: invalid JSON in ${this.configAttr} of ${dn}: ${String(err)}`
            );
          }
        }

        const tenantFromAttr =
          this.tenantAttr === 'cn'
            ? cn
            : asString(entry[this.tenantAttr] as AttributeValue) || cn;
        const tenant = tenantFromJson || tenantFromAttr;

        next.push({ dn, cn, tenant, hash, bases });
      }

      this.tokens = next;
      this.lastLoad = Date.now();
      this.lastFailure = 0;
      this.logger.info(
        `authzDynamic: loaded ${next.length} token(s) from ${this.base}`
      );
    } catch (err) {
      this.lastFailure = Date.now();
      this.logger.error(
        `authzDynamic: failed to load tokens from ${this.base}: ${String(err)}`
      );
    }
  }

  /**
   * Ensure the cache is fresh (blocks if reloading).
   *
   * On a bootstrap or successful reload the cache is valid for
   * `cacheTtlMs`. If the load fails, we still refuse to retry on every
   * request — `failureBackoffMs` (default 1/4 of TTL, min 5 s) keeps the
   * previous snapshot in use and shields LDAP from a thundering-herd
   * during an outage.
   */
  private async ensureFresh(): Promise<void> {
    const now = Date.now();
    if (this.lastLoad > 0 && now - this.lastLoad < this.cacheTtlMs) return;
    // Under a current failure window, stick with the previous snapshot.
    if (
      this.lastFailure > 0 &&
      now - this.lastFailure < this.failureBackoffMs
    ) {
      return;
    }
    if (this.loading) return this.loading;
    this.loading = this.reload().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /**
   * Whether this request is allowed past the token ACLs without a token.
   *
   * The plugin used to step aside as soon as anything else had set
   * `req.user`, which is not a decision anyone wrote down: with
   * `core/auth/token` and this plugin both unscoped, the dispatcher runs the
   * token plugin first, it sets `req.user`, and every LDAP operation of that
   * request was then checked against no ACL at all — a branch-unrestricted
   * administrator. Registered the other way round, the same configuration
   * demanded both credentials. An ordering accident decided which.
   *
   * The comment that justified it named `trustedProxy + authzDynamic`, a
   * composition that never worked: `trustedProxy` sets `req.trustedProxy`
   * and `req.proxyAuthUser`, never `req.user`, so that pair never took this
   * path — while every authenticator that does set it, did.
   *
   * So the bypass is named now. `--authz-dynamic-bypass` lists the
   * identities that may skip the ACLs, plus `trusted-proxy` for the
   * composition the comment meant and `any-authenticated` for the old
   * behaviour, which a deployment relying on it can ask for in one line.
   *
   * @param req request being authenticated
   * @returns what allowed it past, or undefined when nothing does
   */
  private bypassReason(req: DmRequest): string | undefined {
    const allowed = (this.config.authz_dynamic_bypass as string[]) || [];
    if (allowed.length === 0) return undefined;
    // `trustedProxy` marks the *address* it trusts, and fills
    // `proxyAuthUser` only when the proxy named someone. Accepting the mark
    // alone would hand the whole directory to every host of a
    // `--trusted-proxy` range — `10.0.0.0/8` being all of it — with no token
    // and no ACL. The vouch has to name a caller.
    const proxied = req as DmRequest & {
      trustedProxy?: boolean;
      proxyAuthUser?: string;
    };
    if (
      allowed.includes('trusted-proxy') &&
      proxied.trustedProxy === true &&
      proxied.proxyAuthUser
    )
      return `trusted-proxy vouching for ${proxied.proxyAuthUser}`;
    if (!req.user) return undefined;
    if (allowed.includes('any-authenticated')) return 'any-authenticated';
    if (allowed.includes(req.user)) return `identity ${req.user}`;
    return undefined;
  }

  /**
   * Say, once and at startup, when a configuration is ambiguous.
   *
   * The dispatcher runs every authenticator claiming the winning prefix, so
   * this plugin sharing one with another means each request carries two
   * verdicts — and, before the bypass was named, which of them decided the
   * ACLs depended on registration order. A deployment reading as "tokens are
   * scoped to their tenant's branches" deserves to hear that on the first
   * line of its log rather than from an incident.
   */
  afterLoad(): void {
    const mine = this.pathPrefixes;
    const covers = (a: string[], b: string[]): boolean =>
      a.length === 0 ||
      b.length === 0 ||
      a.some(x =>
        b.some(y => x === y || prefixCoversPath(x, y) || prefixCoversPath(y, x))
      );
    const sharing = Object.values(this.server.loadedPlugins)
      .filter(
        plugin =>
          plugin !== this &&
          plugin.roles?.includes('auth') &&
          covers(mine, (plugin as AuthBase).pathPrefixes || [])
      )
      .map(plugin => plugin.name);
    if (sharing.length === 0) return;
    const bypass = (this.config.authz_dynamic_bypass as string[]) || [];
    this.logger.warn(
      `authzDynamic: ${sharing.join(', ')} authenticate the same paths as ` +
        'this plugin, so a request can arrive already identified. It is ' +
        (bypass.length === 0
          ? 'checked against the ACLs of the token it carries, and refused ' +
            'without one — set --authz-dynamic-bypass to let an identity ' +
            'through without a token.'
          : `let through without a token when it matches ${bypass.join(', ')} ` +
            '(--authz-dynamic-bypass), and checked against its token ACLs ' +
            'otherwise.')
    );
  }

  /**
   * The verdict `authMethod` could not reach on its own.
   *
   * A bypass is written in terms of the identity another authenticator
   * publishes, and the dispatcher runs them in registration order: asked
   * first, this plugin sees no identity yet and would refuse the very
   * request the bypass is for — order deciding the answer again, which is
   * the shape of the bug this fixes. So `authMethod` defers, and the
   * dispatcher calls this once every authenticator has run and before any
   * route: `req.user` is final here, and nothing has answered yet.
   *
   * A middleware of our own would not do. `api()` runs during registration,
   * and this plugin is not in `priority.json` — nor could it be, since a
   * named instance is matched by exact string and falls back into the
   * parallel batch — so the middleware would land wherever this plugin fell
   * among the others, and a route plugin registered first would answer
   * before the refusal.
   *
   * @param req request whose verdict was deferred
   * @param res response, ended when the request is refused
   * @param next continuation, called when it is allowed
   */
  afterChain(req: DmRequest, res: Response, next: () => void): void {
    const pending = req as PendingRequest;
    if (!pending.authzDynamicPending) return next();
    pending.authzDynamicPending = false;
    const bypass = this.bypassReason(pending);
    if (bypass) {
      this.logger.info(
        `authzDynamic: request allowed past the token ACLs (${bypass})`
      );
      return next();
    }
    // The reason the deferral was taken rather than a generic sentence: the
    // same request logs the same line whether or not a bypass is configured.
    this.logger.warn(
      pending.authzDynamicPendingReason ||
        'authzDynamic: no token on a request no bypass covers'
    );
    unauthorized(res);
  }

  /**
   * Refuse a request carrying no token of ours — unless a bypass may cover
   * it, in which case the verdict waits for the rest of the chain.
   *
   * A bypass names the identity another authenticator publishes, and the
   * dispatcher runs them in registration order: asked first, this plugin
   * sees no identity yet, and refusing there would make the answer depend on
   * that order again. So the request is marked and the middleware mounted in
   * `api()` decides, after every authenticator has run.
   *
   * @param req request with no usable token
   * @param res response, ended when the request is refused
   * @param next continuation, called when the verdict is deferred
   * @param warning what to log when it is refused outright
   */
  private refuseOrDefer(
    req: DmRequest,
    res: Response,
    next: () => void,
    warning: string
  ): void {
    const bypass = this.bypassReason(req);
    if (bypass) {
      this.logger.info(
        `authzDynamic: request allowed past the token ACLs (${bypass})`
      );
      next();
      return;
    }
    if (
      !req.user &&
      ((this.config.authz_dynamic_bypass as string[]) || []).length > 0
    ) {
      // Including a bearer nobody here knows: that is what another
      // authenticator's own credential looks like from in here, and it is
      // the case the deferral exists for. The refusal is only postponed —
      // and it keeps the sentence it would have been refused with.
      const pending = req as PendingRequest;
      pending.authzDynamicPending = true;
      pending.authzDynamicPendingReason = warning;
      next();
      return;
    }
    this.logger.warn(warning);
    unauthorized(res);
  }

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const bypass = this.bypassReason(req);
    if (bypass) {
      // No token, so no frame: the hooks find nothing and enforce nothing,
      // which is the point. Said out loud, since it is the one path where
      // this plugin lets an operation through unchecked.
      this.logger.info(
        `authzDynamic: request allowed past the token ACLs (${bypass})`
      );
      next();
      return;
    }
    void this.ensureFresh()
      .then(() => {
        const header = req.headers['authorization'];
        if (!header || !/^Bearer\s+/.test(header)) {
          this.refuseOrDefer(
            req,
            res,
            next,
            'authzDynamic: missing or invalid Authorization header'
          );
          return;
        }
        const token = header.slice(header.indexOf(' ') + 1).trim();
        if (!token) {
          this.refuseOrDefer(
            req,
            res,
            next,
            'authzDynamic: empty bearer token'
          );
          return;
        }

        // Linear scan — number of tokens is expected to be small (tens / low
        // hundreds). If scaling is ever needed, index by hash scheme buckets.
        let match: TokenEntry | undefined;
        for (const entry of this.tokens) {
          if (verifyLdapPassword(token, entry.hash)) {
            match = entry;
            break;
          }
        }

        if (!match) {
          const masked =
            token.length > 8 ? `${token.substring(0, 8)}...` : '***';
          // A bearer this plugin does not know may well be another
          // authenticator's credential — `core/auth/token`'s static token,
          // typically — so the bypass gets its say before the refusal.
          this.refuseOrDefer(
            req,
            res,
            next,
            `authzDynamic: unauthorized token ${masked}`
          );
          return;
        }

        // An identity another authenticator published is left in place:
        // the dispatcher ran it first, and the authorization plugins keyed
        // on `req.user` have already been configured for what it publishes.
        // What this plugin needs is its token on the request, so its own
        // ACLs are enforced — which is the whole point of not stepping
        // aside any more.
        req.user ??= match.tenant;
        (req as AuthzDynamicRequest).authzToken = match;
        // Run `next` (and everything downstream) inside an AsyncLocalStorage
        // frame so authz hooks can read the token even when plugins don't
        // thread `req` into ldapActions calls.
        authzContext.run(match, next);
      })
      .catch(err => {
        this.logger.error(`authzDynamic: authMethod error: ${String(err)}`);
        unauthorized(res);
      });
  }

  /**
   * Authorization hooks. These run after the auth middleware has populated
   * `req.authzToken`, so we can read the allowed bases directly from the
   * request.
   */
  hooks: Hooks = {
    ldapsearchrequest: ([base, opts, req]: [
      string,
      SearchOptions,
      DmRequest?,
    ]): [string, SearchOptions, DmRequest?] => {
      const token = this.activeToken(req);
      if (!token) return [base, opts, req];
      this.requireBranchPermission(token, base, 'read');
      return [base, opts, req];
    },

    ldapaddrequest: ([dn, entry, req]: [string, AttributesList, DmRequest?]): [
      string,
      AttributesList,
      DmRequest?,
    ] => {
      const token = this.activeToken(req);
      if (!token) return [dn, entry, req];
      this.requireBranchPermission(token, getParentDn(dn), 'write');
      return [dn, entry, req];
    },

    ldapmodifyrequest: ([dn, changes, opNumber, req]: [
      string,
      ModifyRequest,
      number,
      DmRequest?,
    ]): [string, ModifyRequest, number, DmRequest?] => {
      const token = this.activeToken(req);
      if (!token) return [dn, changes, opNumber, req];
      this.requireBranchPermission(token, getParentDn(dn), 'write');
      return [dn, changes, opNumber, req];
    },

    // Prefer the request-borne token; fall back to AsyncLocalStorage's active
    // token for callers that do not thread `req`. Enforce delete permission on
    // every target DN's parent branch.
    ldapdeleterequest: ([dn, req]: [string | string[], DmRequest?]): [
      string | string[],
      DmRequest?,
    ] => {
      const token = this.activeToken(req);
      if (!token) return [dn, req];
      const list = Array.isArray(dn) ? dn : [dn];
      for (const target of list) {
        this.requireBranchPermission(token, getParentDn(target), 'delete');
      }
      return [dn, req];
    },

    ldaprenamerequest: ([oldDn, newDn, req]: [string, string, DmRequest?]): [
      string,
      string,
      DmRequest?,
    ] => {
      const token = this.activeToken(req);
      if (!token) return [oldDn, newDn, req];
      this.requireBranchPermission(token, getParentDn(oldDn), 'read');
      this.requireBranchPermission(token, getParentDn(newDn), 'write');
      return [oldDn, newDn, req];
    },
  };

  /** Read the active token from the async context, or (as a fallback) from `req`. */
  private activeToken(req?: DmRequest): TokenEntry | undefined {
    return (
      authzContext.getStore() ||
      (req as AuthzDynamicRequest | undefined)?.authzToken
    );
  }

  /**
   * Throw a ForbiddenError (403) if the token cannot perform `permission` on
   * the branch containing `branchOrDn`. Any ACL entry that is `branchOrDn`
   * itself or a parent of it (sub-branch match) qualifies.
   *
   * The client-facing message omits the target DN to avoid leaking tenant
   * topology through authorization failures; the full context is still
   * logged server-side at debug level for operators.
   */
  private requireBranchPermission(
    token: TokenEntry,
    branchOrDn: string,
    permission: 'read' | 'write' | 'delete'
  ): void {
    for (const acl of token.bases) {
      if (!isAtOrUnder(branchOrDn, acl.dn)) continue;
      if (acl[permission]) return;
    }
    this.logger.debug(
      `authzDynamic: token "${token.tenant}" denied ${permission} on ${branchOrDn}`
    );
    // A marker in the message lets our Express error middleware recognise
    // this failure even after intermediate plugins (e.g. ldapGroups) wrap
    // the error into a plain `new Error(...)` — which would otherwise drop
    // `statusCode` and surface as a 500.
    throw new ForbiddenError(
      `[authz-forbidden] Token does not have ${permission} permission on this branch`
    );
  }

  /** Expose current cache (primarily for the configApi auto-discovery). */
  getConfigApiData(): Record<string, unknown> {
    return {
      enabled: true,
      base: this.base,
      cacheTtlSeconds: this.cacheTtlMs / 1000,
      tokenCount: this.tokens.length,
      reloadEndpoint: this.reloadEndpoint
        ? `${this.config.api_prefix || '/api'}/v1/authz-dynamic/reload`
        : undefined,
      tokenAttribute: this.tokenAttr,
      configAttribute: this.configAttr,
      tenantAttribute: this.tenantAttr,
      // Intentionally NOT exposing hashes or actual DNs of tokens
      // to avoid leaking tenant topology via the config endpoint.
    };
  }

  // Used internally by tests / eager refresh
  _tokens(): TokenEntry[] {
    return this.tokens;
  }
}
