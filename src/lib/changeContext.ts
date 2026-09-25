/**
 * Who made a write, and through which door
 * @module lib/changeContext
 */
import { randomUUID } from 'crypto';

import type { Request } from 'express';

import type { DmRequest } from './auth/base';

export interface ChangeContext {
  /** The caller, under the name a person would use when there is one */
  actor?: string;
  /** Shared by every write of one request */
  requestId?: string;
  /** `rest`, `scim`, or what the plugin serving the request declared */
  source?: string;
}

const sources = new WeakMap<Request, string>();
const requestIds = new WeakMap<Request, string>();

/**
 * Declare the door a request came through, for the writes it makes.
 *
 * @param req the request
 * @param source its name, e.g. `scim`
 */
export function setChangeSource(req: Request, source: string): void {
  sources.set(req, source);
}

/**
 * The context of a write, handed to the "done" hooks.
 *
 * @param req the request behind the write; none for a scheduled task or a
 * message consumer, whose context is empty
 * @returns the context
 */
export function changeContext(req?: Request): ChangeContext {
  if (!req) return {};
  // Generated rather than read from an X-Request-Id header: a client could
  // otherwise make the writes of two requests look like one
  let requestId = requestIds.get(req);
  if (!requestId) {
    requestId = randomUUID();
    requestIds.set(req, requestId);
  }
  const { user, userName } = req as DmRequest;
  return {
    actor: userName ?? user,
    requestId,
    source: sources.get(req) ?? 'rest',
  };
}
