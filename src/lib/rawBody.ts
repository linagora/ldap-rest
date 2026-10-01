/**
 * The bytes of a request body, as the global parsers read them
 * @module lib/rawBody
 */
import type { IncomingMessage } from 'http';

const rawBodies = new WeakMap<IncomingMessage, Buffer>();

/**
 * body-parser `verify` callback keeping the bytes it read, for
 * core/auth/hmac to hash what the client signed
 *
 * @param req the request
 * @param _res the response
 * @param buf the body read
 */
export function keepRawBody(
  req: IncomingMessage,
  _res: unknown,
  buf: Buffer
): void {
  rawBodies.set(req, buf);
}

/**
 * The bytes a global parser read from a request body.
 *
 * @param req the request
 * @returns them, or undefined when no global parser read the body
 */
export function rawBodyOf(req: IncomingMessage): Buffer | undefined {
  return rawBodies.get(req);
}
