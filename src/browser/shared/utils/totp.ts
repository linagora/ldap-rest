/**
 * TOTP (Time-based One-Time Password) utility for browser
 * @module browser/shared/utils/totp
 */

/**
 * TOTP Generator configuration
 */
export interface TotpConfig {
  secret: string; // Base32 encoded secret
  digits?: number; // Number of digits (default: 6)
  step?: number; // Time step in seconds (default: 30)
}

/**
 * Generate a TOTP code from a Base32 secret
 */
export async function generateTotp(config: TotpConfig): Promise<string> {
  const digits = config.digits ?? 6;
  const step = config.step ?? 30;

  // Get current time counter
  const now = Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / step);

  return await generateTotpAtTime(config.secret, counter, digits);
}

/**
 * Generate a TOTP code for a specific counter value
 */
async function generateTotpAtTime(
  secret: string,
  counter: number,
  digits: number
): Promise<string> {
  // Decode Base32 secret
  const key = base32Decode(secret);

  // Convert counter to 8-byte array (big-endian)
  const counterBytes = new Uint8Array(8);
  const view = new DataView(counterBytes.buffer);
  view.setBigUint64(0, BigInt(counter), false); // false = big-endian

  // Import key for HMAC-SHA1
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  // Generate HMAC-SHA1
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, counterBytes);
  const hash = new Uint8Array(signature);

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
 * Decode a Base32 string to Uint8Array
 */
function base32Decode(input: string): Uint8Array {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  // Remove trailing padding characters (avoid ReDoS by using simple loop instead of regex)
  let cleanInput = input.toUpperCase();
  while (cleanInput.endsWith('=')) {
    cleanInput = cleanInput.slice(0, -1);
  }

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

  return new Uint8Array(output);
}

/**
 * Validate if a string is valid Base32
 */
export function isValidBase32(input: string): boolean {
  const base32Regex = /^[A-Z2-7]+=*$/i;
  return base32Regex.test(input);
}

/**
 * Get remaining seconds until next TOTP code
 */
export function getRemainingSeconds(step: number = 30): number {
  const now = Math.floor(Date.now() / 1000);
  return step - (now % step);
}

/**
 * TOTP Authentication Client
 * Provides HTTP client with TOTP authentication header
 */
export class TotpAuthClient {
  private config: Required<TotpConfig>;

  constructor(config: TotpConfig) {
    this.config = {
      secret: config.secret,
      digits: config.digits ?? 6,
      step: config.step ?? 30,
    };

    if (!isValidBase32(this.config.secret)) {
      throw new Error('Invalid Base32 secret');
    }
  }

  /**
   * Get current TOTP code
   */
  async getCode(): Promise<string> {
    return await generateTotp(this.config);
  }

  /**
   * Get Authorization header with Bearer token
   */
  async getAuthHeader(): Promise<string> {
    const code = await this.getCode();
    return `Bearer ${code}`;
  }

  /**
   * Perform an authenticated fetch request
   */
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const authHeader = await this.getAuthHeader();

    const headers = new Headers(options.headers);
    headers.set('Authorization', authHeader);

    return fetch(url, {
      ...options,
      headers,
    });
  }

  /**
   * Perform an authenticated GET request
   */
  async get(url: string, options: RequestInit = {}): Promise<Response> {
    return this.fetch(url, { ...options, method: 'GET' });
  }

  /**
   * Perform an authenticated POST request
   */
  async post(
    url: string,
    body?: unknown,
    options: RequestInit = {}
  ): Promise<Response> {
    const headers = new Headers(options.headers);

    if (body && typeof body === 'object') {
      headers.set('Content-Type', 'application/json');
    }

    return this.fetch(url, {
      ...options,
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Perform an authenticated PUT request
   */
  async put(
    url: string,
    body?: unknown,
    options: RequestInit = {}
  ): Promise<Response> {
    const headers = new Headers(options.headers);

    if (body && typeof body === 'object') {
      headers.set('Content-Type', 'application/json');
    }

    return this.fetch(url, {
      ...options,
      method: 'PUT',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Perform an authenticated DELETE request
   */
  async delete(url: string, options: RequestInit = {}): Promise<Response> {
    return this.fetch(url, { ...options, method: 'DELETE' });
  }

  /**
   * Perform an authenticated PATCH request
   */
  async patch(
    url: string,
    body?: unknown,
    options: RequestInit = {}
  ): Promise<Response> {
    const headers = new Headers(options.headers);

    if (body && typeof body === 'object') {
      headers.set('Content-Type', 'application/json');
    }

    return this.fetch(url, {
      ...options,
      method: 'PATCH',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}
