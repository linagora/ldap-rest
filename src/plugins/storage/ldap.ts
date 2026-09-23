/**
 * @module plugins/storage/ldap
 *
 * A keyed store kept in the directory itself.
 *
 * One entry per record, under a branch of its own, in the shape
 * `Apache::Session::Browseable::LDAP` uses for the same job: an
 * `applicationProcess` whose `cn` identifies the record and whose
 * `description` carries its content.
 *
 * The key is hashed into the `cn` — a key is an opaque string of no bounded
 * length, and a DN cannot carry one unescaped — and kept verbatim in
 * `description` beside the deadline, so an operator reading the branch can
 * tell what a record is about.
 *
 * @group Plugins
 */
import { createHash } from 'node:crypto';

import Store, { type StoredRecord } from '../../lib/storage/store';
import type { DM } from '../../bin';
import type { SearchResult } from '../../lib/ldapActions';

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : JSON.stringify(err);

export default class LdapStore extends Store {
  name = 'storage/ldap';
  private server: DM;
  private base: string;
  private objectClass: string;

  constructor(server: DM, base: string, objectClass: string) {
    super(server.logger);
    this.server = server;
    this.base = base;
    this.objectClass = objectClass;
  }

  private dn(key: string): string {
    return `cn=${createHash('sha256').update(key).digest('hex')},${this.base}`;
  }

  /** `<deadline> <key>\n<value>`, the deadline first as in the file store. */
  private static encode(key: string, record: StoredRecord): string {
    return `${record.deadline} ${key}\n${record.value}`;
  }

  private static decode(value: unknown): StoredRecord | null {
    const text = String(value);
    const cut = text.indexOf('\n');
    const head = cut < 0 ? text : text.slice(0, cut);
    const deadline = parseInt(head.split(' ')[0], 10);
    if (!Number.isFinite(deadline)) return null;
    return { deadline, value: cut < 0 ? '' : text.slice(cut + 1) };
  }

  protected async load(key: string): Promise<StoredRecord | null> {
    try {
      const res = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: ['description'] },
        this.dn(key)
      )) as SearchResult;
      const entry = res.searchEntries?.[0];
      return entry ? LdapStore.decode(entry.description) : null;
    } catch (err) {
      // 32 is noSuchObject, the ordinary outcome. Read the code and not the
      // sentence: the sentence is one this repository writes about itself.
      if ((err as { code?: number })?.code !== 32)
        this.logger.warn(
          `${this.name}: cannot read a record, the answer is a guess: ${errorText(err)}`
        );
      return null;
    }
  }

  protected async save(key: string, record: StoredRecord): Promise<void> {
    const dn = this.dn(key);
    const description = LdapStore.encode(key, record);
    try {
      await this.server.ldap.add(dn, {
        objectClass: ['top', this.objectClass],
        cn: dn.slice(3, dn.indexOf(',')),
        description,
      });
    } catch (err) {
      // 68 is entryAlreadyExists, the ordinary case when a record is written
      // twice: the later one wins. Anything else is a write that did not
      // happen, and is raised so the caller knows nothing was kept.
      if ((err as { code?: number })?.code !== 68) {
        this.logger.warn(
          `${this.name}: cannot write a record: ${errorText(err)}`
        );
        throw err;
      }
      await this.server.ldap.modify(dn, { replace: { description } });
    }
  }

  protected async drop(key: string): Promise<void> {
    await this.server.ldap
      .delete(this.dn(key))
      .catch((err: { code?: number }) => {
        if (err?.code !== 32)
          this.logger.warn(
            `${this.name}: cannot drop a record, it keeps counting: ${errorText(err)}`
          );
      });
  }

  async sweep(): Promise<number> {
    const now = Date.now();
    let gone = 0;
    const res = (await this.server.ldap.search(
      {
        paged: false,
        scope: 'one',
        filter: `(objectClass=${this.objectClass})`,
        attributes: ['description'],
      },
      this.base
    )) as SearchResult;
    for (const entry of res.searchEntries || []) {
      const record = LdapStore.decode(entry.description);
      // A record nothing can be read from goes too: it cannot expire on its
      // own and would sit there forever.
      if (record !== null && record.deadline > now) continue;
      await this.server.ldap.delete(String(entry.dn)).catch(() => undefined);
      gone++;
    }
    return gone;
  }
}
