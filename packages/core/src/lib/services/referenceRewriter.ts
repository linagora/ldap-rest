/**
 * What a rename needs from the plugin that knows what references what.
 *
 * The references are opaque: they are found on one side and handed back on
 * the other.
 *
 * @see docs/plugin-development/services.md
 */
import type { Request } from 'express';

import { serviceToken } from './index.js';

export interface ReferenceRewriterApi {
  /** Every reference the directory holds to an entry, before it is renamed */
  findReferences(dn: string): Promise<unknown[]>;
  /** Point them all at the new DN, collecting what could not be written */
  rewriteReferences(
    references: unknown[],
    oldDn: string,
    newDn: string,
    req?: Request
  ): Promise<{
    updated: number;
    failed: { attribute: string; count: number }[];
  }>;
}

export const ReferenceRewriterService =
  serviceToken<ReferenceRewriterApi>('reference-rewriter');
