/**
 * @module plugins/storage/file
 *
 * A keyed store kept as files, one per record.
 *
 * For a deployment with no database and no shared cache to lean on. It
 * survives a restart, which is the property that matters: a record a restart
 * forgets is a decision someone made that no longer holds.
 *
 * The key is hashed into the file name — a key is an opaque string and a path
 * component cannot hold one unescaped — and kept verbatim in the file beside
 * the deadline, so an operator reading the directory can tell what a record
 * is about.
 *
 * Writes go to a temporary file and are renamed into place: a reader must
 * never meet a half-written record and read no deadline from it, which would
 * make a live record look expired.
 *
 * @group Plugins
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type winston from 'winston';

import Store, { type StoredRecord } from '../../lib/storage/store';

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : JSON.stringify(err);

export default class FileStore extends Store {
  name = 'storage/file';
  private dir: string;
  /** How long a temporary file must sit before it counts as abandoned. */
  private abandonedAfter: number;

  constructor(
    logger: winston.Logger,
    dir: string,
    abandonedAfterSeconds: number
  ) {
    super(logger);
    this.dir = dir;
    // A write in flight is a matter of milliseconds; the sweep interval is
    // the safest yardstick available, and never less than a minute.
    this.abandonedAfter = Math.max(abandonedAfterSeconds, 60) * 1000;
  }

  /** The directory is created on demand, readable by this user alone. */
  async ready(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private path(key: string): string {
    return join(this.dir, createHash('sha256').update(key).digest('hex'));
  }

  /** `<deadline> <key>\n<value>` — the deadline first, so a short read still has it. */
  private static encode(key: string, record: StoredRecord): string {
    return `${record.deadline} ${key}\n${record.value}\n`;
  }

  private static decode(text: string): StoredRecord | null {
    const cut = text.indexOf('\n');
    if (cut < 0) return null;
    const deadline = parseInt(text.slice(0, cut).split(' ')[0], 10);
    if (!Number.isFinite(deadline)) return null;
    return { deadline, value: text.slice(cut + 1).replace(/\n$/, '') };
  }

  protected async load(key: string): Promise<StoredRecord | null> {
    try {
      return FileStore.decode(await fs.readFile(this.path(key), 'utf8'));
    } catch (err) {
      // Absent is the ordinary outcome. Anything else means the store could
      // not be consulted, which is a different answer wearing the same face.
      if ((err as { code?: string })?.code !== 'ENOENT')
        this.logger.warn(
          `${this.name}: cannot read a record, the answer is a guess: ${errorText(err)}`
        );
      return null;
    }
  }

  protected async save(key: string, record: StoredRecord): Promise<void> {
    await this.ready();
    const target = this.path(key);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, FileStore.encode(key, record), { mode: 0o600 });
      await fs.rename(tmp, target);
    } catch (err) {
      // Raised, so the caller knows nothing was kept — but a lost record
      // deserves a line of its own, not only whatever the caller does next.
      this.logger.warn(
        `${this.name}: cannot write a record: ${errorText(err)}`
      );
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  protected async drop(key: string): Promise<void> {
    await fs.unlink(this.path(key)).catch((err: { code?: string }) => {
      // Not there is the ordinary outcome; anything else leaves a record
      // standing that its owner believes gone.
      if (err?.code !== 'ENOENT')
        this.logger.warn(
          `${this.name}: cannot drop a record, it keeps counting: ${errorText(err)}`
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
        // that rename fail and lose the record it was writing, so only the
        // ones old enough to be nobody's are swept.
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
      let record: StoredRecord | null = null;
      try {
        record = FileStore.decode(await fs.readFile(file, 'utf8'));
      } catch {
        continue;
      }
      // A record nothing can be read from goes too: it cannot expire on its
      // own and would sit there forever.
      if (record !== null && record.deadline > now) continue;
      await fs.unlink(file).catch(() => undefined);
      gone++;
    }
    return gone;
  }
}
