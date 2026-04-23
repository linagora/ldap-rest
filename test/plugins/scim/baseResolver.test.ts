import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BaseResolver } from '../../../src/plugins/scim/baseResolver';
import type { Config } from '../../../src/config/args';

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    schemas_path: '',
    log_level: 'error',
    logger: 'console',
    api_prefix: '/api',
    ldap_base: 'dc=example,dc=com',
    ...overrides,
  } as Config;
}

describe('SCIM baseResolver', () => {
  it('falls back to ldap_base when nothing is configured', () => {
    const br = new BaseResolver(cfg());
    expect(br.userBase()).to.equal('dc=example,dc=com');
    expect(br.groupBase()).to.equal('dc=example,dc=com');
  });

  it('uses explicit static bases', () => {
    const br = new BaseResolver(
      cfg({
        scim_user_base: 'ou=users,dc=example,dc=com',
        scim_group_base: 'ou=groups,dc=example,dc=com',
      })
    );
    expect(br.userBase()).to.equal('ou=users,dc=example,dc=com');
    expect(br.groupBase()).to.equal('ou=groups,dc=example,dc=com');
  });

  it('applies {user} template', () => {
    const br = new BaseResolver(
      cfg({
        scim_user_base_template:
          'ou=users,ou={user},dc=example,dc=com',
        scim_group_base_template:
          'ou=groups,ou={user},dc=example,dc=com',
      })
    );
    expect(br.userBase({ user: 'tenant1' })).to.equal(
      'ou=users,ou=tenant1,dc=example,dc=com'
    );
    expect(br.groupBase({ user: 'tenant1' })).to.equal(
      'ou=groups,ou=tenant1,dc=example,dc=com'
    );
  });

  it('escapes DN special chars in {user}', () => {
    const br = new BaseResolver(
      cfg({ scim_user_base_template: 'ou={user},dc=x' })
    );
    expect(br.userBase({ user: 'evil,dc=bad' })).to.equal(
      'ou=evil\\,dc\\=bad,dc=x'
    );
  });

  it('uses map file for explicit user match', () => {
    const mapFile = path.join(
      os.tmpdir(),
      `scim-base-map-${Date.now()}.json`
    );
    fs.writeFileSync(
      mapFile,
      JSON.stringify({
        alice: {
          userBase: 'ou=alice-users,dc=ex',
          groupBase: 'ou=alice-groups,dc=ex',
        },
        '*': { userBase: 'ou=any-users,dc=ex' },
      })
    );
    try {
      const br = new BaseResolver(cfg({ scim_base_map: mapFile }));
      expect(br.userBase({ user: 'alice' })).to.equal(
        'ou=alice-users,dc=ex'
      );
      expect(br.groupBase({ user: 'alice' })).to.equal(
        'ou=alice-groups,dc=ex'
      );
      // Unknown user falls back to wildcard
      expect(br.userBase({ user: 'other' })).to.equal('ou=any-users,dc=ex');
    } finally {
      fs.unlinkSync(mapFile);
    }
  });

  it('resolution order: map > template > static', () => {
    const mapFile = path.join(
      os.tmpdir(),
      `scim-base-map-order-${Date.now()}.json`
    );
    fs.writeFileSync(
      mapFile,
      JSON.stringify({ alice: { userBase: 'ou=from-map,dc=ex' } })
    );
    try {
      const br = new BaseResolver(
        cfg({
          scim_user_base: 'ou=from-static,dc=ex',
          scim_user_base_template: 'ou=from-template-{user},dc=ex',
          scim_base_map: mapFile,
        })
      );
      // alice → map
      expect(br.userBase({ user: 'alice' })).to.equal('ou=from-map,dc=ex');
      // other → template (map has no "*" entry)
      expect(br.userBase({ user: 'other' })).to.equal(
        'ou=from-template-other,dc=ex'
      );
    } finally {
      fs.unlinkSync(mapFile);
    }
  });
});
