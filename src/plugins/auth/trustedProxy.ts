/**
 * @module core/auth/trustedProxy
 * Trusted proxy plugin to validate X-Forwarded-For headers
 *
 * This plugin validates that X-Forwarded-For headers only come from trusted
 * upstream reverse proxies. If the request comes from an untrusted IP,
 * the X-Forwarded-For header is removed to prevent IP spoofing attacks.
 *
 * This plugin MUST be loaded BEFORE any plugin that uses X-Forwarded-For
 * (like crowdsec and rateLimit) to ensure they receive sanitized headers.
 *
 * Configuration:
 * - trusted_proxy: Array of trusted proxy IPs or CIDR ranges (required)
 *   Example: ["127.0.0.1", "10.0.0.0/8", "192.168.1.0/24", "::1"]
 * - trusted_proxy_auth_header: Header name containing the authenticated user
 *   from trusted proxy (optional, default: "Auth-User")
 *
 * When a request comes from a trusted proxy:
 * - X-Forwarded-For header is preserved
 * - The request is marked as trusted (req.trustedProxy = true)
 * - If trusted_proxy_auth_header is set and the header is present,
 *   req.proxyAuthUser is set to its value for use by other plugins (e.g., weblogs)
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express, Request, Response, NextFunction } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';

// Extend Express Request to include trusted proxy info
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      trustedProxy?: boolean;
      proxyAuthUser?: string;
    }
  }
}

interface ParsedCIDR {
  ip: bigint;
  mask: bigint;
  isIPv6: boolean;
}

export default class TrustedProxy extends DmPlugin {
  name = 'trustedProxy';
  roles: Role[] = ['protect'] as const;
  private trustedNetworks: ParsedCIDR[] = [];
  private authHeader: string;

  constructor(...args: ConstructorParameters<typeof DmPlugin>) {
    super(...args);

    const trustedProxies = this.config.trusted_proxy;

    if (
      !trustedProxies ||
      !Array.isArray(trustedProxies) ||
      trustedProxies.length === 0
    ) {
      throw new Error(
        'TrustedProxy plugin requires trusted_proxy configuration (array of IPs or CIDR ranges)'
      );
    }

    // Parse all trusted proxy addresses/ranges
    for (const proxy of trustedProxies) {
      try {
        this.trustedNetworks.push(this.parseCIDR(proxy));
      } catch (error) {
        throw new Error(
          `Invalid trusted proxy address "${proxy}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Get auth header name (default: Auth-User)
    this.authHeader = (
      (this.config.trusted_proxy_auth_header as string) || 'Auth-User'
    ).toLowerCase();

    this.logger.info(
      `Trusted proxy validation enabled for ${trustedProxies.length} address(es): ${trustedProxies.join(', ')} (auth header: ${this.authHeader})`
    );
  }

  api(app: Express): void {
    // Middleware to validate X-Forwarded-For headers
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const remoteAddr = req.socket.remoteAddress;

      if (!remoteAddr) {
        // No remote address, remove X-Forwarded-For to be safe
        this.logger.debug('No remote address, removing X-Forwarded-For header');
        delete req.headers['x-forwarded-for'];
        return next();
      }

      // Check if request comes from a trusted proxy
      const xff = req.headers['x-forwarded-for'];
      if (this.isTrustedProxy(remoteAddr)) {
        // Mark request as coming from trusted proxy
        req.trustedProxy = true;

        // Extract auth user from header if present
        const authUser = req.headers[this.authHeader];
        if (authUser) {
          req.proxyAuthUser = Array.isArray(authUser) ? authUser[0] : authUser;
          this.logger.debug(
            `Request from trusted proxy ${remoteAddr}, Auth-User: ${req.proxyAuthUser}, X-Forwarded-For: ${xff ? String(xff) : '(none)'}`
          );
        } else {
          this.logger.debug(
            `Request from trusted proxy ${remoteAddr}, X-Forwarded-For: ${xff ? String(xff) : '(none)'}`
          );
        }
      } else {
        // Untrusted source: remove X-Forwarded-For to prevent spoofing
        req.trustedProxy = false;
        if (xff) {
          this.logger.warn(
            `Removing X-Forwarded-For header from untrusted source ${remoteAddr} (was: ${String(xff)})`
          );
          delete req.headers['x-forwarded-for'];
        }
      }

      next();
    });
  }

  /**
   * Check if an IP address belongs to a trusted proxy network
   */
  private isTrustedProxy(ip: string): boolean {
    try {
      const normalizedIp = this.normalizeIP(ip);
      const parsed = this.parseIP(normalizedIp);

      for (const network of this.trustedNetworks) {
        // Skip if IP versions don't match (unless it's a mapped IPv4)
        if (parsed.isIPv6 !== network.isIPv6) {
          continue;
        }

        if ((parsed.ip & network.mask) === (network.ip & network.mask)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.error(
        `Failed to parse IP address "${ip}": ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Normalize IP address (handle IPv4-mapped IPv6 addresses)
   */
  private normalizeIP(ip: string): string {
    // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
    const ipv4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (ipv4Mapped) {
      return ipv4Mapped[1];
    }
    return ip;
  }

  /**
   * Parse an IP address into a bigint for comparison
   */
  private parseIP(ip: string): { ip: bigint; isIPv6: boolean } {
    if (ip.includes(':')) {
      return { ip: this.parseIPv6(ip), isIPv6: true };
    }
    return { ip: this.parseIPv4(ip), isIPv6: false };
  }

  /**
   * Parse a CIDR notation string into network address and mask
   */
  private parseCIDR(cidr: string): ParsedCIDR {
    const [addr, prefixStr] = cidr.split('/');
    const isIPv6 = addr.includes(':');

    let ip: bigint;
    let mask: bigint;
    const maxPrefix = isIPv6 ? 128 : 32;

    if (isIPv6) {
      ip = this.parseIPv6(addr);
    } else {
      ip = this.parseIPv4(addr);
    }

    if (prefixStr !== undefined) {
      const prefix = parseInt(prefixStr, 10);
      if (isNaN(prefix) || prefix < 0 || prefix > maxPrefix) {
        throw new Error(`Invalid prefix length: ${prefixStr}`);
      }
      // Create mask with 'prefix' number of 1s followed by 0s
      if (prefix === 0) {
        mask = 0n;
      } else {
        const totalBits = BigInt(maxPrefix);
        mask =
          ((1n << totalBits) - 1n) ^
          ((1n << (totalBits - BigInt(prefix))) - 1n);
      }
    } else {
      // No prefix means exact match (all bits set)
      mask = isIPv6 ? (1n << 128n) - 1n : (1n << 32n) - 1n;
    }

    return { ip, mask, isIPv6 };
  }

  /**
   * Parse an IPv4 address into a bigint
   */
  private parseIPv4(ip: string): bigint {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }

    let result = 0n;
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) {
        throw new Error(`Invalid IPv4 address: ${ip}`);
      }
      result = (result << 8n) | BigInt(num);
    }

    return result;
  }

  /**
   * Parse an IPv6 address into a bigint
   */
  private parseIPv6(ip: string): bigint {
    // Expand :: shorthand
    let fullIp = ip;
    if (ip.includes('::')) {
      const parts = ip.split('::');
      if (parts.length > 2) {
        throw new Error(`Invalid IPv6 address: ${ip}`);
      }

      const left = parts[0] ? parts[0].split(':') : [];
      const right = parts[1] ? parts[1].split(':') : [];
      const missing = 8 - left.length - right.length;

      if (missing < 0) {
        throw new Error(`Invalid IPv6 address: ${ip}`);
      }

      const middle: string[] = Array(missing).fill('0') as string[];
      fullIp = [...left, ...middle, ...right].join(':');
    }

    const groups = fullIp.split(':');
    if (groups.length !== 8) {
      throw new Error(`Invalid IPv6 address: ${ip}`);
    }

    let result = 0n;
    for (const group of groups) {
      const num = parseInt(group || '0', 16);
      if (isNaN(num) || num < 0 || num > 0xffff) {
        throw new Error(`Invalid IPv6 address: ${ip}`);
      }
      result = (result << 16n) | BigInt(num);
    }

    return result;
  }
}
