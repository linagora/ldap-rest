import { expect } from 'chai';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const root = path.join(__dirname, '..', '..');
const allowlist: string[] = JSON.parse(
  readFileSync(path.join(root, 'eslint-rules', 'route-allowlist.json'), 'utf8')
);

/** `app.get(`, `app.post(`… — what `defineRoute` replaces. */
const RAW_ROUTE = /app\.(get|post|put|patch|delete)\s*\(/;

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.ts') ? [full] : [];
  });

const declaresRawRoute = (file: string): boolean =>
  RAW_ROUTE.test(readFileSync(file, 'utf8'));

describe('route declaration guard', () => {
  it('lists only files that still declare a raw route', () => {
    for (const file of allowlist) {
      const full = path.join(root, file);
      expect(existsSync(full), `${file} exists`).to.equal(true);
      expect(declaresRawRoute(full), `${file} still declares one`).to.equal(
        true
      );
    }
  });

  it('leaves no raw route outside the allowlist', () => {
    const raw = [
      ...sources(path.join(root, 'src', 'plugins')),
      ...sources(path.join(root, 'src', 'abstract')),
    ]
      .filter(declaresRawRoute)
      .map(file => path.relative(root, file).split(path.sep).join('/'))
      .sort();

    expect(raw).to.deep.equal([...allowlist].sort());
  });
});
