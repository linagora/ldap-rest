/**
 * The umbrella entry point: the core `DM`, with the full option set and the
 * plugin tree it loads.
 *
 * The core server knows only its own options and no plugin layout. Here,
 * where every plugin family is available, `core/x` resolves to the package
 * that provides it (`src/pluginModules.json`), and the demo plugin beside
 * this file answers for its own entry. The default template carries the core
 * options only: `bin/index.mjs` composes it with the plugins the command line
 * names. `test/helpers/dm.ts` keeps the complete set for a server a test
 * constructs. See `docs/development/modularization-plan.md`.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { DM as CoreDM, type ConfigTemplate } from '@ldap-rest/core';

import configArgs from '../options.js';
import pluginModules from '../pluginModules.json';

const here = dirname(fileURLToPath(import.meta.url));

export * from '@ldap-rest/core';

export class DM extends CoreDM {
  constructor(options: ConfigTemplate = configArgs) {
    super(options, join(here, '..', 'plugins'), here, pluginModules);
  }
}
