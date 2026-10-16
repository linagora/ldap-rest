import { expect } from 'chai';

import {
  type Schema,
  toDirectoryChanges,
  toDirectoryEntry,
} from '../../src/config/schema';
import type { AttributesList, ModifyRequest } from '../../src/lib/ldapActions';

describe('toDirectoryValue', () => {
  const schema = {
    attributes: {
      quota: { type: 'number' },
      count: { type: 'integer' },
      reset: { type: 'boolean' },
      phones: { type: 'array', items: { type: 'number' } },
      mobile: { type: 'string' },
    },
  } as unknown as Schema;

  it('writes a number as text where the schema declares one', () => {
    const entry = { quota: 1000, count: 3, phones: [1, 2] } as unknown;
    toDirectoryEntry(schema, entry as AttributesList);
    expect(entry).to.deep.equal({
      quota: '1000',
      count: '3',
      phones: ['1', '2'],
    });
  });

  it('writes a boolean as TRUE / FALSE where the schema declares one', () => {
    const entry = { reset: false } as unknown;
    toDirectoryEntry(schema, entry as AttributesList);
    expect(entry).to.deep.equal({ reset: 'FALSE' });
  });

  it('leaves text, Buffers and null alone', () => {
    const buffer = Buffer.from('x');
    const entry = { mobile: 'a', quota: buffer, reset: null } as unknown;
    toDirectoryEntry(schema, entry as AttributesList);
    expect(entry).to.deep.equal({ mobile: 'a', quota: buffer, reset: null });
  });

  for (const [field, value] of [
    ['mobile', 5],
    ['mobile', true],
    ['quota', Number.NaN],
    ['quota', { n: 1 }],
    ['unknown', 1],
    ['phones', [1, 'x', true]],
  ] as const)
    it(`refuses ${String(value)} for ${field}`, () => {
      expect(() =>
        toDirectoryEntry(schema, {
          [field]: value,
        } as unknown as AttributesList)
      ).to.throw(
        `Attribute "${field}" must be a string or an array of strings`
      );
    });

  it('refuses a value that is not text without a schema', () => {
    expect(() =>
      toDirectoryEntry(undefined, { quota: 1 } as unknown as AttributesList)
    ).to.throw('must be a string');
  });

  it('converts every part of a modification', () => {
    const changes = {
      add: { quota: 1 },
      replace: { reset: true },
      delete: { count: 2 },
    } as unknown as ModifyRequest;
    toDirectoryChanges(schema, changes);
    expect(changes).to.deep.equal({
      add: { quota: '1' },
      replace: { reset: 'TRUE' },
      delete: { count: '2' },
    });
  });

  it('leaves a delete listing names alone', () => {
    const changes: ModifyRequest = { delete: ['quota'] };
    toDirectoryChanges(schema, changes);
    expect(changes).to.deep.equal({ delete: ['quota'] });
  });
});
