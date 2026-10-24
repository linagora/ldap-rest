/**
 * Among one subject's branch rules, the most specific holding the target
 * applies, whatever order they were written in and whatever case or
 * spacing they spell the branch in.
 *
 * The first rule written used to win: a restriction on a sub-branch written
 * after the grant on its parent was ignored, and a search under the parent
 * returned what the restriction was meant to hide.
 */
import { expect } from 'chai';
import type { SearchResult } from 'ldapts';

import { DM } from '../../../src/bin';
import type { DmRequest } from '../../../src/lib/auth/base';
import { mostSpecificBranchRule } from '../../../src/lib/authz/base';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Branch rule precedence', function () {
  describe('mostSpecificBranchRule', () => {
    const rules: [string, string][] = [
      ['ou=acme,dc=example,dc=com', 'acme'],
      ['ou=payroll,ou=acme,dc=example,dc=com', 'payroll'],
    ];

    it('applies the narrowest branch, whatever order the rules are in', () => {
      for (const order of [rules, [...rules].reverse()]) {
        expect(
          mostSpecificBranchRule(
            order,
            'uid=x,ou=payroll,ou=acme,dc=example,dc=com'
          )
        ).to.equal('payroll');
        expect(
          mostSpecificBranchRule(
            order,
            'uid=y,ou=sales,ou=acme,dc=example,dc=com'
          )
        ).to.equal('acme');
      }
    });

    it('compares branches as DNs, whatever their case and spacing', () => {
      expect(
        mostSpecificBranchRule(
          [['OU=Payroll, ou=ACME,dc=example,dc=com', 'payroll']],
          'ou=payroll,ou=acme,dc=example,dc=com'
        )
      ).to.equal('payroll');
    });

    it('reads an escape as the directory spells it', () => {
      expect(
        mostSpecificBranchRule(
          [['ou=Sales\\, EMEA,ou=acme,dc=example,dc=com', 'sales']],
          'uid=x,ou=Sales\\2C EMEA,ou=acme,dc=example,dc=com'
        )
      ).to.equal('sales');
    });

    it('does not read an escaped comma as a separator', () => {
      // An entry named `cn=x\2Cou=pub` sits in the parent, not in `ou=pub`
      expect(
        mostSpecificBranchRule(
          [
            ['ou=acme,dc=example,dc=com', 'acme'],
            ['ou=pub,ou=acme,dc=example,dc=com', 'pub'],
          ],
          'cn=x\\2Cou=pub,ou=acme,dc=example,dc=com'
        )
      ).to.equal('acme');
    });

    it('holds nothing outside every branch', () => {
      expect(
        mostSpecificBranchRule(rules, 'ou=acme2,dc=example,dc=com')
      ).to.equal(null);
    });
  });

  describe('authzPerBranch', () => {
    const USER = 'precedence.user';
    let base: string;
    let acme: string;
    let payroll: string;
    let server: DM;
    let plugin: AuthzPerBranch;
    const previous: Record<string, string | undefined> = {};

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    });

    before(async function () {
      this.timeout(20000);
      base = process.env.DM_LDAP_BASE as string;
      acme = `ou=precacme,${base}`;
      payroll = `ou=precpayroll,${acme}`;
      for (const k of [
        'DM_AUTHZ_PER_BRANCH_CONFIG',
        'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
      ])
        previous[k] = process.env[k];
      process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
        default: { read: false, write: false, delete: false },
        users: {
          // The grant first, the restriction after it
          [USER]: {
            [acme]: { read: true, write: true, delete: true },
            [payroll.toUpperCase()]: {
              read: false,
              write: false,
              delete: false,
            },
          },
        },
        groups: {},
      });
      process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';
      server = new DM();
      await server.ready;
      for (const [dn, ou] of [
        [acme, 'precacme'],
        [payroll, 'precpayroll'],
      ])
        await server.ldap
          .add(dn, { objectClass: ['top', 'organizationalUnit'], ou })
          .catch(() => undefined);
      for (const [dn, uid] of [
        [`uid=prec-sales,${acme}`, 'prec-sales'],
        [`uid=prec-pay,${payroll}`, 'prec-pay'],
      ])
        await server.ldap
          .add(dn, {
            objectClass: ['top', 'inetOrgPerson'],
            uid,
            cn: uid,
            sn: uid,
          })
          .catch(() => undefined);
      plugin = new AuthzPerBranch(server);
      await server.registerPlugin('authzPerBranch', plugin);
    });

    after(async () => {
      for (const dn of [
        `uid=prec-pay,${payroll}`,
        `uid=prec-sales,${acme}`,
        payroll,
        acme,
      ])
        await server.ldap.delete(dn).catch(() => undefined);
      for (const [k, v] of Object.entries(previous))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    });

    it('applies a restriction written after the grant on its parent', async () => {
      expect(
        await plugin.getUserPermissions(USER, `uid=prec-pay,${payroll}`)
      ).to.deep.equal({ read: false, write: false, delete: false });
      expect(
        (await plugin.getUserPermissions(USER, `uid=prec-sales,${acme}`)).write
      ).to.equal(true);
    });

    it('keeps the restricted entries out of a search under the parent', async () => {
      const req = { user: USER, headers: {} } as unknown as DmRequest;
      const found = (await server.ldap.search(
        {
          paged: false,
          scope: 'sub',
          filter: '(objectClass=inetOrgPerson)',
          attributes: ['uid'],
        },
        acme,
        req
      )) as SearchResult;
      const uids = found.searchEntries.map(entry => entry.uid);
      expect(uids).to.include('prec-sales');
      expect(uids).to.not.include('prec-pay');
    });

    it('holds the restriction whatever the attribute type is called', async () => {
      const req = { user: USER, headers: {} } as unknown as DmRequest;
      for (const spelled of [
        `organizationalUnitName=precpayroll,${acme}`,
        `2.5.4.11=precpayroll,${acme}`,
        // LDAPv2, which OpenLDAP still reads
        `ou=precpayroll;${acme}`,
        `ou="precpayroll",${acme}`,
        // Spaces the matching rule ignores
        `ou=precpayroll\\20,${acme}`,
        `ou=\\20precpayroll,${acme}`,
      ]) {
        // Refused outright, as the same search spelled `ou=`
        let refused: unknown;
        await server.ldap
          .search(
            { paged: false, scope: 'sub', attributes: ['uid'] },
            spelled,
            req
          )
          .catch((err: unknown) => (refused = err));
        expect(String(refused), spelled).to.match(/forbidden/i);
        for (const write of [
          () =>
            server.ldap.modify(
              `uid=prec-pay,${spelled}`,
              { replace: { description: 'x' } },
              req
            ),
          () => server.ldap.rename(spelled, `ou=precmoved,${acme}`, req),
        ]) {
          let error: unknown;
          await write().catch((err: unknown) => (error = err));
          expect(String(error), spelled).to.match(/forbidden/i);
        }
      }
    });

    it('lets every caller read the top organization by itself', async () => {
      const top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
      const found = (await server.ldap.search(
        { paged: false, scope: 'base' },
        top,
        { user: USER, headers: {} } as unknown as DmRequest
      )) as SearchResult;
      expect(found.searchEntries).to.have.length(1);
    });

    it('refuses to move, rename or modify the restricted branch', async () => {
      const req = { user: USER, headers: {} } as unknown as DmRequest;
      for (const write of [
        () => server.ldap.rename(payroll, `ou=precmoved,${acme}`, req),
        () =>
          server.ldap.modify(
            payroll,
            { replace: { description: 'moved' } },
            req
          ),
        () => server.ldap.delete(payroll, req),
      ]) {
        let error: unknown;
        await write().catch((err: unknown) => (error = err));
        expect(String(error)).to.match(/forbidden/i);
      }
      // Nor by carrying the organization link along
      const link = server.config.ldap_organization_link_attribute as string;
      let error: unknown;
      await server.ldap
        .modify(
          payroll,
          {
            add: { [link]: acme },
            replace: { description: 'moved' },
          },
          req
        )
        .catch((err: unknown) => (error = err));
      expect(String(error)).to.match(/forbidden/i);
      // Judged by attachment as well: `departmentSync` would relink the
      // accounts attached there, out of the rule
      const previousMode = server.config.authz_filter_attached_entries;
      server.config.authz_filter_attached_entries = true;
      error = undefined;
      try {
        await server.ldap
          .rename(payroll, `ou=precmoved,${acme}`, req)
          .catch((err: unknown) => (error = err));
      } finally {
        server.config.authz_filter_attached_entries = previousMode;
      }
      expect(String(error)).to.match(/forbidden/i);
      // A rule naming nothing below it does not get in the way
      await server.ldap.rename(
        `uid=prec-sales,${acme}`,
        `uid=prec-sales2,${acme}`,
        req
      );
      await server.ldap.rename(
        `uid=prec-sales2,${acme}`,
        `uid=prec-sales,${acme}`,
        req
      );
    });

    describe('with other rules', () => {
      let saved: typeof plugin.authConfig;
      let groups: unknown;

      beforeEach(() => {
        saved = plugin.authConfig;
        groups = Object.getOwnPropertyDescriptor(plugin, 'getUserGroups');
      });

      afterEach(() => {
        plugin.authConfig = saved;
        if (groups)
          Object.defineProperty(
            plugin,
            'getUserGroups',
            groups as PropertyDescriptor
          );
        else
          delete (plugin as unknown as Record<string, unknown>).getUserGroups;
      });

      it('takes the default only where no rule applies', async () => {
        plugin.authConfig = {
          default: { read: true, write: false, delete: false },
          users: {
            [USER]: { [payroll]: { read: false, write: false, delete: false } },
          },
          groups: {},
        };
        expect(
          (await plugin.getUserPermissions(USER, `uid=prec-sales,${acme}`)).read
        ).to.equal(true);
        expect(
          (await plugin.getUserPermissions(USER, `uid=prec-pay,${payroll}`))
            .read
        ).to.equal(false);
      });

      it('takes what the narrower rule leaves unset from the default', async () => {
        plugin.authConfig = {
          default: { read: true, write: false, delete: false },
          users: {
            [USER]: {
              [acme]: { read: true, write: true, delete: false },
              [payroll]: { read: false },
            },
          },
          groups: {},
        };
        expect(
          await plugin.getUserPermissions(USER, `uid=prec-pay,${payroll}`)
        ).to.deep.equal({ read: false, write: false, delete: false });
      });

      it('holds a write carrying a link to the branch of the entry', async () => {
        plugin.authConfig = {
          default: { read: false, write: false, delete: false },
          users: {
            [USER]: {
              [acme]: { read: true, write: false, delete: false },
              [payroll]: { read: true, write: true, delete: false },
            },
          },
          groups: {},
        };
        const link = server.config.ldap_organization_link_attribute as string;
        let error: unknown;
        await server.ldap
          .modify(
            `uid=prec-sales,${acme}`,
            { add: { [link]: payroll }, replace: { description: 'taken' } },
            { user: USER, headers: {} } as unknown as DmRequest
          )
          .catch((err: unknown) => (error = err));
        expect(String(error)).to.match(/forbidden/i);
        // The link alone is what a move between organizations writes
        await plugin.hooks.ldapmodifyrequest([
          `uid=prec-sales,${acme}`,
          { replace: { [link]: payroll } },
          0,
          { user: USER, headers: {} } as unknown as DmRequest,
        ]);
      });

      it('holds the rules below a moved or deleted entry', async () => {
        // Read refused below, write granted: moving the parent would lift it
        plugin.authConfig = {
          default: { read: false, write: false, delete: false },
          users: {
            [USER]: {
              [base]: { read: true, write: true, delete: true },
              [payroll]: { read: false, write: true, delete: false },
            },
          },
          groups: {},
        };
        const req = { user: USER, headers: {} } as unknown as DmRequest;
        for (const judge of [
          () =>
            plugin.hooks.ldaprenamerequest([acme, `ou=precmoved,${base}`, req]),
          // `trash` turns a delete into a move of the subtree
          () => plugin.hooks.ldapdeleterequest([acme, req]),
        ]) {
          let error: unknown;
          await judge().catch((err: unknown) => (error = err));
          expect(String(error)).to.match(/forbidden/i);
        }
      });

      it('holds what a link write carries, judged by attachment too', async () => {
        plugin.authConfig = {
          default: { read: false, write: false, delete: false },
          users: {
            [USER]: {
              [acme]: { read: true, write: false, delete: false },
              [payroll]: { read: true, write: true, delete: true },
            },
          },
          groups: {},
        };
        const link = server.config.ldap_organization_link_attribute as string;
        const req = { user: USER, headers: {} } as unknown as DmRequest;
        // Attached to `acme`: one attached to nothing is in transit, and any
        // administrator claims it
        const linked = `uid=prec-linked,${acme}`;
        await server.ldap.add(linked, {
          objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
          uid: 'prec-linked',
          cn: 'prec-linked',
          sn: 'prec-linked',
          [link]: acme,
        });
        const previousMode = server.config.authz_filter_attached_entries;
        server.config.authz_filter_attached_entries = true;
        try {
          let error: unknown;
          await plugin.hooks
            .ldapmodifyrequest([
              linked,
              { replace: { [link]: payroll, userPassword: 'Secret123!' } },
              0,
              req,
            ])
            .catch((err: unknown) => (error = err));
          expect(String(error)).to.match(/forbidden/i);
          await plugin.hooks.ldapmodifyrequest([
            linked,
            { replace: { [link]: payroll } },
            0,
            req,
          ]);
        } finally {
          server.config.authz_filter_attached_entries = previousMode;
          await server.ldap.delete(linked).catch(() => undefined);
        }
      });

      it('refuses to create an entry where a rule refuses writing', async () => {
        plugin.authConfig = {
          default: { read: false, write: false, delete: false },
          users: {
            [USER]: {
              [acme]: { read: true, write: true, delete: true },
              [`ou=precnew,${acme}`]: { read: true, write: false },
              [`ou=prec new,${acme}`]: { read: true, write: false },
            },
          },
          groups: {},
        };
        // However the new RDN is spelled
        for (const rdn of [
          'ou=precnew',
          'ou=\\20precnew',
          'ou=prec\u00a0new',
          'ou=prec  new',
          'ou="prec new"',
        ]) {
          let error: unknown;
          await plugin.hooks
            .ldapaddrequest([
              `${rdn},${acme}`,
              { objectClass: ['top', 'organizationalUnit'], ou: 'precnew' },
              { user: USER, headers: {} } as unknown as DmRequest,
            ])
            .catch((err: unknown) => (error = err));
          expect(String(error), rdn).to.match(/forbidden/i);
        }
      });

      it('lets a group grant what the user rule refuses', async () => {
        const group = `cn=precgroup,${base}`;
        (plugin as unknown as Record<string, unknown>).getUserGroups = () =>
          Promise.resolve([group]);
        plugin.authConfig = {
          ...saved!,
          groups: {
            [group]: { [payroll]: { read: true, write: false, delete: false } },
          },
        };
        expect(
          await plugin.getUserPermissions(USER, `uid=prec-pay,${payroll}`)
        ).to.deep.equal({ read: true, write: false, delete: false });
      });

      it('applies the narrower rule to the accounts attached there', async () => {
        const previousMode = server.config.authz_filter_attached_entries;
        server.config.authz_filter_attached_entries = true;
        try {
          const link = server.config.ldap_organization_link_attribute as string;
          const result = {
            searchEntries: [
              { dn: `uid=a,${base}`, [link]: acme },
              { dn: `uid=b,${base}`, [link]: payroll },
            ],
            searchReferences: [],
          } as unknown as SearchResult;
          const [filtered] = await plugin.hooks.ldapsearchfilter([
            result,
            { user: USER, headers: {} } as unknown as DmRequest,
            { scope: 'sub' },
          ]);
          expect(filtered.searchEntries.map(entry => entry.dn)).to.deep.equal([
            `uid=a,${base}`,
          ]);
        } finally {
          server.config.authz_filter_attached_entries = previousMode;
        }
      });
    });
  });
});
