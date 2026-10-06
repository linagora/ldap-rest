/**
 * @module plugins/auth/hmac
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * HMAC-SHA256 request signing authentication plugin
 * For backend services (Registration Service, admin panel backend, cloudery)
 *
 * Authorization: HMAC-SHA256 service-id:timestamp:signature
 *
 * Signature = HMAC-SHA256(secret, "METHOD|PATH|timestamp|body-hash")
 * where:
 *   - METHOD: HTTP method (GET, POST, PATCH, DELETE, etc.)
 *   - PATH: Request path with query string
 *   - timestamp: Unix timestamp in milliseconds
 *   - body-hash: SHA256 of the body bytes for POST/PATCH/PUT, empty for
 *     GET/DELETE/HEAD and for a request without a body
 *
 * @group Plugins
 */
import { createHmac, createHash, timingSafeEqual } from 'crypto';

import type { Response } from 'express';

import { unauthorized } from '../../lib/expressFormatedResponses';
import { rawBodyOf } from '../../lib/rawBody';
import AuthBase, { type DmRequest } from '../../lib/auth/base';
import type { Role } from '../../abstract/plugin';

interface HmacService {
  id: string;
  secret: string;
  name: string;
}

export default class AuthHmac extends AuthBase {
  protected knownIdentities(): string[] {
    return [...this.services.values()].map(service => service.name);
  }

  protected identitySource(): string {
    return 'req.user and req.userName: the service name given in --auth-hmac';
  }

  name = 'authHmac';
  roles: Role[] = ['auth'] as const;
  private services: Map<string, HmacService> = new Map();
  private timeWindow: number; // Time window in milliseconds for replay attack prevention

