/**
 * The umbrella entry point: the core `DM`, with the full option set and the
 * plugin tree it loads.
 *
 * The core server knows only its own options and no plugin layout. Here,
 * where every plugin family is available, the default template is the
 * composed one and `core/x` resolves beside this file; a caller that embeds
 * the core directly passes its own. See
 * `docs/development/modularization-plan.md`.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { DM as CoreDM, type ConfigTemplate } from '@ldap-rest/core';

import configArgs from '../options';

const here = dirname(fileURLToPath(import.meta.url));

export * from '@ldap-rest/core';

export class DM extends CoreDM {
  constructor(options: ConfigTemplate = configArgs) {
    super(options, join(here, '..', 'plugins'), here);
  }
}
