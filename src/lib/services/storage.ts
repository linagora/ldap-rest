/**
 * The one keyed store, as another plugin reads it.
 *
 * @see docs/plugin-development/services.md
 */
import type Store from '../storage/store';

import { serviceToken } from './index';

export interface StorageApi {
  readonly store: Store;
}

export const StorageService = serviceToken<StorageApi>('storage');
