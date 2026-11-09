/**
 * The password policy branch, as another plugin reads it.
 *
 * @see docs/plugin-development/services.md
 */
import { serviceToken } from './index.js';

export interface PasswordPolicyApi {
  /** The branch holding the password policies. */
  policyBase(): string;
}

export const PasswordPolicyService =
  serviceToken<PasswordPolicyApi>('password-policy');
