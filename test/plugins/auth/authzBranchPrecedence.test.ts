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
  });
});
