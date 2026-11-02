import { expect } from 'chai';

import { diffApiReports } from '../../scripts/api-snapshot';

function report(...blocks: string[]): string {
  return [
    '## API Report File for "ldap-rest"',
    '',
    '```ts',
    '',
    'import type { Entry } from "ldapts";',
    '',
    ...blocks,
    '',
    '```',
    '',
  ].join('\n');
}

describe('API reports', () => {
  it('reports a declaration that disappeared', () => {
    const changes = diffApiReports(
      report(
        '// @public\nexport class Kept {}',
        '// @public\nexport class Gone {}'
      ),
      report('// @public\nexport class Kept {}')
    );

    expect(changes.removed).to.deep.equal(['Gone']);
    expect(changes.added).to.deep.equal([]);
    expect(changes.changed).to.deep.equal([]);
  });

  it('reports a new declaration as additive', () => {
    const changes = diffApiReports(
      report('// @public\nexport type A = string;'),
      report(
        '// @public\nexport type A = string;',
        '// @public\nexport type B = number;'
      )
    );

    expect(changes.added).to.deep.equal(['B']);
    expect(changes.removed).to.deep.equal([]);
  });

  it('reports a changed signature without calling it removed', () => {
    const changes = diffApiReports(
      report('// @public\nexport function f(a: string): void;'),
      report('// @public\nexport function f(a: string, b?: number): void;')
    );

    expect(changes.changed).to.deep.equal(['f']);
    expect(changes.removed).to.deep.equal([]);
  });

  it('reads a re-exported name as its own declaration', () => {
    const changes = diffApiReports(
      report(
        '// @public\nexport interface Options {}\n\nexport { Options }',
        'export { SearchOptions }'
      ),
      report('// @public\nexport interface Options {}\n\nexport { Options }')
    );

    expect(changes.removed).to.deep.equal(['export { SearchOptions }']);
    expect(changes.changed).to.deep.equal([]);
  });

  it('names an unnamed declaration by its line', () => {
    const changes = diffApiReports(
      report('export { Removed }'),
      report('export { Kept }')
    );

    expect(changes.removed).to.deep.equal(['export { Removed }']);
  });
});