  constructor(...args: ConstructorParameters<typeof AuthBase>) {
    super(...args);

    // Parse HMAC configuration
    // Format: "service-id:secret:name"
    const hmacConfig = this.config.auth_hmac as string[];
    this.timeWindow = (this.config.auth_hmac_window as number) ?? 120000; // Default: 2 minutes

    if (hmacConfig && Array.isArray(hmacConfig)) {
      hmacConfig.forEach((entry, index) => {
        const parts = entry.split(':');
        const id = parts[0].trim();
        const secret = (parts[1] ?? '').trim();
        const name = parts.slice(2).join(':').trim(); // Allow colons in name
        if (parts.length < 3 || !id || !secret || !name)
          throw new Error(
            `Invalid --auth-hmac entry at index ${index}: expected ` +
              '"service-id:secret:name", none of them empty; entries are ' +
              'separated by `,`, `;` or newlines'
          );

        if (secret.length < 32) {
          this.logger.warn(
            `HMAC secret for service "${id}" is too short (minimum 32 characters recommended)`
          );
        }

        // A space-separated list read as one entry puts the other services in
        // the name
        if (parts.length > 4)
          this.logger.warn(
            `HMAC entry ${index} for service "${id}" has ${parts.length} ` +
              'fields: if several services were given, separate them with `,` or `;`'
          );

        this.services.set(id, { id, secret, name });
      });
    }

    if (this.services.size === 0) {
      this.logger.warn('No valid HMAC services configured');
    } else {
      this.logger.info(
        `HMAC authentication initialized with ${this.services.size} service(s): ${Array.from(this.services.keys()).join(', ')}`
      );
      this.logger.info(
        `Time window for replay protection: ${this.timeWindow}ms`
      );
    }
  }

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('HMAC-SHA256 ')) {
      this.logger.warn(
        'Missing or invalid Authorization header (expected HMAC-SHA256)'
      );
      return unauthorized(res);
    }

    // Extract: service-id:timestamp:signature
    const authValue = authHeader.substring('HMAC-SHA256 '.length);
    const parts = authValue.split(':');

    if (parts.length !== 3) {
      this.logger.warn(
        'Invalid HMAC authorization format (expected service-id:timestamp:signature)'
      );
      return unauthorized(res);
    }

    const [serviceId, timestampStr, providedSignature] = parts;

    // Validate service exists
    const service = this.services.get(serviceId);
    if (!service) {
      this.logger.warn(`Unknown service ID: ${serviceId}`);
      return unauthorized(res);
    }

    // Validate timestamp format
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp) || timestamp <= 0) {
      this.logger.warn(`Invalid timestamp: ${timestampStr}`);
      return unauthorized(res);
    }

    // Check timestamp is within allowed window (prevent replay attacks)
    const now = Date.now();
    const timeDiff = Math.abs(now - timestamp);

    if (timeDiff > this.timeWindow) {
      this.logger.warn(
        `Timestamp outside allowed window: ${timeDiff}ms (max: ${this.timeWindow}ms) for service ${serviceId}`
      );
      return unauthorized(res);
    }

    // Calculate body hash
    const bodyHash = this.calculateBodyHash(req);
    if (bodyHash === undefined) {
      // A body no parser kept (its route parses it, if at all, after
      // this check), one on a method signed without a body, or one under a
      // charset other than UTF-8. Hashing nothing would accept a signature
      // that does not cover the body the route then reads.
      this.logger.warn(
        `Refusing ${req.method} ${req.originalUrl || req.url} from service ${serviceId}: ` +
          `its body (${req.headers['content-type'] || 'no Content-Type'}) cannot be checked against the signature`
      );
      return unauthorized(res);
    }

    // Reconstruct signing string
    const method = req.method.toUpperCase();
    const path = req.originalUrl || req.url;
    const signingString = `${method}|${path}|${timestamp}|${bodyHash}`;

    // Calculate expected signature
    const expectedSignature = this.calculateHmac(service.secret, signingString);

    // Constant-time comparison to prevent timing attacks
    if (!this.secureCompare(providedSignature, expectedSignature)) {
      this.logger.warn(
        `Invalid signature for service ${serviceId} (${service.name}). ` +
          `Expected: ${expectedSignature.substring(0, 8)}..., ` +
          `Got: ${providedSignature.substring(0, 8)}...`
      );
      this.logger.debug(`Signing string: ${signingString}`);
      return unauthorized(res);
    }

    // Authentication successful
    this.logger.debug(
      `HMAC authentication successful for service: ${serviceId} (${service.name})`
    );
    this.publishIdentity(req, service.name);
    next();
  }

  /**
   * Calculate HMAC-SHA256 signature
   */
  private calculateHmac(secret: string, data: string): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(data);
    return hmac.digest('hex');
  }

  /**
   * Calculate SHA256 hash of request body
   * Returns empty string for GET/DELETE/HEAD methods, and undefined for a
   * body no parser kept, which cannot be checked
   */
  private calculateBodyHash(req: DmRequest): string | undefined {
    const method = req.method.toUpperCase();
    const raw = rawBodyOf(req);
    const length = parseInt(req.headers['content-length'] ?? '', 10);
    // A body no parser kept: its media type is not one they were given
    const unread =
      !raw && (req.headers['transfer-encoding'] !== undefined || length > 0);

    // Signed without a body: one they carry anyway would reach the route
    // unsigned
    if (method === 'GET' || method === 'DELETE' || method === 'HEAD')
      return raw?.bytes.length || unread ? undefined : '';

    if (unread) return undefined;
    if (!raw?.bytes.length) return '';

    // The signature covers the bytes, not the Content-Type saying how to read
    // them: the same bytes resent under another charset would be read as
    // other characters. The charset is the one the parser decodes with, not
    // a reading of the header of our own, which could disagree with it.
    if (raw.encoding !== 'utf-8') return undefined;

    // Hash the bytes received, as the client signed them
    return createHash('sha256').update(raw.bytes).digest('hex');
  }

  /**
   * Constant-time string comparison to prevent timing attacks
   */
  private secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    try {
      const bufA = Buffer.from(a, 'utf8');
      const bufB = Buffer.from(b, 'utf8');
      return timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }
}
