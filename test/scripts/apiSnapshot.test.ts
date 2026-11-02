import { expect } from 'chai';

import { diffApiReports } from '../../scripts/api-snapshot';

function reportWith(imports: string[], ...blocks: string[]): string {
  return [
    '## API Report File for "ldap-rest"',
    '',
    '```ts',
    '',
    ...imports,
    '',
    ...blocks,
    '',
    '```',
    '',
  ].join('\n');
}

function report(...blocks: string[]): string {
  return reportWith(
    ['import type { Entry } from "ldapts";', 'import pLimit from "p-limit";'],
    ...blocks
  );
}

describe('API reports', () => {
  it('does not read the import header as a declaration', () => {
    const changes = diffApiReports(
      reportWith(
        ['import type { Entry } from "ldapts";'],
        '// @public\nexport type A = Entry;'
      ),
      reportWith(
        [
          'import type { Change } from "ldapts";',
          'import type { Entry } from "ldapts";',
        ],
        '// @public\nexport type A = Entry;'
      )
    );

    expect(changes).to.deep.equal({ removed: [], added: [], changed: [] });
  });

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

  it('does not call the rename of an unexported type a removal', () => {
    const changes = diffApiReports(
      report(
        '// @public\ninterface RouteDefinition { path: string; }',
        '// @public\nexport function defineRoute(route: RouteDefinition): void;'
      ),
      report(
        '// @public\ninterface RouteSpec { path: string; }',
        '// @public\nexport function defineRoute(route: RouteSpec): void;'
      )
    );

    expect(changes.removed).to.deep.equal([]);
    expect(changes.added).to.deep.equal(['RouteSpec']);
    expect(changes.changed).to.deep.equal(['RouteDefinition', 'defineRoute']);
  });

  it('keeps the removal of a namespace member nameable', () => {
    const changes = diffApiReports(
      report(
        '// @public\nfunction escapeDnValue(value: string): string;',
        '// @public\nfunction unescapeDnValue(value: string): string;\n\ndeclare namespace utils {\n    export {\n        escapeDnValue,\n        unescapeDnValue\n    }\n}\nexport { utils }'
      ),
      report(
        '// @public\nfunction escapeDnValue(value: string): string;\n\ndeclare namespace utils {\n    export {\n        escapeDnValue\n    }\n}\nexport { utils }'
      )
    );

    expect(changes.removed).to.deep.equal(['unescapeDnValue']);
  });

  it('keeps overloads of one name apart', () => {
    const changes = diffApiReports(
      report(
        '// @public\nexport function f(a: string): void;',
        '// @public\nexport function f(a: number): void;'
      ),
      report('// @public\nexport function f(a: string): void;')
    );

    expect(changes.removed).to.deep.equal(['f #2']);
    expect(changes.changed).to.deep.equal([]);
  });
});
