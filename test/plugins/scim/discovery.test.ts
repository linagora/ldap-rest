/**
 * An empty schema directory is no directory: the files SCIM reads must not
 * come from the process's working directory.
 */
import fs from 'fs';
import os from 'os';
import { join } from 'path';

import { expect } from 'chai';
import type { Config } from '@ldap-rest/core/config/args';
import type { AuthenticatorsInfo } from '@ldap-rest/core/lib/services/authenticators';
import type { ScimOptions } from '@ldap-rest/core/lib/scim/options';
import { ScimDiscovery } from '@ldap-rest/scim/discovery';

describe('SCIM discovery', () => {
  it('should read no schema when it has no directory', () => {
    const cwd = process.cwd();
    const planted = fs.mkdtempSync(join(os.tmpdir(), 'scim-cwd-'));
    try {
      fs.writeFileSync(
        join(planted, 'User.json'),
        JSON.stringify({ name: 'PlantedUser', attributes: [] })
      );
      process.chdir(planted);
      const discovery = new ScimDiscovery({
        config: {} as Config,
        options: {} as ScimOptions,
        schemaDir: '',
        scimPrefix: '/scim/v2',
        authenticators: { has: () => false } as unknown as AuthenticatorsInfo,
      });
      expect(discovery.schemas()).to.deep.equal([]);
    } finally {
      process.chdir(cwd);
      fs.rmSync(planted, { recursive: true, force: true });
    }
  });
});
