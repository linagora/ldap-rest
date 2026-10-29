/**
 * A schema pattern judges a value it can read. Handed a value of several
 * kilobytes, a pattern with overlapping parts walks it in quadratic time:
 * these tests pin that no pattern is asked to, and that the patterns shipped
 * read a long value in one pass.
 */
import { expect } from 'chai';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import type { Schema } from '../../src/config/schema';
import {
  DEFAULT_MAX_LENGTH,
  matchesPattern,
  maxLengthOf,
} from '../../src/config/schema';
import { EntityValidator } from '../../src/lib/entitySchema/validator';

const schemaDir = join(__dirname, '../../static/schemas');

/** Every schema file shipped, relative to `static/schemas` */
const schemaFiles = (dir = schemaDir): string[] =>
  readdirSync(dir, { recursive: true })
    .map(file => String(file))
    .filter(file => file.endsWith('.json'))
    .map(file => join(dir, file));

/** The `test` patterns of a schema, with where they are declared */
const patternsOf = (file: string): [string, string][] => {
  const schema = JSON.parse(readFileSync(file, 'utf-8')) as Schema;
  const found: [string, string][] = [];
  for (const [name, attr] of Object.entries(schema.attributes ?? {})) {
    if (typeof attr.test === 'string') found.push([name, attr.test]);
    if (typeof attr.items?.test === 'string')
      found.push([`${name}.items`, attr.items.test]);
  }
  return found;
};

/**
 * Values of `length` characters a pattern is asked to read: the shapes that
 * made the shipped patterns quadratic — a run of dots after the `@` of an
 * address, a run of space pairs inside a name — and one plain run.
 */
const longValues = (length: number): string[] => {
  const half = Math.floor(length / 2);
  return [
    `a@${'.a'.repeat(half)}@`,
    `Ressources${' humaines'.repeat(Math.floor(half / 9))}s`,
    `Ressources${' x'.repeat(half)}S`,
    `${'a'.repeat(length)}@`,
  ];
};

describe('Schema patterns and long values', () => {
  it('refuses a value longer than the attribute accepts, before any pattern', () => {
    // The bound is what keeps a deployment's own pattern from reading a
    // value it would walk in quadratic time
    expect(
      matchesPattern(
        { type: 'string', test: '^.*$' },
        'a'.repeat(DEFAULT_MAX_LENGTH + 1)
      )
    ).to.equal(false);
    expect(
      matchesPattern(
        { type: 'string', test: '^.*$' },
        'a'.repeat(DEFAULT_MAX_LENGTH)
      )
    ).to.equal(true);
  });

  it('takes a maxLength of its own, on the attribute or on its items', () => {
    expect(maxLengthOf({ type: 'string', maxLength: 10 })).to.equal(10);
    expect(
      maxLengthOf({ type: 'array', items: { type: 'string', maxLength: 20 } })
    ).to.equal(20);
    expect(
      matchesPattern({ type: 'string', test: '^a+$', maxLength: 3 }, 'aaaa')
    ).to.equal(false);
    expect(
      matchesPattern(
        {
          type: 'array',
          items: { type: 'string', test: '^a+$', maxLength: 3 },
        },
        ['a', 'aaaa']
      )
    ).to.equal(false);
  });

  it('names the length in the validator message, not the pattern', async () => {
    const validator = new EntityValidator(
      {
        attributes: {
          mail: { type: 'string', test: '^[^@]+@[^@]+$', maxLength: 16 },
        },
      } as unknown as Schema,
      {
        entryExists: async (): Promise<boolean> => true,
        loadedPlugins: {},
        singularName: 'person',
      }
    );
    try {
      await validator.validateChanges({
        replace: { mail: `${'a'.repeat(20)}@b` },
      });
      expect.fail('a value past the length should be refused');
    } catch (err) {
      expect((err as Error).message).to.match(/at most 16 characters/);
    }
  });

  for (const file of schemaFiles()) {
    const patterns = patternsOf(file);
    if (patterns.length === 0) continue;
    it(`reads a long value in linear time: ${file.slice(schemaDir.length + 1)}`, () => {
      const start = process.hrtime.bigint();
      for (const [, pattern] of patterns) {
        const regex = new RegExp(pattern, 'u');
        for (const length of [20000, 40000])
          for (const value of longValues(length)) regex.test(value);
      }
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      // A quadratic pattern needs seconds here: the shipped ones take under a
      // millisecond
      expect(elapsed).to.be.below(500);
    });
  }
});
