/**
 * A dependency whose options were not composed cannot be typed: the loader
 * refuses to start rather than let a CLI value reach the parser untyped.
 */
import DmPlugin from '@ldap-rest/core/abstract/plugin';
import { defineOptions, opt } from '@ldap-rest/core/config/options';
import { expect } from 'chai';

import { DM, optionsFor } from '../helpers/dm';

class MissingDep extends DmPlugin {
  static optionDefinitions = defineOptions({
    not_composed: opt.number({ default: 1 }),
  });
  name = 'missingDep';
}

class Dependent extends DmPlugin {
  name = 'dependent';
  dependencies = { missingDep: 'core/missingDep' };
}

describe('dependency options', () => {
  it('refuses a dependency whose option is not in the template', async () => {
    const server = new DM(optionsFor([]));
    await server.ready;
    server.loadedPlugins['missingDep'] = new MissingDep(server);
    let refused: Error | undefined;
    await server
      .registerPlugin('dependent', new Dependent(server))
      .catch((error: Error) => {
        refused = error;
      });
    expect(refused, 'refused').to.be.instanceOf(Error);
    expect(refused!.message).to.match(
      /add core\/missingDep to the optionDependencies of Dependent/
    );
  });
});
