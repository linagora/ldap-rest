/**
 * @module @ldap-rest/auth-trustedproxy
 * Trusted proxy plugin to validate X-Forwarded-For headers
 *
 * This plugin validates that X-Forwarded-For headers only come from trusted
 * upstream reverse proxies. If the request comes from an untrusted IP,
 * the X-Forwarded-For header is removed to prevent IP spoofing attacks.
 *
 * This plugin MUST be loaded BEFORE any plugin that needs the client
 * address (rate limiting, CrowdSec, access logs): it publishes `req.clientIp`
 * after reading the proxy chain from the right.
 *
 * Configuration:
 * - trusted_proxy: Array of trusted proxy IPs or CIDR ranges (required)
 *   Example: ["127.0.0.1", "10.0.0.0/8", "192.168.1.0/24", "::1"]
 * - trusted_proxy_auth_header: Header name containing the authenticated user
 *   from trusted proxy (optional, default: "Auth-User")
 *
 * When a request comes from a trusted proxy:
 * - X-Forwarded-For header is preserved
 * - The client address is published as `req.clientIp`
 * - The request is marked as trusted (req.trustedProxy = true)
 * - If trusted_proxy_auth_header is set and the header is present,
 *   req.proxyAuthUser is set to its value for use by other plugins (e.g., weblogs)
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { isIP } from 'node:net';

import type { Express, Request, Response, NextFunction } from 'express';
import DmPlugin, { type Role } from '@ldap-rest/core/abstract/plugin';

import { trustedProxyOptions } from './trustedProxy.options';

interface ParsedCIDR {
  ip: bigint;
  mask: bigint;
  isIPv6: boolean;
}

export default class TrustedProxy extends DmPlugin {
  static optionDefinitions = trustedProxyOptions;

  name = 'trustedProxy';
  roles: Role[] = ['protect'] as const;
  private trustedNetworks: ParsedCIDR[] = [];
  private authHeader: string;

  constructor(...args: ConstructorParameters<typeof DmPlugin>) {
    super(...args);

    const settings = this.options(trustedProxyOptions);
    const trustedProxies = settings.trusted_proxy;

    if (trustedProxies.length === 0) {
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
    this.authHeader = settings.trusted_proxy_auth_header.toLowerCase();

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
        req.clientIp = 'unknown';
        delete req.headers['x-forwarded-for'];
        return next();
      }

      // Check if request comes from a trusted proxy
      const xff = req.headers['x-forwarded-for'];
      if (this.isTrustedProxy(remoteAddr)) {
        // Mark request as coming from trusted proxy
        req.trustedProxy = true;
        req.clientIp = this.clientIpFromXff(xff, remoteAddr);

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
        req.clientIp = remoteAddr;
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
   * The client address in a proxy chain: walk `X-Forwarded-For` from the
   * right, skip the addresses this server trusts as proxies, and take the
   * first one it does not. A port is stripped from the entry (`ip:port`,
   * `[v6]:port`) since some proxies write one.
   *
   * An entry that is not an address stops the walk and the peer is used: the
   * entries to its left are the ones a client wrote, so continuing would let
   * it choose the address. A chain made only of trusted addresses falls back
   * to the peer too.
   *
   * @param xff the header as received from a trusted peer
   * @param remoteAddr the TCP peer
   * @returns the address to key rate limits and logs on
   */
  private clientIpFromXff(
    xff: string | string[] | undefined,
    remoteAddr: string
  ): string {
    if (!xff) return remoteAddr;
    const entries = (Array.isArray(xff) ? xff.join(',') : xff)
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
    for (let index = entries.length - 1; index >= 0; index--) {
      const candidate = this.forwardedAddress(entries[index]);
      if (!candidate) return remoteAddr;
      if (this.isTrustedProxy(candidate)) continue;
      return candidate;
    }
    return remoteAddr;
  }

  /**
   * An `X-Forwarded-For` entry as an address: a plain one, a bracketed IPv6
   * address, or either carrying a port. Anything else is undefined.
   */
  private forwardedAddress(entry: string): string | undefined {
    const text = entry.trim();
    if (!text) return undefined;
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
    if (bracketed) return isIP(bracketed[1]) === 0 ? undefined : bracketed[1];
    if (isIP(text) !== 0) return text;
    const withPort = /^([^:]+):\d+$/.exec(text);
    return withPort && isIP(withPort[1]) === 4 ? withPort[1] : undefined;
  }

  /**
   * Check if an IP address belongs to a trusted proxy network
   */
  private isTrustedProxy(ip: string): boolean {
    try {
      const parsed = this.parseIP(ip);

      for (const network of this.trustedNetworks) {
        if (this.isInNetwork(parsed, network)) return true;
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
   * Whether an address belongs to a network: same family, or an IPv4-mapped
   * IPv6 address checked as the IPv4 address it carries.
   */
  private isInNetwork(
    parsed: { ip: bigint; isIPv6: boolean },
    network: ParsedCIDR
  ): boolean {
    const candidates: bigint[] = [];
    if (parsed.isIPv6 === network.isIPv6) candidates.push(parsed.ip);
    if (parsed.isIPv6 && !network.isIPv6) {
      const carried = this.mappedIPv4(parsed.ip);
      if (carried !== undefined) candidates.push(carried);
    }
    return candidates.some(
      candidate => (candidate & network.mask) === (network.ip & network.mask)
    );
  }

  /**
   * The IPv4 address an IPv4-mapped IPv6 address carries
   * (`::ffff:a.b.c.d`), or undefined for another address.
   */
  private mappedIPv4(ip: bigint): bigint | undefined {
    return ip >> 32n === 0xffffn ? ip & 0xffffffffn : undefined;
  }

  /**
   * Parse an IP address into a bigint for comparison. A zone index names the
   * interface, not the address, and is dropped before the match.
   */
  private parseIP(ip: string): { ip: bigint; isIPv6: boolean } {
    const zone = ip.indexOf('%');
    const address = ip.includes(':') && zone !== -1 ? ip.slice(0, zone) : ip;
    const family = isIP(address);
    if (family === 6) return { ip: this.parseIPv6(address), isIPv6: true };
    if (family === 4) return { ip: this.parseIPv4(address), isIPv6: false };
    throw new Error(`Invalid IP address: ${ip}`);
  }

  /**
   * Parse a CIDR notation string into network address and mask. A network
   * written as an IPv4-mapped IPv6 network is checked as the IPv4 network it
   * is: `::ffff:10.0.0.0/104` is `10.0.0.0/8`.
   */
  private parseCIDR(cidr: string): ParsedCIDR {
    const slash = cidr.indexOf('/');
    const addr = slash === -1 ? cidr : cidr.slice(0, slash);
    const prefixStr = slash === -1 ? undefined : cidr.slice(slash + 1);

    // A zone index names the link an address is reached through: the same
    // address is another host on another link, so a network cannot be
    // honoured as written
    if (addr.includes('%')) {
      throw new Error(`Invalid network address: ${addr}`);
    }

    const parsed = this.parseIP(addr);
    let { isIPv6 } = parsed;
    let { ip } = parsed;
    let prefix: number | undefined;
    if (prefixStr !== undefined) {
      if (!/^\d{1,3}$/.test(prefixStr)) {
        throw new Error(`Invalid prefix length: ${prefixStr}`);
      }
      prefix = Number(prefixStr);
      if (prefix > (isIPv6 ? 128 : 32)) {
        throw new Error(`Invalid prefix length: ${prefixStr}`);
      }
    }

    // A fully mapped network is an IPv4 network, its prefix minus the 96
    // bits that carry the mapping; a mapped address with no prefix is an
    // exact IPv4 address
    if (isIPv6 && (prefix === undefined || prefix >= 96)) {
      const carried = this.mappedIPv4(ip);
      if (carried !== undefined) {
        isIPv6 = false;
        ip = carried;
        if (prefix !== undefined) prefix -= 96;
      }
    }

    const maxPrefix = isIPv6 ? 128 : 32;
    let mask: bigint;
    if (prefix === undefined) {
      // No prefix means exact match (all bits set)
      mask = (1n << BigInt(maxPrefix)) - 1n;
    } else if (prefix === 0) {
      mask = 0n;
    } else {
      const totalBits = BigInt(maxPrefix);
      mask =
        ((1n << totalBits) - 1n) ^ ((1n << (totalBits - BigInt(prefix))) - 1n);
    }

    return { ip, mask, isIPv6 };
  }

  /**
   * Parse an IPv4 address into a bigint
   */
  private parseIPv4(ip: string): bigint {
    if (isIP(ip) !== 4) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }

    return ip
      .split('.')
      .reduce((result, part) => (result << 8n) | BigInt(Number(part)), 0n);
  }

  /**
   * Parse an IPv6 address into a bigint
   */
  private parseIPv6(ip: string): bigint {
    if (isIP(ip) !== 6) {
      throw new Error(`Invalid IPv6 address: ${ip}`);
    }

    // A dotted tail is two groups: `::ffff:10.0.0.0` is `::ffff:a00:0`
    const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    let address = ip;
    if (dotted) {
      const tail = this.parseIPv4(dotted[2]);
      address = `${dotted[1]}${(tail >> 16n).toString(16)}:${(
        tail & 0xffffn
      ).toString(16)}`;
    }

    let groups: string[];
    const parts = address.split('::');
    if (parts.length > 2) {
      throw new Error(`Invalid IPv6 address: ${ip}`);
    }
    if (parts.length === 2) {
      const left = parts[0] ? parts[0].split(':') : [];
      const right = parts[1] ? parts[1].split(':') : [];
      const missing = 8 - left.length - right.length;
      if (missing < 0) {
        throw new Error(`Invalid IPv6 address: ${ip}`);
      }
      groups = [...left, ...Array<string>(missing).fill('0'), ...right];
    } else {
      groups = address.split(':');
    }

    if (groups.length !== 8) {
      throw new Error(`Invalid IPv6 address: ${ip}`);
    }

    let result = 0n;
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
        throw new Error(`Invalid IPv6 address: ${ip}`);
      }
      result = (result << 16n) | BigInt(parseInt(group, 16));
    }

    return result;
  }
}
