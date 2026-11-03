/**
 * Reading another plugin's option set is refused until its declarations are
 * composed: otherwise the startup report calls the keys unknown while the
 * plugin keeps reading them.
 */
import DmPlugin from '@ldap-rest/core/abstract/plugin';
import { defineOptions, opt } from '@ldap-rest/core/config/options';
import { expect } from 'chai';

import { DM, optionsFor } from '../helpers/dm';

class Reader extends DmPlugin {
  name = 'reader';
}

describe('dependency options', () => {
  it('refuses an option set the template does not carry', async () => {
    const server = new DM(optionsFor([]));
    await server.ready;
    const reader = new Reader(server);
    const notComposed = defineOptions({
      not_composed: opt.number({ default: 1 }),
    });
    expect(() => reader.optionsFrom(notComposed)).to.throw(
      /reads --not-composed[\s\S]*optionDependencies/
    );
  });
});
