/**
 * The authentication plugins a server loaded, as another plugin reads them.
 *
 * @see docs/plugin-development/services.md
 */
import type AuthBase from '../auth/base.js';

import { serviceToken } from './index.js';

export interface AuthenticatorsInfo {
  /** The loaded authentication plugins, in registration order. */
  all(): readonly AuthBase[];
  /** Whether an authentication plugin with this name is loaded. */
  has(name: string): boolean;
  /**
   * The identities the loaded authenticators can publish, and those that
   * cannot say before a login.
   */
  coverage(): { known: Set<string>; unverifiable: string[] };
}

export const AuthenticatorsService =
  serviceToken<AuthenticatorsInfo>('authenticators');
