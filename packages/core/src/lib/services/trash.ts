/**
 * The trash a delete moves entries to, as another plugin reads it.
 *
 * @see docs/plugin-development/services.md
 */
import { serviceToken } from './index.js';

export interface TrashApi {
  /** The branch deleted entries are moved to. */
  readonly trashBase: string;
  /** The branches the trash watches; empty means every branch. */
  readonly watchedBases: readonly string[];
}

export const TrashService = serviceToken<TrashApi>('trash');
