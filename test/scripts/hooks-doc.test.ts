import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

import {
  declaredHooks,
  differences,
  withoutCompiledAway,
} from '../../scripts/hooks-doc';

const root = path.join(__dirname, '..', '..');
const source = () =>
  fs.readFileSync(path.join(root, 'src', 'hooks.ts'), 'utf8');
const doc = () =>
  fs.readFileSync(
    path.join(root, 'docs', 'plugin-development', 'hooks.md'),
    'utf8'
  );

describe('the hooks document', () => {
  it('declares no hook the document leaves out', () => {
    expect(differences(source(), doc()).missing).to.deep.equal([]);
  });

  it('documents no hook `src/hooks.ts` no longer declares', () => {
    expect(differences(source(), doc()).unknown).to.deep.equal([]);
  });

  it('reads the hooks declared, whatever their position in the interface', () => {
    const declared = declaredHooks(
      [
        'export interface Hooks {',
        '  first?: (a: string) => void;',
        '  second?: ChainedHook<{ a: string; b: number }>;',
        '}',
      ].join('\n')
    );

    expect(declared).to.deep.equal(['first', 'second']);
  });

  it('reads hooks declared on one line, and ignores the nested types', () => {
    const declared = declaredHooks(
      [
        'export interface Hooks {',
        '  first?: (a: string) => void; second?: (b: { c: string }) => void;',
        '  third?: (e: Entry<{ deep: number }>) => Promise<void>;',
        '  wrap?: ChainedHook<{',
        '    a: string;',
        '  }>;',
        '  /** documented */',
        '  fourth?: () => void;',
        '}',
      ].join('\n')
    );

    expect(declared).to.deep.equal([
      'first',
      'second',
      'third',
      'wrap',
      'fourth',
    ]);
  });

  it('drops the entries of hooks no longer declared, and nothing else', () => {
    const written = withoutCompiledAway(
      'export interface Hooks {\n  kept?: () => void;\n}\n',
      [
        '# Hooks',
        '<!-- hooks: generated from src/hooks.ts, do not edit by hand -->',
        '- **kept**: described here',
        '- **gone**: described here too',
        '<!-- /hooks -->',
        'The rest.',
      ].join('\n')
    );

    expect(written).to.contain('- **kept**: described here');
    expect(written).not.to.contain('gone');
    expect(written).to.contain('The rest.');
  });
});
