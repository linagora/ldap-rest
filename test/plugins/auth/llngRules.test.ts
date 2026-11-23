import * as fs from 'fs';
import * as path from 'path';

import { expect } from 'chai';

import {
  loadLlng,
  llngFixture,
  llngVhost,
  type LlngFixture,
  type LlngHandler,
  type LlngModule,
} from '../../helpers/llngHandler';

/**
 * The access rules docs/usage/plugins/auth/llng.md gives, run through the
 * real `lemonldap-ng-handler`: it decides what a rule means, and a rule
 * written in Perl compiles there to something else.
 */

/** The `locationRules` of the JSON block under the rules example */
const documentedRules = (): Record<string, string> => {
  const doc = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      '..',
      'docs',
      'usage',
      'plugins',
      'auth',
      'llng.md'
    ),
    'utf8'
  );
  const section = doc.split('## Example: LLNG Authorization Rules')[1];
  const block = /```json\n([\s\S]*?)\n```/.exec(section ?? '');
  if (!block) throw new Error('no JSON block under the rules example');
  const conf = JSON.parse(block[1]) as {
    locationRules: Record<string, Record<string, string>>;
  };
  return conf.locationRules[llngVhost];
};

describe('LemonLDAP::NG access rules in the documentation', function () {
  let llng: LlngModule | undefined;
  let fixture: LlngFixture;
  let handler: LlngHandler;

  before(async function () {
    llng = await loadLlng();
    if (!llng) return this.skip();
    fixture = llngFixture(documentedRules());
    handler = await llng.init({ configStorage: { confFile: fixture.ini } });
  });

  after(async () => {
    if (llng) await llng.shutdown();
    fixture?.remove();
  });

  const granted = (
    uri: string,
    session: Record<string, unknown>
  ): Promise<boolean> =>
    handler.grant({ headers: { host: llngVhost } }, uri, session).then(
      result => result,
      // How the handler says no when `default` refuses; any other rejection
      // is a rule that failed to run, and fails the test
      (reason: unknown) => {
        if (reason === 'Unauthorized') return false;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }
    );

  it('grants nothing to a user outside the groups the rules name', async () => {
    const session = { uid: 'bob', groups: 'users; staff' };
    for (const uri of [
      '/api/v1/ldap/users',
      '/api/v1/ldap/groups',
      '/api/v1/ldap/organizations',
    ])
      expect(await granted(uri, session), uri).to.equal(false);
    expect(session, 'the rules leave the session alone').to.deep.equal({
      uid: 'bob',
      groups: 'users; staff',
    });
  });

  it('grants each path to whom the documentation says', async () => {
    const admin = { uid: 'alice', groups: 'admins' };
    const hr = { uid: 'carol', groups: 'staff; hr' };
    const manager = { uid: 'groupmanager', groups: 'staff' };
    expect(await granted('/api/v1/ldap/organizations', admin)).to.equal(true);
    expect(await granted('/api/v1/ldap/users', admin)).to.equal(true);
    expect(await granted('/api/v1/ldap/groups', admin)).to.equal(true);
    expect(await granted('/api/v1/ldap/users', hr)).to.equal(true);
    expect(await granted('/api/v1/ldap/groups', hr)).to.equal(false);
    expect(await granted('/api/v1/ldap/organizations', hr)).to.equal(false);
    expect(await granted('/api/v1/ldap/groups', manager)).to.equal(true);
    expect(await granted('/api/v1/ldap/users', manager)).to.equal(false);
  });
});
