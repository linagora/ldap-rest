import { expect } from 'chai';

import { groupSchemaFields } from '../../src/browser/shared/utils/form';
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
});
