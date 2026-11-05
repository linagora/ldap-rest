import { expect } from 'chai';

import AuthzDynamic, {
  type BranchAcl,
  type TokenEntry,
} from '../../../src/plugins/auth/authzDynamic';

type FlagParser = {
  logger: Record<'debug' | 'warn' | 'info' | 'error', () => void>;
  base: string;
  tokenAttr: string;
  configAttr: string;
  tenantAttr: string;
  tokens: TokenEntry[];
  server: { ldap: { system: { search: () => Promise<unknown> } } };
  reload(): Promise<void>;
};

const tokenDn = 'cn=t,ou=tokens,dc=example,dc=com';
const branchDn = 'ou=users,ou=acme,dc=example,dc=com';

/**
 * Load a token whose ACL branch carries `flags`, through the same `reload`
 * the cache uses, and return the branch ACL it holds.
 */
async function load(
  flags: Record<string, unknown>
): Promise<{ acl: BranchAcl; warnings: string[] }> {
  const warnings: string[] = [];
  const plugin = Object.create(AuthzDynamic.prototype) as FlagParser;
  plugin.logger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    error: (): void => undefined,
    warn: (...args: unknown[]): void => void warnings.push(String(args[0])),
  };
  Object.assign(plugin, {
    base: 'ou=tokens,dc=example,dc=com',
    tokenAttr: 'userPassword',
    configAttr: 'description',
    tenantAttr: 'cn',
    tokens: [],
    server: {
      ldap: {
        system: {
          search: async () => ({
            searchEntries: [
              {
                dn: tokenDn,
                cn: 't',
                userPassword: '{SSHA}x',
                description: JSON.stringify({
                  tenant: 'acme',
                  bases: [{ dn: branchDn, ...flags }],
                }),
              },
            ],
          }),
        },
      },
    },
  });

  await plugin.reload();
  return { acl: plugin.tokens[0].bases[0], warnings };
}

describe('authzDynamic ACL flags', () => {
  it('grants a permission written as the boolean true', async () => {
    expect(
      (await load({ read: true, write: true, delete: true })).acl
    ).to.deep.equal({ dn: branchDn, read: true, write: true, delete: true });
  });

  for (const [label, value] of [
    ['"false"', 'false'],
    ['"no"', 'no'],
    ['"0"', '0'],
    ['"true"', 'true'],
    ['"yes"', 'yes'],
    ['1', 1],
  ])
    it(`refuses a permission written as ${label}`, async () => {
      expect((await load({ read: value })).acl.read).to.equal(false);
    });

  it('leaves an absent flag false without a warning', async () => {
    const { acl, warnings } = await load({ write: true });
    expect(acl.read).to.equal(false);
    expect(acl.delete).to.equal(false);
    expect(warnings).to.deep.equal([]);
  });

  it('warns about a non-boolean flag, naming the token', async () => {
    const { warnings } = await load({ read: 'false' });
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.contain('read');
    expect(warnings[0]).to.contain(branchDn);
    expect(warnings[0]).to.contain(tokenDn);
  });
});
