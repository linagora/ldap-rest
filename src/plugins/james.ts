import fetch from 'node-fetch';

import DmPlugin from '../abstract/plugin';
import { Hooks } from '../hooks';

export default class James extends DmPlugin {
  name = 'james';

  dependencies = { onLdapChange: 'core/onLdapChange' };

  hooks: Hooks = {
    onLdapMailChange: (dn: string, oldmail: string, newmail: string) => {
      return this._try(
        'onLdapMailChange',
        `${this.config.james_webadmin_url}/users/${oldmail}/rename/${newmail}?action=rename`,
        'POST',
        dn,
        null,
        { oldmail, newmail }
      );
    },
    onLdapQuotaChange: (
      dn: string,
      mail: string,
      oldQuota: number,
      newQuota: number
    ) => {
      return this._try(
        'onLdapQuotaChange',
        `${this.config.james_webadmin_url}/quota/users/${mail}/size`,
        'PUT',
        dn,
        newQuota.toString(),
        { oldQuota, newQuota }
      );
    },
  };

  async _try(
    hookname: string,
    url: string,
    method: string,
    dn: string,
    body: string | null,
    fields: object
  ): Promise<void> {
    try {
      const opts = { method };
      if (body) Object.assign(opts, { body });
      await fetch(url, opts);
      this.logger.info({
        plugin: this.name,
        event: hookname,
        result: 'success',
        dn,
        ...fields,
      });
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: `${hookname} failure`,
        result: 'error',
        dn,
        error: err,
        ...fields,
      });
    }
  }
}
