import { expect } from 'chai';

import LdapDepartmentSync from '../../../src/plugins/ldap/departmentSync';
import { DM } from '../../../src/bin';
import { getParentDn, isDnInBranch, normalizeDn } from '../../../src/lib/utils';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

type Attrs = Record<string, string>;

/**
 * An in-memory directory: DN-syntax values and bases compared as the
 * directory compares them.
 */
function memoryDirectory(server: DM, entries: Record<string, Attrs>): void {
  const all = Object.entries(entries).map(([dn, attrs]) => ({ dn, attrs }));
  const matches = (attrs: Attrs, filter = '(objectClass=*)'): boolean => {
    const [, attr, raw] = /^\(([^=]+)=(.*)\)$/.exec(filter)!;
    if (attr === 'objectClass') return true;
    if (!(attr in attrs)) return false;
    if (raw === '*') return true;
    const value = raw.replace(/\\([0-9a-f]{2})/gi, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16))
    );
    return normalizeDn(attrs[attr]) === normalizeDn(value);
  };
  (server as unknown as { ldap: unknown }).ldap = {
    system: {
      search: async (
        opts: { scope?: string; filter?: string; paged?: boolean },
        base: string
      ): Promise<unknown> => {
        const searchEntries = all
          .filter(e =>
            opts.scope === 'base'
              ? normalizeDn(e.dn) === normalizeDn(base)
              : isDnInBranch(e.dn, base)
          )
          .filter(e => matches(e.attrs, opts.filter))
          .map(e => ({ dn: e.dn, ...e.attrs }));
        const page = { searchEntries, searchReferences: [] };
        if (!opts.paged) return page;
        return (async function* (): AsyncGenerator<typeof page> {
          yield page;
        })();
      },
      modify: async (
        dn: string,
        changes: { replace: Attrs }
      ): Promise<void> => {
        Object.assign(
          all.find(e => normalizeDn(e.dn) === normalizeDn(dn))!.attrs,
          changes.replace
        );
      },
    },
  };
}

describe('LdapDepartmentSync: DN matching after a rename', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  let top: string;
  let base: string;

  before(() => {
    top = process.env.DM_LDAP_TOP_ORGANIZATION!;
    base = getParentDn(top);
  });

  const rename = async (
    entries: Record<string, Attrs>,
    oldDn: string,
    newDn: string
  ): Promise<void> => {
    const server = new DM();
    await server.ready;
    memoryDirectory(server, entries);
    const plugin = new LdapDepartmentSync(server);
    await (
      plugin.hooks.ldaprenamedone as (o: string, n: string) => Promise<void>
    )(oldDn, newDn);
  };

  it('leaves a link to an organization whose name holds an escaped comma', async () => {
    const outside = `ou=x\\,ou=Sales,${top}`;
    const entries: Record<string, Attrs> = {
      [`ou=Ventes,${top}`]: { ou: 'Ventes', twakeDepartmentPath: 'Ventes' },
      [outside]: { ou: 'x,ou=Sales', twakeDepartmentPath: 'x,ou=Sales' },
      [`ou=x\\,ou=Ventes,${top}`]: {
        ou: 'x,ou=Ventes',
        twakeDepartmentPath: 'x,ou=Ventes',
      },
      [`uid=u1,${base}`]: {
        twakeDepartmentLink: outside,
        twakeDepartmentPath: 'x,ou=Sales',
      },
    };

    await rename(entries, `ou=Sales,${top}`, `ou=Ventes,${top}`);

    expect(entries[`uid=u1,${base}`].twakeDepartmentLink).to.equal(outside);
    expect(entries[`uid=u1,${base}`].twakeDepartmentPath).to.equal(
      'x,ou=Sales'
    );
  });

  it('rewrites a link to a sub-organization written in another case', async () => {
    const entries: Record<string, Attrs> = {
      [`ou=Ventes,${top}`]: { ou: 'Ventes', twakeDepartmentPath: 'Sales' },
      [`ou=Dev,ou=Ventes,${top}`]: {
        ou: 'Dev',
        twakeDepartmentPath: 'Sales / Dev',
      },
      [`uid=u1,${base}`]: {
        twakeDepartmentLink: `ou=Dev,ou=sales,${top}`,
        twakeDepartmentPath: 'Sales / Dev',
      },
    };

    await rename(entries, `ou=Sales,${top}`, `ou=Ventes,${top}`);

    expect(normalizeDn(entries[`uid=u1,${base}`].twakeDepartmentLink)).to.equal(
      normalizeDn(`ou=Dev,ou=Ventes,${top}`)
    );
    expect(entries[`uid=u1,${base}`].twakeDepartmentPath).to.equal(
      'Ventes / Dev'
    );
  });

  for (const spelling of [
    'OU=Sales',
    '2.5.4.11 = Sales',
    'organizationalUnitName=Sales',
    'OID.2.5.4.11=Sales',
  ])
    it(`synchronises a rename written as ${spelling}`, async () => {
      const oldDn = `${spelling},${top}`;
      const entries: Record<string, Attrs> = {
        [`ou=Ventes,${top}`]: { ou: 'Ventes', twakeDepartmentPath: 'Sales' },
        [`uid=u1,${base}`]: {
          twakeDepartmentLink: `ou=Sales,${top}`,
          twakeDepartmentPath: 'Sales',
        },
      };

      await rename(entries, oldDn, `ou=Ventes,${top}`);

      expect(entries[`ou=Ventes,${top}`].twakeDepartmentPath).to.equal(
        'Ventes'
      );
      expect(entries[`uid=u1,${base}`].twakeDepartmentLink).to.equal(
        `ou=Ventes,${top}`
      );
      expect(entries[`uid=u1,${base}`].twakeDepartmentPath).to.equal('Ventes');
    });

  it('ignores the rename of an entry that is no organization', async () => {
    const entries: Record<string, Attrs> = {
      [`uid=u1,${base}`]: {
        twakeDepartmentLink: `uid=u2,${base}`,
        twakeDepartmentPath: 'Sales',
      },
    };

    await rename(entries, `uid=u2,${base}`, `uid=u3,${base}`);

    expect(entries[`uid=u1,${base}`].twakeDepartmentLink).to.equal(
      `uid=u2,${base}`
    );
  });
});
