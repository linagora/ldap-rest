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
 * Values a pattern is asked to read, in the shapes that made the shipped
 * ones quadratic: the value matching right up to a final character the
 * pattern refuses, at the length the bound lets through — the case a probe
 * of 20 000 characters never reaches, since it is refused on length alone.
 */
const longValues = (): string[] => {
  const half = Math.floor(DEFAULT_MAX_LENGTH / 2);
  return [
    // All points after the `@`: every one of them is a candidate separator for
    // the address patterns, which read the rest of the value at each
    `a@${'.'.repeat(DEFAULT_MAX_LENGTH - 2)}@`,
    `a@${'.a'.repeat(half)}@`,
    `Ressources${' humaines'.repeat(Math.floor(half / 9))}s`,
    `Ressources${' ab'.repeat(half)}s`,
    `R${'Abcdefghij'.repeat(Math.floor(half / 10))}s`,
    `${'a'.repeat(DEFAULT_MAX_LENGTH)}@`,
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

  it('refuses a trailing dot and an empty label, as the shipped patterns do', () => {
    // The rewrite that makes the address pattern linear also drops those two
    // shapes: pinned here, as an administrator sees them
    const mail = new RegExp(
      JSON.parse(readFileSync(join(schemaDir, 'twake/users.json'), 'utf-8'))
        .attributes.mail.test as string
    );
    for (const refused of ['a@b.c.', 'a@b..c', 'a@.b.c'])
      expect(mail.test(refused), refused).to.equal(false);
    for (const accepted of ['a@b.c', 'jane.doe@example.org', 'a@b.c.d'])
      expect(mail.test(accepted), accepted).to.equal(true);
  });

  it('bounds an attribute that declares a maxLength but no pattern', async () => {
    // Nothing else bounds a free-text attribute: a declared length must be
    // honoured, and the default must not apply where no pattern runs
    const validator = new EntityValidator(
      {
        attributes: {
          cn: { type: 'string', maxLength: 8 },
          sn: { type: 'string' },
        },
      } as unknown as Schema,
      {
        entryExists: async (): Promise<boolean> => true,
        loadedPlugins: {},
        singularName: 'person',
      }
    );
    try {
      await validator.validateChanges({ replace: { cn: 'a'.repeat(9) } });
      expect.fail('a value past the declared length should be refused');
    } catch (err) {
      expect((err as Error).message).to.match(/at most 8 characters/);
    }
    // No pattern, no declared length: the default does not apply
    for (const length of [10000, DEFAULT_MAX_LENGTH * 4]) {
      await validator.validateChanges({ replace: { sn: 'a'.repeat(length) } });
    }
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
      expect((err as Error).message).not.to.match(/Invalid value/);
    }
  });

  for (const file of schemaFiles()) {
    it(`accepts its own classes: ${file.slice(schemaDir.length + 1)}`, () => {
      // A pattern moved to the wrong attribute is caught here: every schema
      // names its own default classes, which its objectClass pattern must take
      const schema = JSON.parse(readFileSync(file, 'utf-8')) as Schema;
      const classes = schema.attributes?.objectClass?.default;
      if (!classes) return;
      expect(
        matchesPattern(schema.attributes.objectClass, classes),
        JSON.stringify(classes)
      ).to.equal(true);
      // A class is a definition name: `x-custom1` is one, a sentence is not.
      // Only checked where the schema declares a pattern at all, since a
      // schema may leave objectClass unconstrained
      const pattern = schema.attributes.objectClass.items?.test;
      if (!pattern) return;
      expect(
        matchesPattern(schema.attributes.objectClass, 'x-custom1'),
        'x-custom1'
      ).to.equal(true);
      expect(
        matchesPattern(schema.attributes.objectClass, 'twakePositionX'),
        'twakePositionX'
      ).to.equal(matchesPattern(schema.attributes.objectClass, 'top'));
    });
  }

  it('accepts the addresses and names the shipped patterns are meant for', () => {
    // The rewrite is a hardening, not a change of what a real value is: a
    // pattern that refused one of these would be caught here
    const schema = (path: string): Schema =>
      JSON.parse(readFileSync(join(schemaDir, path), 'utf-8')) as Schema;
    const accepts = (
      path: string,
      attribute: string,
      values: string[]
    ): void => {
      const attr = schema(path).attributes[attribute];
      for (const value of values)
        expect(
          matchesPattern(attr, value),
          `${path}#${attribute}: ${value}`
        ).to.equal(true);
    };
    accepts('twake/users.json', 'mail', [
      'jane.doe@example.org',
      'j@example.org',
      'jane@sub.example.org',
      'jean+tag@example.org',
    ]);
    accepts('twake/teamMailboxes.json', 'mail', ['team@example.org']);
    accepts('example/users.json', 'twakeOtherMailbox', ['box@example.org']);
    accepts('example/organizations.json', 'ou', [
      'Ressources humaines',
      'The Judiciary',
      'National Audit Office',
      'Ministry',
    ]);
  });

  for (const file of schemaFiles()) {
    const patterns = patternsOf(file);
    if (patterns.length === 0) continue;
    // Every pattern of the file, each with its own budget: a failure names
    // the attribute, where a total for the schema would only say "slow"
    for (const [attribute, pattern] of patterns) {
      it(`reads a long value in linear time: ${file.slice(schemaDir.length + 1)}#${attribute}`, () => {
        // Compiled as the server does: `getCompiledRegex` adds no flag
        const regex = new RegExp(pattern);
        const start = process.hrtime.bigint();
        for (const value of longValues()) regex.test(value);
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
        // A quadratic pattern takes tens of milliseconds at least on these
        // values — 26 ms for the address pattern this replaces — and the
        // shipped ones under a millisecond, with room for a slow runner
        expect(elapsed).to.be.below(5);
      });
    }
  }
});
