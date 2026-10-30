/**
 * Abstract base class for Twake integration plugins
 * Provides common HTTP request handling, concurrency control, and LDAP utilities
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Request } from 'express';
import pLimit from 'p-limit';

import type { DM } from '../bin';
import { PROBE_TIMEOUT_MS, type HealthStatus } from '../lib/health';
import type { AttributesList, SearchResult } from '../lib/ldapActions';
import { escapeLdapFilter } from '../lib/utils';

import DmPlugin, { type Role } from './plugin';

/** What a Twake plugin needs to reach its WebAdmin API */
export interface TwakeConnection {
  url: string;
  token: string;
  concurrency: number;
  /** Option holding the URL, named in the startup error when it is empty */
  urlOption: string;
  /** Option holding the token, named in the warning when it is empty */
  tokenOption: string;
  /** Option holding the concurrency, named when it is not a positive integer */
  concurrencyOption: string;
}

/**
 * Abstract base class for all Twake-related plugins (James, Calendar, Matrix, etc.)
 * Consolidates common patterns for HTTP communication with Twake WebAdmin APIs
 */
export abstract class TwakePlugin extends DmPlugin {
  // Abstract properties - must be implemented by subclasses
  abstract name: string;
  abstract roles: Role[];

  // Protected properties for subclass use
  protected webadminUrl: string;
  protected webadminToken: string;
  protected requestLimit: ReturnType<typeof pLimit>;
  // Attempts in all, and base delay in ms, of the calls given statuses to
  // retry on; a subclass that wants retries sets them
  protected retryAttempts = 1;
  protected retryDelay = 0;

  // Cached LDAP attribute names (commonly used across Twake plugins)
  protected mailAttr: string;
  protected displayNameAttr: string;

  /**
   * Constructor - initializes common Twake plugin configuration
   * @param server DM server instance
   * @param connection WebAdmin URL, token and concurrency
   */
  constructor(server: DM, connection: TwakeConnection) {
    super(server);

    let url = connection.url;
    while (url.endsWith('/')) url = url.slice(0, -1);
    this.webadminUrl = url;
    this.webadminToken = connection.token;

    // Validate required configuration
    if (!this.webadminUrl) {
      throw new Error(`Twake plugin: ${connection.urlOption} is required`);
    }

    // Warn if authentication token is not configured
    if (!this.webadminToken) {
      this.logger.warn(
        `Twake plugin: No authentication token configured (${connection.tokenOption}) - requests will be unauthenticated`
      );
    }

    // Initialize concurrency limiter
    const concurrency = connection.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error(
        `Twake plugin: ${connection.concurrencyOption} must be a positive integer`
      );
    this.requestLimit = pLimit(concurrency);
    this.logger.info(
      `Twake plugin HTTP request concurrency limit set to ${concurrency}`
    );

    // Cache common LDAP attributes
    this.mailAttr = this.config.mail_attribute || 'mail';
    this.displayNameAttr = this.config.display_name_attribute || 'displayName';
  }

