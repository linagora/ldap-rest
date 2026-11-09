/**
 * The Twake tombstone, as another plugin reads it.
 *
 * @see docs/plugin-development/services.md
 */
import { serviceToken } from './index.js';

export interface TombstoneApi {
  /** Whether the tombstone keeps this DN from a plain delete. */
  keeps(dn: string): boolean;
}

export const TombstoneService = serviceToken<TombstoneApi>('tombstone');
