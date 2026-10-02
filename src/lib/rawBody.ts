/**
 * The bytes of a request body, as the parsers ahead of the routes read them
 * @module lib/rawBody
 */
import type { IncomingMessage } from 'http';

/** A body as such a parser read it */
export interface RawBody {
  /** The bytes received, once Content-Encoding is removed */
  bytes: Buffer;
  /** The charset the parser decodes them with, lowercased */
  encoding: string;
}

const rawBodies = new WeakMap<IncomingMessage, RawBody>();

/**
 * body-parser `verify` callback keeping the bytes it read, and the charset it
 * decodes them with, for core/auth/hmac to hash what the client signed
 *
 * @param req the request
 * @param _res the response
 * @param bytes the body read
 * @param encoding the charset body-parser decodes it with: its own reading
 * of the Content-Type, or its default
 */
export function keepRawBody(
  req: IncomingMessage,
  _res: unknown,
  bytes: Buffer,
  encoding: string
): void {
  rawBodies.set(req, { bytes, encoding });
}

/**
 * The body a parser kept from a request, with `keepRawBody`.
 *
 * @param req the request
 * @returns it, or undefined when no parser kept it
 */
export function rawBodyOf(req: IncomingMessage): RawBody | undefined {
  return rawBodies.get(req);
}
