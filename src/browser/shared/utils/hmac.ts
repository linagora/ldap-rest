/**
 * HMAC-SHA256 request signing utility for browser
 * For backend services authentication
 * @module browser/shared/utils/hmac
 */

/**
 * HMAC Authentication configuration
 */
export interface HmacConfig {
  serviceId: string; // Service identifier
  secret: string; // Shared secret for HMAC
}

/**
 * Calculate SHA-256 hash of data
 */
async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Calculate HMAC-SHA256 signature
 */
async function hmacSha256(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);

  // Import secret as HMAC key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Calculate HMAC
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const signatureArray = Array.from(new Uint8Array(signature));
  return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate HMAC signature for a request
 *
 * Signature = HMAC-SHA256(secret, "METHOD|PATH|timestamp|body-hash")
 */
export async function generateHmacSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: number,
  body?: unknown
): Promise<string> {
  // Calculate body hash for POST/PATCH/PUT methods
  let bodyHash = '';
  const methodUpper = method.toUpperCase();

  if (
    body &&
    (methodUpper === 'POST' || methodUpper === 'PATCH' || methodUpper === 'PUT')
  ) {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    bodyHash = await sha256(bodyString);
  }

  // Create signing string: METHOD|PATH|timestamp|body-hash
  const signingString = `${methodUpper}|${path}|${timestamp}|${bodyHash}`;

  // Calculate HMAC-SHA256 signature
  return await hmacSha256(secret, signingString);
}

/**
 * HMAC Authentication Client
 * Provides HTTP client with HMAC-SHA256 request signing
 */
export class HmacAuthClient {
  private config: HmacConfig;

  constructor(config: HmacConfig) {
    this.config = config;

    if (!this.config.serviceId) {
      throw new Error('Service ID is required');
    }

    if (!this.config.secret || this.config.secret.length < 32) {
      throw new Error('Secret must be at least 32 characters long');
    }
  }

  /**
   * Generate Authorization header for a request
   *
   * Format: HMAC-SHA256 service-id:timestamp:signature
   */
  async getAuthHeader(
    method: string,
    path: string,
    body?: unknown
  ): Promise<string> {
    const timestamp = Date.now();
    const signature = await generateHmacSignature(
      this.config.secret,
      method,
      path,
      timestamp,
      body
    );

    return `HMAC-SHA256 ${this.config.serviceId}:${timestamp}:${signature}`;
  }

  /**
   * Extract path with query string from URL
   */
  private extractPath(url: string): string {
    try {
      const urlObj = new URL(url, window.location.origin);
      return urlObj.pathname + urlObj.search;
    } catch {
      // If URL parsing fails, assume it's already a path
      return url;
    }
  }

  /**
   * Perform an authenticated fetch request
   */
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const method = options.method || 'GET';
    const path = this.extractPath(url);

    // Get body for signature calculation
    let body: unknown = undefined;
    if (options.body) {
      if (typeof options.body === 'string') {
        body = options.body;
      } else if (options.body instanceof FormData) {
        // For FormData, we can't easily sign it, so skip body hash
        body = undefined;
      } else {
        body = options.body;
      }
    }

    const authHeader = await this.getAuthHeader(method, path, body);

    const headers = new Headers(options.headers);
    headers.set('Authorization', authHeader);

    return fetch(url, {
      ...options,
      headers,
    });
  }

  /**
   * Prepare request body and headers for methods with body
   */
  private prepareRequestBody(
    body: unknown,
    headers: Headers
  ): BodyInit | undefined {
    if (!body) {
      return undefined;
    }

    if (typeof body === 'string') {
      return body;
    }

    if (body instanceof FormData) {
      return body;
    }

    if (typeof body === 'object') {
      headers.set('Content-Type', 'application/json');
      return JSON.stringify(body);
    }

    return undefined;
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
    const requestBody = this.prepareRequestBody(body, headers);

    return this.fetch(url, {
      ...options,
      method: 'POST',
      headers,
      body: requestBody,
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
    const requestBody = this.prepareRequestBody(body, headers);

    return this.fetch(url, {
      ...options,
      method: 'PUT',
      headers,
      body: requestBody,
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
    const requestBody = this.prepareRequestBody(body, headers);

    return this.fetch(url, {
      ...options,
      method: 'PATCH',
      headers,
      body: requestBody,
    });
  }
}

/**
 * Verify the minimum recommended secret length
 */
export function isSecretSecure(secret: string): boolean {
  return secret.length >= 32;
}

/**
 * Generate a random secure secret for HMAC (for testing/development)
 * In production, secrets should be generated securely on the backend
 */
export async function generateRandomSecret(
  length: number = 64
): Promise<string> {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
