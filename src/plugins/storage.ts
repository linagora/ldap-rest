/**
 * @module plugins/storage
 *
 * Keyed storage, for whoever needs to keep something with a deadline.
 *
 * One plugin, one backend, chosen by `--storage-backend`. Consumers ask this
 * one for its store and work through a single interface; where the records
 * actually live is a deployment decision, not theirs.
 *
 * Having exactly one is the point. The alternative — each consumer loading
 * the backend it likes — puts the same record in two places, and makes
 * whichever plugin was registered first decide what happens when one of them
 * is unwell. Registration order is invisible in a configuration, which is a
 * poor place to keep a behaviour.
 *
 * A consumer reaches it with `requirePlugin('storage')` and works through
 * `store`; it should not index `loadedPlugins` itself. And one that makes a
 * security decision must not read "no storage" as "nothing to check":
 * `requirePlugin` answers null and warns once, which is right for an optional
 * feature and wrong for, say, a logout check — such a consumer refuses to
 * load instead.
 *
 * What a consumer must not expect of this layer: it does not decide how long
 * anything lives. A deadline comes in with the record, because retention is
 * the policy of whoever wrote it — the moment a backend decides for itself,
 * two of them can disagree about when the same record died.
 *
 * @group Plugins
 */
import DmPlugin from '../abstract/plugin';
import type { DM } from '../bin';
import type Store from '../lib/storage/store';

import FileStore from './storage/file';
import LdapStore from './storage/ldap';
import PostgresStore from './storage/postgres';
import ValkeyStore from './storage/valkey';

/**
 * The one instance, if there is one.
 *
 * "One plugin, one backend" is the reason a consumer may treat the store as
 * the place a record is: two of them put the same record in two places, and
 * make registration order — invisible in a configuration — decide what
 * happens when one is unwell. `--storage-backend` is a single value, but
 * nothing stops a second instance arriving under another name, so the
 * guarantee is held here rather than stated in a comment.
 */
let onlyInstance: Storage | undefined;

const KNOWN = 'ldap, file, postgres, valkey';

export default class Storage extends DmPlugin {
  name = 'storage';
  store: Store;

  constructor(server: DM) {
    super(server);
    if (onlyInstance) {
      throw new Error(
        `storage: an instance is already loaded, keeping its records in ` +
          `${onlyInstance.store.name}. A second one would put the same ` +
          'record in two places and leave registration order to decide ' +
          'which answers. Load one, and let its consumers share it.'
      );
    }
    const backend = (server.config.storage_backend as string) || '';

    switch (backend) {
      case 'ldap': {
        const base = server.config.storage_ldap_base as string;
        if (!base)
          throw new Error(
            'storage: the ldap backend needs --storage-ldap-base, the branch ' +
              'it writes its records to. It holds records and nothing else, ' +
              'so it belongs outside the branches the directory serves.'
          );
        this.store = new LdapStore(
          server,
          base,
          (server.config.storage_ldap_object_class as string) ||
            'applicationProcess'
        );
        break;
      }
      case 'file': {
        const dir = server.config.storage_file_directory as string;
        if (!dir)
          throw new Error(
            'storage: the file backend needs --storage-file-directory, the ' +
              'directory it writes its records to. It writes one file per ' +
              'record, so nothing else should be writing there.'
          );
        this.store = new FileStore(
          server.logger,
          dir,
          (server.config.storage_sweep_interval as number) || 600
        );
        break;
      }
      case 'postgres': {
        const url = server.config.storage_postgres_url as string;
        if (!url)
          throw new Error(
            'storage: the postgres backend needs --storage-postgres-url, ' +
              'the database it writes its records to.'
          );
        this.store = new PostgresStore(
          server.logger,
          url,
          (server.config.storage_postgres_table as string) ||
            'ldap_rest_storage'
        );
        break;
      }
      case 'valkey': {
        const url = server.config.storage_valkey_url as string;
        if (!url)
          throw new Error(
            'storage: the valkey backend needs --storage-valkey-url, the ' +
              'server it writes its records to.'
          );
        this.store = new ValkeyStore(
          server.logger,
          url,
          (server.config.storage_valkey_prefix as string) ?? ''
        );
        break;
      }
      default:
        throw new Error(
          backend
            ? `storage: unknown backend "${backend}". Known: ${KNOWN}.`
            : 'storage: --storage-backend says which sub-plugin keeps the ' +
                `records. Known: ${KNOWN}.`
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    onlyInstance = this;
    this.logger.info(`storage: records kept by ${this.store.name}`);
    // A constructor cannot wait, and an `api()` would mount the
    // authentication dispatcher ahead of the plugins that must run before it.
    // Started here, a wrong address or a missing driver is in the log at
    // startup rather than at the first record written.
    this.store
      .open()
      .catch(err =>
        this.logger.error(err instanceof Error ? err.message : String(err))
      );
    this.store.startSweeping(
      (server.config.storage_sweep_interval as number) || 0
    );
  }

  /**
   * Release the single-instance hold.
   *
   * For a test building several servers in one process; a running one has no
   * reason to call it.
   */
  static release(instance: Storage): void {
    if (onlyInstance === instance) onlyInstance = undefined;
  }
}