  /**
   * Create HTTP headers with optional Authorization token
   * @param contentType Optional Content-Type header value
   * @returns Headers object
   */
  protected createHeaders(contentType?: string): {
    Authorization?: string;
    'Content-Type'?: string;
  } {
    const headers: { Authorization?: string; 'Content-Type'?: string } = {};
    if (this.webadminToken) {
      headers.Authorization = `Bearer ${this.webadminToken}`;
    }
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  /**
   * Call Twake WebAdmin API with concurrency control and error handling
   * @param hookname Hook name for logging
   * @param url Full URL to call
   * @param method HTTP method
   * @param dn LDAP DN for logging
   * @param body Request body (string or null)
   * @param fields Additional fields for logging
   * @param retryOn HTTP statuses worth another attempt, up to
   *   `retryAttempts` in all; none by default
   * @returns whether the call succeeded, an ignored error counting as a
   *   success; a failure is logged here, the caller decides what follows
   */
  protected async callWebAdminApi(
    hookname: string,
    url: string,
    method: string,
    dn: string,
    body: string | null,
    fields: object,
    retryOn: readonly number[] = []
  ): Promise<boolean> {
    const log = {
      plugin: this.name,
      event: hookname,
      result: 'error',
      dn,
      ...fields,
    };
    const opts: {
      method: string;
      body?: string | null;
      headers: {
        'Content-Type'?: string;
        Authorization?: string;
      };
    } = {
      method,
      headers: this.createHeaders(body ? 'application/json' : undefined),
    };

    if (body) {
      opts.body = body;
    }

    for (let attempt = 1; ; attempt++) {
      try {
        // The limiter holds a slot for the request only: a call waiting to
        // be retried must not keep the others from running
        const res = await this.requestLimit(() => this.fetch(url, opts));

        if (res.ok) {
          this.logger.info({
            ...log,
            result: 'success',
            http_status: res.status,
            url,
          });
          return true;
        } else if (this.shouldRetry(res.status, retryOn, attempt)) {
          this.logger.warn({
            ...log,
            result: 'retry',
            attempt,
            http_status: res.status,
            http_status_text: res.statusText,
            url,
          });
          await this.waitBeforeRetry(attempt);
          continue;
        } else if (this.shouldIgnoreError(res.status, hookname)) {
          // Allow subclasses to customize error handling
          this.logger.debug({
            ...log,
            result: 'ignored',
            http_status: res.status,
            http_status_text: res.statusText,
            url,
          });
          return true;
        } else {
          this.logger.error({
            ...log,
            ...(attempt > 1 ? { attempts: attempt } : {}),
            http_status: res.status,
            http_status_text: res.statusText,
            url,
          });
        }
      } catch (err) {
        this.logger.error({
          ...log,
          error: err,
          url,
        });
      }
      return false;
    }
  }

  /**
   * The service's own health check, for the readiness probe: `degraded`
   * when it answers an error, or not under the probe's budget, so that a
   * mute service reads as degraded rather than leaving the probe to time out
   */
  protected async webadminHealth(): Promise<HealthStatus> {
    try {
      const res = await this.fetch(`${this.webadminUrl}/healthcheck`, {
        headers: this.createHeaders(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS - 500),
      });
      return res.ok ? 'ok' : 'degraded';
    } catch {
      return 'degraded';
    }
  }

  /**
   * The user a route is asked about, by `uid` across the directory, with
   * `attributes`; null when there is none the caller may read, so that a
   * user the caller cannot read gets the answer a user that is not there
   * gets
   */
  protected async findReadableUser(
    username: string,
    req: Request,
    attributes: string[]
  ): Promise<AttributesList | null> {
    // As the server: found across branches, then answered only if the
    // caller can read it
    const found = (await this.server.ldap.system.search(
      {
        scope: 'sub',
        filter: `(uid=${escapeLdapFilter(username)})`,
        paged: false,
        attributes,
      },
      this.config.ldap_base || ''
    )) as SearchResult;
    for (const entry of found.searchEntries ?? [])
      if (await this.server.ldap.readableBy(String(entry.dn), req))
        return entry as AttributesList;
    return null;
  }

  /**
   * Whether a failed call is worth another attempt
   * @param statusCode HTTP status code of the failure
   * @param retryOn HTTP statuses the call retries on
   * @param attempt Number of the attempt that failed, from 1
   */
  protected shouldRetry(
    statusCode: number,
    retryOn: readonly number[],
    attempt: number
  ): boolean {
    return attempt < this.retryAttempts && retryOn.includes(statusCode);
  }

  /**
   * Wait before the attempt following `attempt`: `retryDelay` times the
   * number of attempts made, so that the waits grow linearly
   * @param attempt Number of the attempt that failed, from 1
   */
  protected waitBeforeRetry(attempt: number): Promise<void> {
    return new Promise(resolve =>
      setTimeout(resolve, this.retryDelay * attempt)
    );
  }

  /**
   * Override this method to customize error handling for specific status codes
   * @param statusCode HTTP status code
   * @param hookname Hook name that triggered the error
   * @returns true if error should be ignored
   */
  protected shouldIgnoreError(statusCode: number, hookname: string): boolean {
    // Default: 409 Conflict is acceptable for some operations (e.g., alias already exists)
    return statusCode === 409 && /alias/i.test(hookname);
  }

  /**
   * Helper to convert LDAP attribute value to string
   * @param value LDAP attribute value (string, Buffer, array, etc.)
   * @returns String value or null
   */
  protected attributeToString(value: unknown): string | null {
    if (!value) return null;
    if (Array.isArray(value)) {
      return value.length > 0 ? String(value[0]) : null;
    }
    return String(value as string | Buffer);
  }

  /**
   * Generic LDAP search utility to fetch specific attributes from a DN
   * Uses cache automatically for base-scope searches
   * @param dn The DN to fetch attributes from
   * @param attributes Optional array of attribute names to fetch
   * @returns AttributesList or null if not found
   */
  protected async ldapGetAttributes(
    dn: string,
    attributes?: string[]
  ): Promise<AttributesList | null> {
    try {
      const searchAttrs =
        attributes && attributes.length > 0 ? attributes : undefined;

      // As the server: what the integrations sync to their service, whoever's write triggered it
      const result = (await this.server.ldap.system.search(
        { paged: false, scope: 'base', attributes: searchAttrs },
        dn
      )) as SearchResult;

      if (result.searchEntries && result.searchEntries.length > 0) {
        return result.searchEntries[0] as AttributesList;
      }
      return null;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.debug(`Could not fetch attributes from DN ${dn}: ${err}`);
      return null;
    }
  }

  /**
   * Extract aliases from LDAP attribute value (handles AD format smtp:alias@domain.com)
   * @param value LDAP attribute value
   * @returns Array of normalized aliases
   */
  protected getAliases(
    value: string | string[] | Buffer | Buffer[] | undefined
  ): string[] {
    if (!value) return [];
    const aliases = Array.isArray(value) ? value : [value];
    return aliases
      .map(a => (Buffer.isBuffer(a) ? a.toString('utf-8') : String(a)))
      .map(a => this.normalizeAlias(a));
  }

  /**
   * Normalize email alias - handle AD format (smtp:alias@domain.com)
   * @param alias Email alias
   * @returns Normalized alias
   */
  protected normalizeAlias(alias: string): string {
    if (alias.toLowerCase().startsWith('smtp:')) {
      return alias.substring(5);
    }
    return alias;
  }

  /**
   * Extract domain from email address
   * @param email Email address
   * @returns Domain name or null
   */
  protected extractMailDomain(email: string): string | null {
    const parts = email.split('@');
    return parts.length === 2 ? parts[1] : null;
  }

  /**
   * Extract domain from LDAP DN (dc=example,dc=com -> example.com)
   * @param dn LDAP DN
   * @returns Domain name
   */
  protected extractDomainFromDn(dn: string): string {
    const dcMatches = dn.match(/dc=([^,]+)/gi);
    if (dcMatches) {
      return dcMatches.map(dc => dc.substring(3)).join('.');
    }
    return 'example.com';
  }
}

export default TwakePlugin;
