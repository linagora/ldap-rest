import { expect } from 'chai';

import ldapActions from '../../src/lib/ldapActions';
import type { RequestBoundLdap } from '../../src/lib/ldapActions';

/**
 * The authorization plugins hook `ldap*request` and skip every check when the
 * request is missing, so an omitted argument is a silent authorization
 * bypass. `forRequest()` exists to make the omission inexpressible — these
 * cases pin that every bound method really forwards the request.
 */
describe('ldapActions.forRequest', () => {
  interface Call {
    method: string;
    args: unknown[];
  }

  const req = { user: 'alice' } as unknown as Parameters<
    ldapActions['forRequest']
  >[0];

  const bind = (): { calls: Call[]; bound: RequestBoundLdap } => {
    const calls: Call[] = [];
    const record =
      (method: string) =>
      (...args: unknown[]): Promise<boolean> => {
        calls.push({ method, args });
        return Promise.resolve(true);
      };
    // A stand-in for the instance: forRequest only closes over `this`.
    const self = {
      base: 'dc=example,dc=com',
      search: record('search'),
      add: record('add'),
      modify: record('modify'),
      rename: record('rename'),
      delete: record('delete'),
    };
    const bound = (
      ldapActions.prototype.forRequest as (
        this: unknown,
        r: unknown
      ) => RequestBoundLdap
    ).call(self, req);
    return { calls, bound };
  };

  it('forwards the request on every method', async () => {
    const { calls, bound } = bind();
    await bound.search({ scope: 'base' }, 'ou=x');
    await bound.add('cn=a', { cn: 'a' });
    await bound.modify('cn=a', { replace: { cn: 'b' } });
    await bound.rename('cn=a', 'cn=b');
    await bound.delete('cn=a');

    expect(calls.map(c => c.method)).to.deep.equal([
      'search',
      'add',
      'modify',
      'rename',
      'delete',
    ]);
    // The request is the last argument of each underlying call.
    for (const call of calls) {
      expect(call.args[call.args.length - 1], call.method).to.equal(req);
    }
  });

  it('defaults the search base to the instance base', async () => {
    const { calls, bound } = bind();
    await bound.search({ scope: 'sub' });
    expect(calls[0].args[1]).to.equal('dc=example,dc=com');
  });

  it('exposes no way to pass a request of its own', () => {
    const { bound } = bind();
    // Each method takes exactly the arguments of the unbound one, minus the
    // request — so there is no argument position left to forget.
    expect(bound.add.length).to.equal(2);
    expect(bound.modify.length).to.equal(2);
    expect(bound.rename.length).to.equal(2);
    expect(bound.delete.length).to.equal(1);
  });
});
