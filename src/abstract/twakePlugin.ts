/**
 * Abstract base class for Twake integration plugins
 * Provides common HTTP request handling, concurrency control, and LDAP utilities
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import fetch from 'node-fetch';
import pLimit from 'p-limit';

import type { DM } from '../bin';
import type { AttributesList, SearchResult } from '../lib/ldapActions';

import DmPlugin, { type Role } from './plugin';

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
   * @param urlConfig Configuration key for WebAdmin URL
   * @param tokenConfig Configuration key for WebAdmin token
   * @param concurrencyConfig Configuration key for concurrency limit
   */
  constructor(
    server: DM,
    urlConfig: string,
    tokenConfig: string,
    concurrencyConfig: string
  ) {
    super(server);

    // Initialize HTTP client configuration
    this.webadminUrl = (this.config[urlConfig] as string) || '';
    this.webadminToken = (this.config[tokenConfig] as string) || '';

    // Validate required configuration
    if (!this.webadminUrl) {
      throw new Error(`Twake plugin: ${urlConfig} is required`);
    }

    // Warn if authentication token is not configured
    if (!this.webadminToken) {
      this.logger.warn(
        `Twake plugin: No authentication token configured (${tokenConfig}) - requests will be unauthenticated`
      );
    }

    // Initialize concurrency limiter
    const concurrency =
      typeof this.config[concurrencyConfig] === 'number'
        ? this.config[concurrencyConfig]
        : 10;
    this.requestLimit = pLimit(concurrency);
    this.logger.info(
      `Twake plugin HTTP request concurrency limit set to ${concurrency}`
    );

    // Cache common LDAP attributes
    this.mailAttr = (this.config.mail_attribute as string) || 'mail';
    this.displayNameAttr =
      (this.config.display_name_attribute as string) || 'displayName';
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
   */
  protected async callWebAdminApi(
    hookname: string,
    url: string,
    method: string,
    dn: string,
    body: string | null,
    fields: object,
    retryOn: readonly number[] = []
  ): Promise<void> {
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
        const res = await this.requestLimit(() => fetch(url, opts));

        if (res.ok) {
          this.logger.info({
            ...log,
            result: 'success',
            http_status: res.status,
            url,
          });
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
      return;
    }
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
    return statusCode === 409 && hookname.includes('Alias');
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

      const result = (await this.server.ldap.search(
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
