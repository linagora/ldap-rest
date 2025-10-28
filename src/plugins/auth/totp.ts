/**
 * @module plugins/auth/totp
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * TOTP-based authentication plugin
 * @group Plugins
 */
import type { Response } from 'express';
import { createHmac } from 'crypto';

import { unauthorized } from '../../lib/expressFormatedResponses';
import AuthBase, { type DmRequest } from '../../lib/auth/base';
import type { Role } from '../../abstract/plugin';

interface TotpUser {
  name: string;
  secret: string; // Base32 encoded secret
  digits: number; // Number of digits in TOTP code
}

export default class AuthTotp extends AuthBase {
  name = 'authTotp';
  roles: Role[] = ['auth'] as const;
  private totpUsers: TotpUser[] = [];
  private window: number; // Time window for validation (±window * step seconds)
  private step: number; // Time step in seconds (typically 30)

  constructor(...args: ConstructorParameters<typeof AuthBase>) {
    super(...args);

    // Parse TOTP configuration
    const totpConfig = this.config.auth_totp as string[];
    this.window = this.config.auth_totp_window ?? 1;
    this.step = this.config.auth_totp_step ?? 30;

    if (totpConfig && Array.isArray(totpConfig)) {
      totpConfig.forEach((entry, index) => {
        const parts = entry.split(':');
        if (parts.length >= 2) {
          // Format: "secret:name" or "secret:name:digits"
          const secret = parts[0].trim();
          const name = parts[1].trim();
          const digits = parts[2] ? parseInt(parts[2].trim(), 10) : 6;

          if (!this.isValidBase32(secret)) {
            this.logger.warn(
              `Invalid Base32 secret for TOTP user "${name}" (index ${index})`
            );
            return;
          }

          if (digits < 6 || digits > 10) {
            this.logger.warn(
              `Invalid digits count for TOTP user "${name}": ${digits} (must be 6-10)`
            );
            return;
          }

          this.totpUsers.push({ name, secret, digits });
        } else {
          this.logger.warn(
            `Invalid TOTP config format at index ${index}: expected "secret:name[:digits]"`
          );
        }
      });
    }

    if (this.totpUsers.length === 0) {
      this.logger.warn('No valid TOTP users configured');
    } else {
      this.logger.info(
        `TOTP authentication initialized with ${this.totpUsers.length} user(s)`
      );
    }
  }

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    let authHeader = req.headers['authorization'];

    if (!authHeader || !/^Bearer .+/.test(authHeader)) {
      this.logger.warn('Missing or invalid Authorization header');
      return unauthorized(res);
    }

    const token = authHeader.split(' ')[1];

    // Try to validate token against all configured users
    for (const user of this.totpUsers) {
      if (this.verifyTotp(user.secret, token, user.digits)) {
        this.logger.debug(`TOTP authentication successful for user: ${user.name}`);
        req.user = user.name;
        return next();
      }
    }

    this.logger.warn(`Unauthorized TOTP token: ${token}`);
    return unauthorized(res);
  }

  /**
   * Verify a TOTP token against a secret
   */
  private verifyTotp(secret: string, token: string, digits: number): boolean {
    const now = Math.floor(Date.now() / 1000);

    // Check current time window and adjacent windows
    for (let i = -this.window; i <= this.window; i++) {
      const counter = Math.floor(now / this.step) + i;
      const expectedToken = this.generateTotp(secret, counter, digits);

      if (expectedToken === token) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate a TOTP token using HMAC-SHA1
   */
  private generateTotp(secret: string, counter: number, digits: number): string {
    // Decode Base32 secret
    const key = this.base32Decode(secret);

    // Convert counter to 8-byte buffer (big-endian)
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    // Generate HMAC-SHA1
    const hmac = createHmac('sha1', key);
    hmac.update(counterBuffer);
    const hash = hmac.digest();

    // Dynamic truncation (RFC 4226)
    const offset = hash[hash.length - 1] & 0x0f;
    const truncatedHash =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    // Generate N-digit code
    const code = truncatedHash % Math.pow(10, digits);
    return code.toString().padStart(digits, '0');
  }

  /**
   * Decode a Base32 string to Buffer
   */
  private base32Decode(input: string): Buffer {
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleanInput = input.toUpperCase().replace(/=+$/, '');

    let bits = 0;
    let value = 0;
    const output: number[] = [];

    for (let i = 0; i < cleanInput.length; i++) {
      const idx = base32Chars.indexOf(cleanInput[i]);
      if (idx === -1) {
        throw new Error(`Invalid Base32 character: ${cleanInput[i]}`);
      }

      value = (value << 5) | idx;
      bits += 5;

      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }

    return Buffer.from(output);
  }

  /**
   * Validate if a string is valid Base32
   */
  private isValidBase32(input: string): boolean {
    const base32Regex = /^[A-Z2-7]+=*$/;
    return base32Regex.test(input.toUpperCase());
  }
}
