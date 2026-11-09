/**
 * The SCIM configuration another plugin shares, as far as it needs it.
 *
 * @see docs/plugin-development/services.md
 */
import { serviceToken } from './index.js';

export interface ScimApi {
  /** The attribute SCIM writes to lock an account, as configured. */
  readonly userLockAttribute: string;
  /** The value that marks the account locked, as configured. */
  readonly userLockValue: string;
}

export const ScimService = serviceToken<ScimApi>('scim');
