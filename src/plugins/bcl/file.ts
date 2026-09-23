/**
 * @module plugins/bcl/file
 *
 * Back-Channel Logout tombstones kept as files.
 *
 * One file per killed session, in a directory of its own. For a deployment
 * with no database and no shared cache to lean on, this is what survives a
 * restart — which matters more here than it looks: a logout that a restart
 * forgets is a session the provider believes closed and the console still
 * honours.
 *
 * The file name is the hash of the key, as in `bcl/ldap`, because the key is
 * a URL and a path component cannot hold one unescaped. The content is the
 * same `<deadline> <key>` line, so the two backends can be read by the same
 * eyes.
 *
 * Writes go to a temporary file and are renamed into place: a reader must
 * never meet a half-written record and read no deadline from it, which would
 * make a live tombstone look expired.
 *
 * @group Plugins
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import DmPlugin from '../../abstract/plugin';
import BclStore from '../../lib/bcl/store';
import type { DM } from '../../bin';
import type { OidcLogoutToken, OidcSessionClaims } from '../../hooks';

/** What to put in a log line about an unknown thrown value. */
const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : JSON.stringify(err);

class FileBclStore extends BclStore {
  name = 'bcl/file';
  private dir: string;
  /** How long a temporary file must sit before it counts as abandoned. */
  private abandonedAfter: number;

  constructor(
    logger: DM['logger'],
    dir: string,
    retention: number,
    abandonedAfterSeconds: number
  ) {
    super(logger, retention);
    this.dir = dir;
    // A write in flight is a matter of milliseconds; a sweep interval is the
    // safest yardstick available, and never less than a minute.
    this.abandonedAfter = Math.max(abandonedAfterSeconds, 60) * 1000;
  }

  /** The directory is created on demand, readable by this user alone. */
  async ready(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private path(key: string): string {
    return join(this.dir, createHash('sha256').update(key).digest('hex'));
  }

  private static decode(text: string): number | null {
    const ms = parseInt(text.split(' ')[0], 10);
    return Number.isFinite(ms) ? ms : null;
  }

  protected async read(key: string): Promise<number | null> {
    try {
      return FileBclStore.decode(await fs.readFile(this.path(key), 'utf8'));
    } catch (err) {
      // Absent is the common case and not an error: nobody logged out.
      // Anything else means the store could not be consulted, which is
      // enforcement stopping — said out loud rather than read as "alive".
      if ((err as { code?: string })?.code !== 'ENOENT')
        this.logger.warn(
          `${this.name}: cannot read a tombstone, enforcement is blind: ${String(err)}`
        );
      return null;
    }
  }

  protected async write(key: string, deadline: number): Promise<void> {
    await this.ready();
    const target = this.path(key);
    // A reader meeting a half-written file would read no deadline from it and
    // take a live tombstone for an expired one, which is the wrong way to be
    // wrong: write elsewhere, then rename, which is atomic on one filesystem.
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, `${deadline} ${key}\n`, { mode: 0o600 });
      await fs.rename(tmp, target);
    } catch (err) {
      // The failure is raised — the provider is told 400 and retries rather
      // than told the logout was kept — but a lost tombstone deserves a line
      // of its own, not just the status the provider sees.
      this.logger.warn(
        `${this.name}: cannot record a tombstone, the logout is not kept: ${String(err)}`
      );
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  protected async remove(key: string): Promise<void> {
    // Not there is the ordinary outcome. Anything else leaves a mark
    // standing, and `forget` depends on this: a `sub` mark that cannot be
    // removed keeps killing every session that person establishes until it
    // expires.
    await fs.unlink(this.path(key)).catch((err: { code?: string }) => {
      if (err?.code !== 'ENOENT')
        this.logger.warn(
          `${this.name}: cannot drop a tombstone, it keeps counting: ${errorText(err)}`
        );
    });
  }

  async sweep(): Promise<number> {
    const now = Date.now();
    let gone = 0;
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const file = join(this.dir, name);
      if (name.endsWith('.tmp')) {
        // A write between its temporary file and its rename, possibly in
        // another process sharing the directory. Taking it now would make
        // that rename fail and lose the tombstone it was writing, so only
        // the ones old enough to be nobody's are swept.
        const age = await fs
          .stat(file)
          .then(st => now - st.mtimeMs)
          .catch(() => 0);
        if (age > this.abandonedAfter) {
          await fs.unlink(file).catch(() => undefined);
          gone++;
        }
        continue;
      }
      let deadline: number | null = null;
      try {
        deadline = FileBclStore.decode(await fs.readFile(file, 'utf8'));
      } catch {
        continue;
      }
      // A record nothing can be read from goes too: it cannot expire on its
      // own and would sit there forever.
      if (deadline !== null && deadline > now) continue;
      await fs.unlink(file).catch(() => undefined);
      gone++;
    }
    return gone;
  }
}

export default class BclFile extends DmPlugin {
  name = 'bclFile';
  store: FileBclStore;

  constructor(server: DM) {
    super(server);
    const dir = server.config.bcl_file_directory as string;
    if (!dir) {
      throw new Error(
        'bcl/file needs --bcl-file-directory: the directory it keeps its ' +
          'tombstones in. It writes one file per killed session, so nothing ' +
          'else should be writing there.'
      );
    }
    this.store = new FileBclStore(
      server.logger,
      dir,
      (server.config.bcl_retention as number) || 604800,
      (server.config.bcl_sweep_interval as number) || 600
    );
    this.store.startSweeping((server.config.bcl_sweep_interval as number) || 0);
  }

  hooks = {
    oidclogouttoken: async (token: OidcLogoutToken): Promise<void> => {
      await this.store.record(token);
    },

    oidclogin: async (claims: OidcSessionClaims): Promise<void> => {
      await this.store.forget(claims);
    },

    oidcsessionvalid: async ([claims, valid]: [
      OidcSessionClaims,
      boolean,
    ]): Promise<[OidcSessionClaims, boolean]> => {
      if (!valid) return [claims, valid];
      return [claims, !(await this.store.isRevoked(claims))];
    },
  };
}
