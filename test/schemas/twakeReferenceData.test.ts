/**
 * A shipped pointer to reference data — a nomenclature value, a position —
 * keeps its target from being deleted while it names it (#394). Left at
 * the default (`ignore`), the target is deleted from under its referrers:
 * a mail domain organizations still link, after which no account can be
 * created at it.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { expect } from 'chai';

interface Attribute {
  type?: string;
  branch?: string[];
  items?: Attribute;
  referentialIntegrity?: string;
  default?: unknown;
}

const DIRS = ['./static/schemas/twake', './static/schemas/example'];

describe('Shipped pointers to reference data', () => {
  it('keep their target from being deleted while they name it', () => {
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
        const named =
          pointer?.type === 'pointer'
            ? (pointer.branch ?? [])
            : // A string holding a DN of reference data by default is one
              [attr.default].flat().filter(v => typeof v === 'string');
        const reference = named.some(dn =>
          /(^|,)ou=(positions|[^,]+,ou=nomenclature),/i.test(dn)
        );
        // Deleted from under its referrers, a value they still name
        // would name nothing: the delete is refused
        if (reference && attr.referentialIntegrity !== 'restrict')
          silent.push(`${file} ${name}`);
      }
    }
    expect(silent).to.deep.equal([]);
  });
});
