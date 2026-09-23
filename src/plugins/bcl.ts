/**
 * @module plugins/bcl
 *
 * Back-Channel Logout: what a provider tells us is dead, and what we do with
 * it on the next request.
 *
 * Nothing here stores a session. `core/auth/openidconnect` keeps that in its
 * cookie; a logout token only leaves a **tombstone** saying that one `sid`, or
 * every session of one `sub`, is dead, and each request asks whether such a
 * mark exists. Recording only what is dead is what keeps the sessions
 * stateless and the storage small.
 *
 * Where the marks live is `core/storage`'s business, not this plugin's. What
 * stays here is the policy: which keys a token kills, how long a mark is
 * kept, and what a login forgets.
 *
 * @group Plugins
 */
import DmPlugin from '../abstract/plugin';
import type { DM } from '../bin';
import type { OidcLogoutToken, OidcSessionClaims } from '../hooks';

import type Storage from './storage';

/** One namespace, so nothing else in the store can answer for a logout. */
const NAMESPACE = 'bcl';

export default class Bcl extends DmPlugin {
  name = 'bcl';
  dependencies = { storage: 'core/storage' };
  private storage: Storage;
  /** How long a tombstone is kept, in milliseconds. */
  private retention: number;

  constructor(server: DM) {
    super(server);
    const storage = this.requirePlugin<Storage>('storage');
    if (!storage) {
      // `requirePlugin` warns and answers null, which is right for a feature
      // that can be skipped. This one cannot: skipping it means every
      // session survives the logout that closed it, silently. A refusal to
      // start is the honest failure.
      throw new Error(
        'bcl: needs core/storage loaded, and --storage-backend set. Without ' +
          'somewhere to keep what a logout killed, every session would ' +
          'outlive the logout that closed it and nothing would say so.'
      );
    }
    this.storage = storage;
    this.retention = ((server.config.bcl_retention as number) || 604800) * 1000;
  }

  /**
   * The keys a token kills.
   *
   * A provider sends `sid`, or `sub`, or both: `sid` ends one session, `sub`
   * ends every session of that person.
   */
  private static keys(claims: OidcSessionClaims): string[] {
    const out: string[] = [];
    if (claims.sid) out.push(`${claims.iss}|sid|${claims.sid}`);
    if (claims.sub) out.push(`${claims.iss}|sub|${claims.sub}`);
    return out;
  }

  hooks = {
    oidclogouttoken: async (token: OidcLogoutToken): Promise<void> => {
      const keys = Bcl.keys(token);
      if (keys.length === 0) {
        // The specification requires one of the two, and the library refuses
        // a token without them, so this is a provider doing something odd.
        this.logger.warn(`${this.name}: a logout token carried no sid nor sub`);
        return;
      }
      const deadline = Date.now() + this.retention;
      // Failures are not swallowed: `openidconnect` turns them into the 400
      // that makes a provider retry, rather than a 204 about a logout
      // nothing kept.
      await Promise.all(
        keys.map(k => this.storage.store.set(NAMESPACE, k, '1', deadline))
      );
    },

    oidclogin: async (claims: OidcSessionClaims): Promise<void> => {
      // A mark on the `sub` kills every session of that person, so left in
      // place it would kill the ones created after it — for the whole
      // retention. Clearing it here is what keeps an old logout from
      // reaching a session younger than itself.
      //
      // It has a consequence worth knowing, which the SDK's own default
      // shares: this also revives sessions killed by a "log out everywhere"
      // token that carried no `sid`.
      await Promise.all(
        Bcl.keys(claims).map(k => this.storage.store.delete(NAMESPACE, k))
      );
    },

    oidcsessionvalid: async ([claims, valid]: [
      OidcSessionClaims,
      boolean,
    ]): Promise<[OidcSessionClaims, boolean]> => {
      // A verdict already given stands: a refusal is never turned back into
      // an acceptance by a later subscriber.
      if (!valid) return [claims, valid];
      for (const key of Bcl.keys(claims)) {
        // The store answers null for a mark past its deadline, whatever its
        // sweeper has done — so a sweeper running late never keeps out
        // someone who has since logged in again.
        if ((await this.storage.store.get(NAMESPACE, key)) !== null)
          return [claims, false];
      }
      return [claims, true];
    },
  };
}
