/**
 * A shipped pointer to reference data — a nomenclature value, a position —
 * says what deleting its target does to it (#394). Left at the default
 * (`ignore`), the target is deleted from under its referrers: a mail domain
 * organizations still link, after which no account can be created at it.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { expect } from 'chai';

interface Attribute {
  type?: string;
  branch?: string[];
  items?: Attribute;
  referentialIntegrity?: string;
}

const DIRS = ['./static/schemas/twake', './static/schemas/example'];

describe('Shipped pointers to reference data', () => {
  it('say what deleting their target does to them', () => {
    const silent: string[] = [];
    for (const file of DIRS.flatMap(dir =>
      readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => join(dir, f))
    )) {
      const schema = JSON.parse(readFileSync(file, 'utf8')) as {
        attributes?: Record<string, Attribute>;
      };
      for (const [name, attr] of Object.entries(schema.attributes ?? {})) {
        const pointer = attr.type === 'pointer' ? attr : attr.items;
        if (pointer?.type !== 'pointer') continue;
        const reference = (pointer.branch ?? []).some(branch =>
          /^ou=(positions|[^,]+,ou=nomenclature),/i.test(branch)
        );
        if (reference && !attr.referentialIntegrity)
          silent.push(`${file} ${name}`);
      }
    }
    expect(silent).to.deep.equal([]);
  });
});
