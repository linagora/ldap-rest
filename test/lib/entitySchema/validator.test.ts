/**
 * The messages and their order, on a schema in memory and a directory
 * reduced to a set of DNs.
 */
import { expect } from 'chai';

import type { Schema } from '../../../src/config/schema';
import { BadRequestError } from '../../../src/lib/errors';
import { EntityValidator } from '../../../src/lib/entitySchema/validator';

const users = 'ou=users,dc=example,dc=com';
const bob = `uid=bob,${users}`;
const nobody = `uid=nobody,${users}`;

const schema = {
  strict: true,
  attributes: {
    objectClass: {
      type: 'array',
      items: { type: 'string' },
      required: true,
      fixed: true,
    },
    uid: {
      type: 'string',
      required: true,
      test: '^[a-z]+$',
      hint: 'lower-case letters',
    },
    description: { type: 'string', required: true },
    businessCategory: { type: 'string', test: '^[a-z]+$' },
    l: { type: 'string', fixed: true, default: 'paris' },
    manager: { type: 'pointer', branch: [users] },
    secretary: { type: 'array', items: { type: 'pointer' } },
  },
} as unknown as Schema;

/** On `schema`, or on none for `null` */
const validator = (loaded: Schema | null = schema): EntityValidator =>
  new EntityValidator(loaded ?? undefined, {
    entryExists: async dn => dn === bob,
    loadedPlugins: {},
    singularName: 'person',
  });

/** The message of the 400 a call answers, or undefined when it passes */
const refusal = async (call: Promise<unknown>): Promise<string | undefined> => {
  try {
    await call;
    return undefined;
  } catch (err) {
    expect(err).to.be.instanceOf(BadRequestError);
    return (err as Error).message;
  }
};

const entry = (extra: Record<string, unknown> = {}): Record<string, any> => ({
  objectClass: ['top', 'inetOrgPerson'],
  uid: 'alice',
  description: 'A person',
  ...extra,
});

