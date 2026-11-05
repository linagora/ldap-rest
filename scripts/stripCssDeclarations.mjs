// See docs/development/contracts.md
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const CSS_IMPORT = /^import ['"][^'"]+\.css['"];\r?\n/gm;

function declarationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return declarationFiles(full);
    return entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

export default function stripCssDeclarations() {
  return {
    name: 'strip-css-declarations',
    writeBundle(options) {
      if (!options.dir) return;
      for (const file of declarationFiles(options.dir)) {
        const source = readFileSync(file, 'utf8');
        const stripped = source.replace(CSS_IMPORT, '');
        if (stripped !== source) writeFileSync(file, stripped);
      }
    },
  };
}
