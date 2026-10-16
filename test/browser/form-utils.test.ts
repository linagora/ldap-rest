import { expect } from 'chai';

import {
  groupSchemaFields,
  listChanges,
  listValues,
} from '../../src/browser/shared/utils/form';
import type { SchemaAttribute } from '../../src/browser/shared/types';

describe('Browser form utils', () => {
  describe('groupSchemaFields', () => {
    it('should file a field under the text of a translated group', () => {
      const mailbox = {
        en: 'Mailbox Settings',
        fr: 'Paramètres de messagerie',
      };
      const schema: Record<string, SchemaAttribute> = {
        mailQuotaSize: { type: 'string', group: mailbox },
        twakeDeliveryMode: { type: 'pointer', group: { ...mailbox } },
        description: { type: 'string', group: 'Mailbox Settings' },
        cn: { type: 'string' },
      };
      const groups = groupSchemaFields(schema);
      expect([...groups.keys()]).to.deep.equal(['Mailbox Settings', 'default']);
      expect(
        groups.get('Mailbox Settings')!.map(([name]) => name)
      ).to.deep.equal(['mailQuotaSize', 'twakeDeliveryMode', 'description']);
    });
  });

  describe('listValues', () => {
    it('should read one value as a one-element list', () => {
      expect(listValues('uid=a,dc=x')).to.deep.equal(['uid=a,dc=x']);
    });

    it('should keep a list, as text, without empty rows', () => {
      expect(listValues(['a', '', 2, null])).to.deep.equal(['a', '2']);
    });

    it('should read nothing as an empty list', () => {
      for (const value of [undefined, null, '', []])
        expect(listValues(value)).to.deep.equal([]);
    });
  });

  describe('listChanges', () => {
    it('should name what was added and what was removed', () => {
      expect(listChanges(['a', 'b'], ['b', 'c'])).to.deep.equal({
        added: ['c'],
        removed: ['a'],
      });
    });

    it('should see no change from one value to the same list', () => {
      expect(listChanges('a', ['a'])).to.deep.equal({ added: [], removed: [] });
    });
  });
});
