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

export default class Storage extends DmPlugin {
  name = 'storage';
  store: Store;

  constructor(server: DM) {
    super(server);
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
      default:
        throw new Error(
          backend
            ? `storage: unknown backend "${backend}". Known: ldap, file.`
            : 'storage: --storage-backend says which sub-plugin keeps the ' +
                'records. Known: ldap, file.'
        );
    }

    this.logger.info(`storage: records kept by ${this.store.name}`);
    this.store.startSweeping(
      (server.config.storage_sweep_interval as number) || 0
    );
  }
}
