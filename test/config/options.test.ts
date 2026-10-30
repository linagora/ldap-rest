import { expect } from 'chai';

import configArgs from '../../src/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  toConfigEntries,
} from '../../src/config/options';
import { ConfigParser } from '../../src/lib/parseConfig';
import DmPlugin from '../../src/abstract/plugin';
import { DM } from '../../src/bin';
import {
  scimOptions,
  scimOptionsOf,
} from '../../src/plugins/scim/scim.options';

describe('plugin options', () => {
  const parse = (argv: string[] = ['node', 'ldap-rest']) =>
    new ConfigParser(configArgs).parse(argv);

  const savedEnv: NodeJS.ProcessEnv = {};
  const scimEnv = (): string[] =>
    Object.values(scimOptions)
      .map(option => option.env)
      .filter((name): name is string => name !== undefined);

  beforeEach(() => {
    for (const name of scimEnv()) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of scimEnv()) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  describe('declarations to parser entries', () => {
    it('names the CLI and plural forms and keeps the array kind', () => {
      const entries = toConfigEntries(scimOptions);
      const classes = entries.find(
        entry => entry[0] === '--scim-user-object-class'
      );
      expect(classes).to.deep.equal([
        '--scim-user-object-class',
        'DM_SCIM_USER_OBJECT_CLASSES',
        ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
        'array',
        '--scim-user-object-classes',
        'identifiers',
        false,
      ]);
    });

    it('takes an empty value of the declared type when no default is given', () => {
      const entries = toConfigEntries(
        defineOptions({
          empty_string: opt.string(),
          empty_number: opt.number(),
          empty_boolean: opt.boolean(),
          empty_array: opt.array(),
        })
      );
      expect(entries.map(entry => entry[2])).to.deep.equal(['', 0, false, []]);
    });
  });

  describe('SCIM options in the configuration', () => {
    it('keeps the defaults the parser used to declare', () => {
      const config = parse();
      expect({
        scim_prefix: config.scim_prefix,
        scim_user_base: config.scim_user_base,
        scim_group_base: config.scim_group_base,
        scim_user_object_class: config.scim_user_object_class,
        scim_user_rdn_attribute: config.scim_user_rdn_attribute,
        scim_user_lock_attribute: config.scim_user_lock_attribute,
        scim_user_lock_value: config.scim_user_lock_value,
        scim_group_object_class: config.scim_group_object_class,
        scim_group_rdn_attribute: config.scim_group_rdn_attribute,
        scim_group_external_id_attribute:
          config.scim_group_external_id_attribute,
        scim_id_attribute: config.scim_id_attribute,
        scim_max_results: config.scim_max_results,
        scim_max_scanned: config.scim_max_scanned,
        scim_bulk_max_operations: config.scim_bulk_max_operations,
        scim_bulk_max_payload_size: config.scim_bulk_max_payload_size,
        scim_etag: config.scim_etag,
        scim_base_url: config.scim_base_url,
      }).to.deep.equal({
        scim_prefix: '/scim/v2',
        scim_user_base: '',
        scim_group_base: '',
        scim_user_object_class: [
          'top',
          'inetOrgPerson',
          'organizationalPerson',
          'person',
        ],
        scim_user_rdn_attribute: 'uid',
        scim_user_lock_attribute: 'pwdAccountLockedTime',
        scim_user_lock_value: '',
        scim_group_object_class: ['top', 'groupOfNames'],
        scim_group_rdn_attribute: 'cn',
        scim_group_external_id_attribute: '',
        scim_id_attribute: 'rdn',
        scim_max_results: 200,
        scim_max_scanned: 10000,
        scim_bulk_max_operations: 100,
        scim_bulk_max_payload_size: 1048576,
        scim_etag: false,
        scim_base_url: '',
      });
    });

    it('gives a caller outside the plugin the checked values', () => {
      process.env.DM_SCIM_MAX_RESULTS = '50';
      expect(scimOptionsOf(parse()).scim_max_results).to.equal(50);
    });

    it('reads the environment and the CLI as before', () => {
      process.env.DM_SCIM_MAX_RESULTS = '50';
      process.env.DM_SCIM_USER_OBJECT_CLASSES = 'top;inetOrgPerson';
      process.env.DM_SCIM_ETAG = 'true';
      const config = parse([
        'node',
        'ldap-rest',
        '--scim-user-base',
        'ou=people,dc=example,dc=com',
        '--scim-group-object-classes',
        'top,groupOfNames,groupOfUniqueNames',
      ]);
      expect(config.scim_max_results).to.equal(50);
      expect(config.scim_user_object_class).to.deep.equal([
        'top',
        'inetOrgPerson',
      ]);
      expect(config.scim_etag).to.equal(true);
      expect(config.scim_user_base).to.equal('ou=people,dc=example,dc=com');
      expect(config.scim_group_object_class).to.deep.equal([
        'top',
        'groupOfNames',
        'groupOfUniqueNames',
      ]);
    });
  });

  describe('applicative account options in the configuration', () => {
    const names = [
      'DM_APPLICATIVE_ACCOUNT_BASE',
      'DM_MAX_APP_ACCOUNTS',
      'DM_APP_ACCOUNTS_USER_ATTRIBUTE',
      'DM_APPLICATIVE_ACCOUNT_ATTRIBUTES',
      'DM_LDAP_OPERATIONAL_ATTRIBUTES',
    ];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      saved = {};
      for (const name of names) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    });
    afterEach(() => {
      for (const name of names)
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
    });

    it('keeps the defaults the parser used to declare', () => {
      const config = parse();
      expect(config.applicative_account_base).to.equal('');
      expect(config.max_app_accounts).to.equal(5);
      expect(config.app_accounts_user_attribute).to.equal('');
      expect(config.applicative_account_attribute).to.deep.equal([
        'objectClass',
        'cn',
        'sn',
        'givenName',
        'displayName',
        'description',
      ]);
      expect(config.ldap_operational_attribute).to.deep.equal([
        'dn',
        'controls',
        'structuralObjectClass',
        'entryUUID',
        'entryDN',
        'subschemaSubentry',
        'modifyTimestamp',
        'modifiersName',
        'createTimestamp',
        'creatorsName',
        'userPassword',
      ]);
    });

    it('reads the environment and the CLI as before', () => {
      process.env.DM_MAX_APP_ACCOUNTS = '2';
      process.env.DM_APPLICATIVE_ACCOUNT_ATTRIBUTES = 'cn;sn';
      const config = parse([
        'node',
        'ldap-rest',
        '--applicative-account-base',
        'ou=applicative,dc=example,dc=com',
        '--ldap-operational-attributes',
        'dn,entryUUID',
      ]);
      expect(config.max_app_accounts).to.equal(2);
      expect(config.applicative_account_attribute).to.deep.equal(['cn', 'sn']);
      expect(config.applicative_account_base).to.equal(
        'ou=applicative,dc=example,dc=com'
      );
      expect(config.ldap_operational_attribute).to.deep.equal([
        'dn',
        'entryUUID',
      ]);
    });
  });

  describe('reading and checking values', () => {
    const definitions = defineOptions({
      name: opt.string({ required: true }),
      count: opt.number({ default: 2, min: 1, max: 4 }),
      mode: opt.string({ default: 'a', choices: ['a', 'b'] }),
      list: opt.array({ default: ['x'] }),
    });

    it('applies the defaults and copies the default list', () => {
      const values = readOptions(definitions, { name: 'n' });
      expect(values).to.deep.equal({
        name: 'n',
        count: 2,
        mode: 'a',
        list: ['x'],
      });
      values.list.push('y');
      expect(readOptions(definitions, { name: 'n' }).list).to.deep.equal(['x']);
    });

    it('refuses a missing required value', () => {
      expect(() => readOptions(definitions, {})).to.throw(/name is required/);
      expect(() => readOptions(definitions, { name: '' })).to.throw(
        /name is required/
      );
    });

    it('refuses a number out of its bounds', () => {
      expect(() => readOptions(definitions, { name: 'n', count: 0 })).to.throw(
        /at least 1/
      );
      expect(() => readOptions(definitions, { name: 'n', count: 5 })).to.throw(
        /at most 4/
      );
      expect(() =>
        readOptions(definitions, { name: 'n', count: 2.5 })
      ).to.throw(/integer/);
    });

    it('refuses a value outside the declared choices', () => {
      expect(() => readOptions(definitions, { name: 'n', mode: 'c' })).to.throw(
        /one of a, b/
      );
    });

    it('refuses a value of the wrong type', () => {
      expect(() => readOptions(definitions, { name: 'n', list: 'x' })).to.throw(
        /list of strings/
      );
      expect(() =>
        readOptions(definitions, { name: 'n', count: '2' })
      ).to.throw(/integer/);
    });
  });

  describe('DmPlugin.options', () => {
    const definitions = defineOptions({
      sample_size: opt.number({ default: 3, min: 1 }),
      sample_label: opt.string({ default: 'x' }),
    });

    class Sample extends DmPlugin {
      static optionDefinitions = definitions;
      name = 'sample';
    }

    it('gives the declared values, typed', () => {
      const plugin = new Sample(new DM());
      expect(plugin.options(definitions)).to.deep.equal({
        sample_size: 3,
        sample_label: 'x',
      });
    });

    it('refuses definitions the plugin does not declare', () => {
      const plugin = new Sample(new DM());
      expect(() =>
        plugin.options(
          defineOptions({ another_option: opt.string({ default: 'x' }) })
        )
      ).to.throw(/Sample: options\(\) takes the definitions/);
    });

    it('checks them while the plugin is constructed', () => {
      class Refused extends DmPlugin {
        static optionDefinitions = defineOptions({
          required_value: opt.string({ required: true }),
        });
        name = 'refused';
      }
      expect(() => new Refused(new DM())).to.throw(
        /required_value is required/
      );
    });
  });
});
