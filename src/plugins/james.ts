import fetch from 'node-fetch';

import DmPlugin from '../abstract/plugin';
import { Hooks } from '../hooks';

export default class James extends DmPlugin {
  name = 'james';

  dependencies = { onLdapChange: 'core/onLdapChange' };

  hooks: Hooks = {
    onLdapMailChange: async (dn: string, oldmail: string, newmail: string) => {
      try {
        const res = await fetch(
          `${this.config.james_webadmin_url}/users/${oldmail}/rename/${newmail}?action=rename`,
          {
            method: 'POST',
          }
        );
        this.logger.info({
          plugin: this.name,
          action: 'onLdapMailChange',
          oldmail,
          newmail,
          response: await res.json(),
        });
      } catch (err) {
        this.logger.error({
          plugin: this.name,
          action: 'onLdapMailChange failure',
          error: err,
          oldmail,
          newmail,
        });
      }
    },
  };
}
