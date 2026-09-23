/**
 * @module lib/storage/store
 *
 * A small keyed store, and what every backend of it shares.
 *
 * What a consumer gets is deliberately thin: a key, a value, a deadline, and
 * the promise that the value stops being returned once that deadline passes.
 * Nothing here knows why a record exists — Back-Channel Logout tombstones
 * were the first use, a refresh-token lock and a shared counter are the ones
 * in sight, and none of them is this layer's business.
 *
 * Two rules the backends do not get to reinterpret:
 *
 *  - **Expiry is enforced on read.** Not every backend can expire a record by
 *    itself, and the one that can (Valkey's TTL) must still agree with the
 *    others about when a record died. A sweeper running late is then a
 *    storage cost, never a wrong answer.
 *  - **The deadline belongs to the consumer.** How long a record lives is the
 *    policy of whoever wrote it; the store is told an instant and respects
 *    it. A backend deciding for itself is how four of them come to disagree
 *    about the same question.
 *
 * Keys are namespaced so two consumers cannot collide in one LDAP branch or
 * one directory.
 *
 * @group Libraries
 */
import type winston from 'winston';

/** What a backend keeps: a value, and when it stops counting. */
export interface StoredRecord {
  value: string;
  deadline: number;
}

export default abstract class Store {
  /** Name of the backend, for the log lines it writes. */
  abstract name: string;
  protected logger: winston.Logger;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(logger: winston.Logger) {
    this.logger = logger;
  }

  /* What a backend implements, and nothing else */

  /** Read one record, or null when nothing is kept under this key. */
  protected abstract load(key: string): Promise<StoredRecord | null>;
  /** Write one record, replacing whatever was there. */
  protected abstract save(key: string, record: StoredRecord): Promise<void>;
  /** Drop one key. A key that is not there is not an error. */
  protected abstract drop(key: string): Promise<void>;
  /** Drop every expired record. Returns how many went. */
  abstract sweep(): Promise<number>;

  /** `namespace:key`, so two consumers cannot collide. */
  protected static scoped(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  /**
   * The value kept under this key, or null.
   *
   * A record past its deadline is not one: it is dropped and answered as
   * absent, whatever the sweeper has or has not done. Consumers rely on this
   * — a Back-Channel Logout mark that outlives its session would keep out a
   * person who has since logged in again.
   */
  async get(namespace: string, key: string): Promise<string | null> {
    const scoped = Store.scoped(namespace, key);
    const record = await this.load(scoped);
    if (record === null) return null;
    if (record.deadline <= Date.now()) {
      // Fire and forget: the answer is already known, and failing to tidy up
      // must not turn a correct "absent" into an error.
      this.drop(scoped).catch(() => undefined);
      return null;
    }
    return record.value;
  }

  /** Keep `value` under this key until `deadline`, an epoch in milliseconds. */
  async set(
    namespace: string,
    key: string,
    value: string,
    deadline: number
  ): Promise<void> {
    await this.save(Store.scoped(namespace, key), { value, deadline });
  }

  /** Forget this key. */
  async delete(namespace: string, key: string): Promise<void> {
    await this.drop(Store.scoped(namespace, key));
  }

  /**
   * Run the sweeper every `seconds`, and once now.
   *
   * Unreferenced, so a server with nothing else to do still exits, and a
   * sweep that fails warns rather than taking the server with it: reads
   * enforce expiry anyway, so the cost of a failed sweep is storage.
   */
  startSweeping(seconds: number): void {
    if (this.sweeper || seconds <= 0) return;
    const run = (): void => {
      this.sweep()
        .then(n => {
          if (n > 0) this.logger.debug(`${this.name}: swept ${n} record(s)`);
        })
        .catch(err => {
          this.logger.warn(
            `${this.name}: sweep failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`
          );
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
