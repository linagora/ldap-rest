import { copyFileSync, mkdirSync } from 'fs';

import packageConfig from '../../scripts/rollup.package.mjs';

export default packageConfig([
  {
    // `priority.json` is read as data, and the core package exports it at
    // its historical path: keep a copy beside the module Rollup emits.
    name: 'copy-priority',
    writeBundle() {
      mkdirSync('dist/config', { recursive: true });
      copyFileSync('src/config/priority.json', 'dist/config/priority.json');
    },
  },
]);
