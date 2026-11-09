import { expect } from 'chai';

import {
  diffApiReports,
  stripCoreDeclarations,
} from '../../scripts/api-snapshot';

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

  it('names a namespace by itself, not after the function before it', () => {
    const changes = diffApiReports(
      report(
        '// @public\nfunction unescapeDnValue(value: string): string;',
        'declare namespace utils {\n    export {\n        escapeDnValue,\n        unescapeDnValue\n    }\n}\nexport { utils }'
      ),
      report(
        '// @public\nfunction unescapeDnValue(value: string): string;',
        'declare namespace utils {\n    export {\n        escapeDnValue\n    }\n}\nexport { utils }'
      )
    );

    expect(changes.changed).to.deep.equal(['utils']);
    expect(changes.removed).to.deep.equal([]);
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

describe('Package reports', () => {
  const coreConfig = '// @public\nexport interface Config {\n  a: string;\n}';
  const referenced = '// @public\ninterface Config {\n  a: string;\n}';
  const own = '// @public\nexport interface Only {\n  b: string;\n}';

  it('drops a referenced block identical to one in a core report', () => {
    const stripped = stripCoreDeclarations(
      report(referenced, own),
      new Set([coreConfig])
    );
    expect(stripped).to.not.contain('interface Config');
    expect(stripped).to.contain('export interface Only');
    expect(stripped.startsWith('## API Report File')).to.equal(true);
    expect(stripped.trimEnd().endsWith('```')).to.equal(true);
  });

  it('keeps a block the package exports, even with a core shape', () => {
    const stripped = stripCoreDeclarations(
      report(coreConfig),
      new Set([coreConfig])
    );
    expect(stripped).to.contain('export interface Config');
  });

  it('keeps a declaration sharing a core name with another shape', () => {
    const different = '// @public\ninterface Config {\n  b: string;\n}';
    const stripped = stripCoreDeclarations(
      report(different),
      new Set([coreConfig])
    );
    expect(stripped).to.contain('interface Config');
    expect(stripped).to.contain('b: string');
  });
});
