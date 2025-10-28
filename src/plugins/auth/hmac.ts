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
 *   - body-hash: SHA256(request_body) for POST/PATCH, empty for GET/DELETE
 *
 * @group Plugins
 */
import { createHmac, createHash, timingSafeEqual } from 'crypto';

import type { Response } from 'express';

import { unauthorized } from '../../lib/expressFormatedResponses';
import AuthBase, { type DmRequest } from '../../lib/auth/base';
import type { Role } from '../../abstract/plugin';

interface HmacService {
  id: string;
  secret: string;
  name: string;
}

export default class AuthHmac extends AuthBase {
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
        if (parts.length >= 3) {
          const id = parts[0].trim();
          const secret = parts[1].trim();
          const name = parts.slice(2).join(':').trim(); // Allow colons in name

          if (!id || !secret || !name) {
            this.logger.warn(
              `Invalid HMAC config at index ${index}: missing id, secret, or name`
            );
            return;
          }

          if (secret.length < 32) {
            this.logger.warn(
              `HMAC secret for service "${id}" is too short (minimum 32 characters recommended)`
            );
          }

          this.services.set(id, { id, secret, name });
        } else {
          this.logger.warn(
            `Invalid HMAC config format at index ${index}: expected "service-id:secret:name"`
          );
        }
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
    req.user = service.name;
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
   * Returns empty string for GET/DELETE/HEAD methods
   */
  private calculateBodyHash(req: DmRequest): string {
    const method = req.method.toUpperCase();

    // No body for these methods
    if (method === 'GET' || method === 'DELETE' || method === 'HEAD') return '';

    // Hash the body if present
    if (req.body) {
      const bodyString =
        typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const hash = createHash('sha256');
      hash.update(bodyString);
      return hash.digest('hex');
    }

    return '';
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
