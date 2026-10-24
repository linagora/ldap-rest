import { expect } from 'chai';

import type { DM } from '../../src/bin';
import { declaredMailDomains } from '../../src/lib/mailDomains';

describe('declaredMailDomains', () => {
  it('reads every page, whatever case the directory answers the attribute in', async () => {
    let asked: Record<string, unknown> | undefined;
    const pages = async function* (): AsyncGenerator<{
      searchEntries: Record<string, unknown>[];
    }> {
      yield { searchEntries: [{ dn: 'dc=a', associatedDomain: 'A.example' }] };
      yield {
        searchEntries: [
          { dn: 'dc=b', ASSOCIATEDDOMAIN: ['b.example', 'a.example'] },
        ],
      };
    };
    const server = {
      loadedPlugins: {},
      config: {
        ldap_base: 'dc=example,dc=com',
        enterprise_domain_name_attribute: 'associateddomain',
      },
      ldap: {
        system: {
          search: (options: Record<string, unknown>) => {
            asked = options;
            return Promise.resolve(pages());
          },
        },
      },
    } as unknown as DM;

    expect(await declaredMailDomains(server)).to.deep.equal([
      'a.example',
      'b.example',
    ]);
    // Paged, so a branch past the server's size limit is read whole
    expect(asked?.paged).to.deep.equal({ pageSize: 500 });
  });
});
