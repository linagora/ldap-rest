import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect } from 'chai';

const root = path.join(__dirname, '..', '..');

const lines = (file: string): number =>
  readFileSync(path.join(root, file), 'utf8').split('\n').length;

describe('LDAP operation file sizes', () => {
  it('keeps the façade under 400 lines', () => {
    expect(lines('src/lib/ldapActions.ts')).to.be.at.most(400);
  });

  it('keeps every pipeline file at 600 lines or less', () => {
    const directory = path.join(root, 'src', 'lib', 'ldap');
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts')) continue;
      expect(lines(path.join('src', 'lib', 'ldap', name)), name).to.be.at.most(
        600
      );
    }
  });
});
