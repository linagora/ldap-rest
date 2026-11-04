/**
 * The check is driven directly, in the order the hooks call it: a hook hands
 * `getParentDn(dn)` to `requireBranchPermission`.
 */
import { expect } from 'chai';

import { AuthzRefusedError } from '../../../src/lib/errors';
import { getParentDn } from '../../../src/lib/utils';
import AuthzDynamic, {
  type TokenEntry,
} from '../../../src/plugins/auth/authzDynamic';

type BranchCheck = {
  logger: Record<string, (...args: unknown[]) => void>;
  requireBranchPermission(
    token: TokenEntry,
    branchOrDn: string,
    permission: 'read' | 'write' | 'delete'
  ): void;
};

describe('authzDynamic branch ACLs on escaped and respelled DNs', () => {
  const plugin = Object.create(
    AuthzDynamic.prototype
  ) as unknown as BranchCheck;
  plugin.logger = {
    debug: (): void => {},
    warn: (): void => {},
    info: (): void => {},
    error: (): void => {},
  };

  const tokenOn = (dn: string): TokenEntry => ({
    dn: 'cn=t,ou=tokens,dc=example,dc=com',
    cn: 't',
    tenant: 'acme',
    hash: 'x',
    bases: [{ dn, read: true, write: true, delete: true }],
  });

  const check = (
    token: TokenEntry,
    dn: string,
    permission: 'read' | 'write' | 'delete' = 'write'
  ): void => plugin.requireBranchPermission(token, getParentDn(dn), permission);

  it('refuses a write whose parent only ends with the branch as text', () => {
    const dn = 'uid=jdoe,cn=x\\,ou=users,ou=acme,dc=example,dc=com';
    expect(getParentDn(dn)).to.equal(
      'cn=x\\,ou=users,ou=acme,dc=example,dc=com'
    );
    expect(() =>
      check(tokenOn('ou=users,ou=acme,dc=example,dc=com'), dn)
    ).to.throw(AuthzRefusedError);
  });

  it('still allows a write inside the branch', () => {
    expect(() =>
      check(
        tokenOn('ou=users,ou=acme,dc=example,dc=com'),
        'uid=jdoe,ou=users,ou=acme,dc=example,dc=com'
      )
    ).not.to.throw();
  });

  it('matches a branch written with spaces after its commas', () => {
    expect(() =>
      check(
        tokenOn('dc=example, dc=com'),
        'uid=jdoe,ou=groups,ou=acme,dc=example,dc=com'
      )
    ).not.to.throw();
  });

  it('matches a target spelled with a hex escape', () => {
    expect(() =>
      check(
        tokenOn('ou=users,ou=acme,dc=example,dc=com'),
        'uid=jdoe,ou=us\\65rs,ou=acme,dc=example,dc=com'
      )
    ).not.to.throw();
  });

  it('matches a branch separated by semicolons', () => {
    expect(() =>
      check(
        tokenOn('ou=users;ou=acme;dc=example;dc=com'),
        'uid=jdoe,ou=users,ou=acme,dc=example,dc=com'
      )
    ).not.to.throw();
  });

  it('matches a branch spelled with a hex escape', () => {
    expect(() =>
      check(
        tokenOn('ou=us\\65rs,ou=acme,dc=example,dc=com'),
        'uid=jdoe,ou=users,ou=acme,dc=example,dc=com'
      )
    ).not.to.throw();
  });

  for (const spelling of [
    '2.5.4.11',
    'OID.2.5.4.11',
    'ORGANIZATIONALUNITNAME',
  ]) {
    it(`matches a target whose attribute type is spelled ${spelling}`, () => {
      expect(() =>
        check(
          tokenOn('ou=users,ou=acme,dc=example,dc=com'),
          `uid=jdoe,${spelling}=users,ou=acme,dc=example,dc=com`
        )
      ).not.to.throw();
    });

    it(`matches a branch whose attribute type is spelled ${spelling}`, () => {
      expect(() =>
        check(
          tokenOn(`${spelling}=users,ou=acme,dc=example,dc=com`),
          'uid=jdoe,ou=users,ou=acme,dc=example,dc=com'
        )
      ).not.to.throw();
    });
  }

  it('refuses when the only branch cannot be parsed', () => {
    expect(() =>
      check(
        tokenOn('ou="users,dc=example,dc=com'),
        'uid=jdoe,ou=users,dc=example,dc=com'
      )
    ).to.throw(AuthzRefusedError);
  });

  it('reads the branches after one that cannot be parsed', () => {
    expect(() => {
      const token = tokenOn('ou=users,ou=acme,dc=example,dc=com');
      token.bases.unshift({
        dn: 'ou="groups,dc=example,dc=com',
        read: true,
        write: true,
        delete: true,
      });
      check(token, 'uid=jdoe,ou=users,ou=acme,dc=example,dc=com');
    }).not.to.throw();
  });

  it('refuses a search based at an entry beside the branch', () => {
    // `ldapsearchrequest` hands the base itself to the check, without
    // stripping an RDN: `cn=acme\,ou=users` is one RDN under `ou=acme`, not
    // a child of `ou=users,ou=acme`.
    expect(() =>
      plugin.requireBranchPermission(
        tokenOn('ou=users,ou=acme,dc=example,dc=com'),
        'cn=acme\\,ou=users,ou=acme,dc=example,dc=com',
        'read'
      )
    ).to.throw(AuthzRefusedError);
  });
});
