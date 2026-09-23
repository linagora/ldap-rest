/**
 * @module lib/bcl/store
 *
 * What every Back-Channel Logout backend shares.
 *
 * Nothing here stores a session. `core/auth/openidconnect` keeps the session
 * in its cookie as before; a logout token only leaves a **tombstone** saying
 * that one `sid`, or every session of one `sub`, is dead. Each request then
 * asks whether such a mark exists. Recording only what is dead is what keeps
 * the storage small and the sessions stateless.
 *
 * Two obligations, and neither is free:
 *
 *  - **A tombstone must expire.** Past the point where the session it kills
 *    would have ended anyway, keeping it is not merely wasteful: the same
 *    `sub` logging in again would be thrown straight back out. Expiry is
 *    therefore enforced on read, whatever the sweeper has or has not done.
 *  - **Storage must be reclaimed.** Only Valkey expires keys by itself; the
 *    others need the sweeper below.
 *
 * @group Libraries
 */
import type winston from 'winston';

import type { OidcLogoutToken, OidcSessionClaims } from '../../hooks';

export default abstract class BclStore {
  abstract name: string;
  protected logger: winston.Logger;
  /** How long a tombstone is kept, in milliseconds */
  protected retention: number;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(logger: winston.Logger, retentionSeconds: number) {
    this.logger = logger;
    this.retention = retentionSeconds * 1000;
  }

  /** Read one deadline, or null when nothing is recorded under this key. */
  protected abstract read(key: string): Promise<number | null>;
  /** Record `key` as dead until `deadline` (epoch ms), overwriting. */
  protected abstract write(key: string, deadline: number): Promise<void>;
  /** Drop one key; a missing one is not an error. */
  protected abstract remove(key: string): Promise<void>;
  /** Drop every expired tombstone. Returns how many went. */
  abstract sweep(): Promise<number>;

  /**
   * The two keys a token kills. A provider sends `sid`, or `sub`, or both:
   * `sid` ends one session, `sub` ends every session of that person.
   */
  protected static keys(claims: OidcSessionClaims): string[] {
    const out: string[] = [];
    if (claims.sid) out.push(`${claims.iss}|sid|${claims.sid}`);
    if (claims.sub) out.push(`${claims.iss}|sub|${claims.sub}`);
    return out;
  }

  /** Record what a logout token kills. */
  async record(token: OidcLogoutToken): Promise<void> {
    const keys = BclStore.keys(token);
    if (keys.length === 0) {
      // The specification requires one of the two, and the library refuses a
      // token without them, so this is a provider doing something odd.
      this.logger.warn(`${this.name}: a logout token carried no sid nor sub`);
      return;
    }
    const deadline = Date.now() + this.retention;
    await Promise.all(keys.map(k => this.write(k, deadline)));
  }

  /** Whether a session has been logged out behind its holder's back. */
  async isRevoked(claims: OidcSessionClaims): Promise<boolean> {
    const keys = BclStore.keys(claims);
    for (const key of keys) {
      const deadline = await this.read(key);
      if (deadline === null) continue;
      if (deadline > Date.now()) return true;
      // Expired: drop it rather than answer with it. A sweeper running late
      // must never keep someone out who has since logged in again.
      this.remove(key).catch(() => undefined);
    }
    return false;
  }

  /**
   * Run the sweeper every `seconds`, and once now. Unreferenced, so a server
   * with nothing else to do still exits.
   */
  startSweeping(seconds: number): void {
    if (this.sweeper || seconds <= 0) return;
    const run = (): void => {
      this.sweep()
        .then(n => {
          if (n > 0) this.logger.debug(`${this.name}: swept ${n} tombstone(s)`);
        })
        .catch(err => {
          // A failed sweep must not take the server with it: reads enforce
          // expiry anyway, so the only cost is storage.
          this.logger.warn(`${this.name}: sweep failed: ${String(err)}`);
        });
    };
    this.sweeper = setInterval(run, seconds * 1000);
    this.sweeper.unref?.();
    run();
  }

  stopSweeping(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}