describe('EntityValidator', () => {
  describe('validateNew', () => {
    it('passes a valid entry and writes the fixed defaults', async () => {
      const candidate = entry({ l: 'lyon', manager: bob });
      expect(await refusal(validator().validateNew(candidate))).to.be.undefined;
      expect(candidate.l).to.equal('paris');
    });

    it('names an unknown attribute of a strict schema', async () => {
      expect(
        await refusal(validator().validateNew(entry({ x: 'y' })))
      ).to.equal('Unknown attribute "x" for person');
    });

    it('calls an empty required value missing before checking it', async () => {
      expect(
        await refusal(validator().validateNew(entry({ uid: '' })))
      ).to.equal('Attribute "uid" is required');
    });

    it('takes 0 and false for a required number and boolean', async () => {
      const numeric = {
        ...schema,
        attributes: {
          ...schema.attributes,
          n: { type: 'number', required: true },
          b: { type: 'boolean', required: true },
        },
      } as unknown as Schema;
      const candidate = entry({ n: 0, b: false });
      expect(await refusal(validator(numeric).validateNew(candidate))).to.be
        .undefined;
      expect(candidate.n).to.equal('0');
      expect(candidate.b).to.equal('FALSE');
    });

    it('leaves no null in the entry', async () => {
      const candidate = entry({ businessCategory: null });
      expect(await refusal(validator().validateNew(candidate))).to.be.undefined;
      expect(candidate.businessCategory).to.deep.equal([]);
    });

    it('names the first required attribute left out', async () => {
      const candidate = entry();
      delete candidate.description;
      expect(await refusal(validator().validateNew(candidate))).to.equal(
        'Attribute "description" is required'
      );
    });

    it('quotes the hint of a pattern', async () => {
      expect(
        await refusal(validator().validateNew(entry({ uid: 'Alice' })))
      ).to.equal('Invalid value for attribute "uid": lower-case letters');
    });
  });

  describe('validateChanges', () => {
    it('refuses a fixed attribute in every part', async () => {
      for (const changes of [
        { add: { l: 'lyon' } },
        { replace: { l: 'lyon' } },
      ])
        expect(await refusal(validator().validateChanges(changes))).to.equal(
          'Attribute "l" is fixed and cannot be modified'
        );
      expect(
        await refusal(validator().validateChanges({ delete: ['l'] }))
      ).to.equal('Attribute "l" is fixed and cannot be deleted');
    });

    it('names an unknown attribute of a strict schema', async () => {
      for (const changes of [{ replace: { x: 'y' } }, { delete: ['x'] }])
        expect(await refusal(validator().validateChanges(changes))).to.equal(
          'Unknown attribute "x" for person'
        );
    });

    it('refuses deleting a required attribute by name, not some of its values', async () => {
      expect(
        await refusal(validator().validateChanges({ delete: ['description'] }))
      ).to.equal('Attribute "description" is required');
      expect(
        await refusal(
          validator().validateChanges({ delete: { description: ['old'] } })
        )
      ).to.be.undefined;
    });

    it('clears an optional attribute with null, as the directory reads []', async () => {
      const changes = { replace: { businessCategory: null } } as any;
      expect(await refusal(validator().validateChanges(changes))).to.be
        .undefined;
      expect(changes.replace.businessCategory).to.deep.equal([]);
    });

    it('clears an optional attribute with no value, not a required one', async () => {
      expect(
        await refusal(
          validator().validateChanges({ replace: { businessCategory: [] } })
        )
      ).to.be.undefined;
      expect(
        await refusal(
          validator().validateChanges({ replace: { description: [] } })
        )
      ).to.equal('Attribute "description" is required');
    });

    it('checks the values of an add', async () => {
      expect(
        await refusal(
          validator().validateChanges({
            add: { businessCategory: 'Not Valid' },
          })
        )
      ).to.equal('Invalid value for attribute "businessCategory"');
    });
  });

  describe('validateValue, on a pointer', () => {
    for (const [value, message] of [
      [[bob, nobody], 'Attribute "manager" must be a single value'],
      ['', 'Attribute "manager" must point to a DN'],
      [
        'uid=bob,ou=groups,dc=example,dc=com',
        `Attribute "manager" must point to a DN within allowed branches: ${users}`,
      ],
      [
        nobody,
        `Attribute "manager" points to invalid or non-existent DN: ${nobody}`,
      ],
    ] as Array<[unknown, string]>) {
      it(`answers ${message.replace('Attribute "manager" ', '')}`, async () => {
        expect(
          await refusal(validator().validateValue('manager', value as string))
        ).to.equal(message);
      });
    }

    it('looks every element of an array of pointers up', async () => {
      expect(
        await refusal(validator().validateValue('secretary', [bob, nobody]))
      ).to.equal(
        `Attribute "secretary" points to invalid or non-existent DN: ${nobody}`
      );
      expect(await refusal(validator().validateValue('secretary', [bob]))).to.be
        .undefined;
    });
  });

  describe('validateValue, on a shape', () => {
    it('takes a list of one for a single value and one value for a list', async () => {
      expect(await validator().validateValue('description', ['a'])).to.equal(
        'a'
      );
      expect(await validator().validateValue('manager', [bob])).to.equal(bob);
      expect(
        await validator().validateValue('secretary', bob as unknown as string[])
      ).to.deep.equal([bob]);
    });

    for (const [field, value, message] of [
      ['description', ['a', 'b'], 'must be a single value'],
      ['description', 42, 'must be a string'],
      ['secretary', [42], 'must be a string'],
    ] as Array<[string, unknown, string]>) {
      it(`answers ${message} for ${JSON.stringify(value)} in ${field}`, async () => {
        expect(
          await refusal(validator().validateValue(field, value as string))
        ).to.equal(`Attribute "${field}" ${message}`);
      });
    }

    it('takes a number, an integer or a boolean as such or as its text', async () => {
      const numeric = {
        ...schema,
        attributes: {
          ...schema.attributes,
          n: { type: 'number' },
          i: { type: 'integer' },
          b: { type: 'boolean' },
        },
      } as unknown as Schema;
      const v = validator(numeric);
      for (const [field, value] of [
        ['n', 42],
        ['n', '4.2'],
        ['i', 7],
        ['i', '-7'],
        ['b', true],
        ['b', 'FALSE'],
      ] as Array<[string, unknown]>)
        expect(await refusal(v.validateValue(field, value as string)), field).to
          .be.undefined;
      for (const [field, value, message] of [
        ['n', 'abc', 'a number'],
        ['n', Infinity, 'a number'],
        ['i', 4.2, 'an integer'],
        ['i', '4.2', 'an integer'],
        ['b', 'yes', 'a boolean'],
      ] as Array<[string, unknown, string]>)
        expect(await refusal(v.validateValue(field, value as string))).to.equal(
          `Attribute "${field}" must be ${message}`
        );
    });
  });

  it('checks nothing without a schema', async () => {
    expect(await refusal(validator(null).validateNew(entry({ x: 'y' })))).to.be
      .undefined;
    expect(await refusal(validator(null).validateValue('x', ''))).to.be
      .undefined;
  });
});
