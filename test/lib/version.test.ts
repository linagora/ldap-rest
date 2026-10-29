/**
 * The version a client compares with the range it supports must be the one
 * this package declares, wherever its `package.json` sits relative to the
 * running code: the repository root from the sources, the installed package
 * from the bundle. What the walk finds must therefore belong to this package.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { expect } from 'chai';

import { readVersion, SERVER_VERSION } from '../../src/lib/version';

describe('lib/version', () => {
  let dir: string;

  const write = (relative: string, content: string): void => {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  const walk = (relative: string): string | undefined =>
    readVersion(join(dir, relative));

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'version-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the version of the package it belongs to', () => {
    write(
      'package.json',
      JSON.stringify({ name: 'ldap-rest', version: '9.9.9' })
    );
    expect(walk('.')).to.equal('9.9.9');
  });

  it('ignores a package.json naming another package', () => {
    // A dependency's package.json would otherwise claim its version
    write(
      'package.json',
      JSON.stringify({ name: 'some-dependency', version: '0.0.1' })
    );
    write(
      'nested/package.json',
      JSON.stringify({ name: 'ldap-rest', version: '1.2.1' })
    );
    expect(walk('nested')).to.equal('1.2.1');
  });

  it('answers nothing when no package.json names this package', () => {
    write(
      'package.json',
      JSON.stringify({ name: 'some-dependency', version: '0.0.1' })
    );
    expect(walk('.')).to.equal(undefined);
  });

  it('keeps walking past a version that is only whitespace', () => {
    write('package.json', JSON.stringify({ name: 'ldap-rest', version: ' ' }));
    write(
      'nested/package.json',
      JSON.stringify({ name: 'ldap-rest', version: '1.2.1' })
    );
    expect(walk('nested')).to.equal('1.2.1');
  });

  it('keeps walking past a package.json it cannot parse', () => {
    write('package.json', '{ not json');
    write(
      'nested/package.json',
      JSON.stringify({ name: 'ldap-rest', version: '1.2.1' })
    );
    expect(walk('nested')).to.equal('1.2.1');
  });

  it('reads a package.json up to three directories above, and no further', () => {
    write(
      'p/package.json',
      JSON.stringify({ name: 'ldap-rest', version: '5.0.0' })
    );
    expect(walk('p/a/b/c')).to.equal('5.0.0');
    expect(walk('p/a/b/c/d')).to.equal(undefined);
  });

  it('finds the version of this repository from its own sources', () => {
    const declared = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../package.json'),
        'utf-8'
      )
    ) as { version: string };
    expect(SERVER_VERSION).to.equal(declared.version);
  });
});
