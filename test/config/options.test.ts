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
import { TwakePlugin } from '../../src/abstract/twakePlugin';
import { DM } from '../../src/bin';
import { bclOptions } from '../../src/plugins/bcl.options';
import { storageOptions } from '../../src/plugins/storage.options';
import {
  scimOptions,
  scimOptionsOf,
} from '../../src/plugins/scim/scim.options';
import {
  crowdsecOptionsOf,
  dynamicOptionsOf,
  hmacOptionsOf,
  perBranchOptionsOf,
  rateLimitOptionsOf,
  totpOptionsOf,
} from '../../src/plugins/auth/auth.options';
import {
  organizationOptions,
  passwordPolicyOptions,
  rawOptions,
} from '../../src/plugins/ldap/ldap.options';
import { jamesOptionsOf } from '../../src/plugins/twake/james.options';
import { calendarOptionsOf } from '../../src/plugins/twake/calendar.options';
import { clouderyOptionsOf } from '../../src/plugins/twake/cloudery.options';
import { cozyOptionsOf } from '../../src/plugins/twake/cozy.options';
import { twakeGroupsOptionsOf } from '../../src/plugins/twake/twakeGroups.options';
import { twakeInstancesOptionsOf } from '../../src/plugins/twake/twakeInstances.options';

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

  describe('James options in the configuration', () => {
    const names = [
      'DM_JAMES_WEBADMIN_URL',
      'DM_JAMES_WEBADMIN_TOKEN',
      'DM_JAMES_SIGNATURE_TEMPLATE',
      'DM_JAMES_CONCURRENCY',
      'DM_JAMES_INIT_DELAY',
      'DM_JAMES_RETRY_ATTEMPTS',
      'DM_JAMES_RETRY_DELAY',
      'DM_JAMES_MAILING_LIST_BRANCHES',
      'DM_JAMES_MAILBOX_TYPE_ATTRIBUTE',
      'DM_JAMES_SYNC_FORWARDS',
      'DM_JAMES_TEAM_MAILBOX_ANY_DOMAIN',
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
      expect(config.james_webadmin_url).to.equal('http://localhost:8000');
      expect(config.james_webadmin_token).to.equal('');
      expect(config.james_signature_template).to.equal('');
      expect(config.james_concurrency).to.equal(10);
      expect(config.james_init_delay).to.equal(1000);
      expect(config.james_retry_attempts).to.equal(5);
      expect(config.james_retry_delay).to.equal(1000);
      expect(config.james_mailing_list_branch).to.deep.equal([]);
      expect(config.james_mailbox_type_attribute).to.equal('twakeMailboxType');
      expect(config.james_sync_forwards).to.equal(false);
      expect(config.james_team_mailbox_any_domain).to.equal(false);
    });

    it('reads the environment and the CLI as before', () => {
      process.env.DM_JAMES_CONCURRENCY = '3';
      process.env.DM_JAMES_MAILING_LIST_BRANCHES =
        'ou=Teams,dc=example,dc=com;ou=Other,dc=example,dc=com';
      const config = parse([
        'node',
        'ldap-rest',
        '--james-retry-delay',
        '250',
        '--james-team-mailbox-any-domain',
        '--james-sync-forwards',
      ]);
      expect(config.james_concurrency).to.equal(3);
      expect(config.james_mailing_list_branch).to.deep.equal([
        'ou=Teams,dc=example,dc=com',
        'ou=Other,dc=example,dc=com',
      ]);
      expect(config.james_retry_delay).to.equal(250);
      expect(config.james_team_mailbox_any_domain).to.equal(true);
      expect(config.james_sync_forwards).to.equal(true);
    });

    it('refuses a concurrency below 1 when the plugin reads it', () => {
      process.env.DM_JAMES_CONCURRENCY = '0';
      expect(() => jamesOptionsOf(parse())).to.throw(
        /--james-concurrency must be at least 1/
      );
    });
  });

  describe('the Twake connection', () => {
    class SampleTwake extends TwakePlugin {
      name = 'sampleTwake';
      roles = [];

      constructor(concurrency: unknown) {
        super(new DM(), {
          url: 'http://localhost:8000',
          token: 'secret',
          concurrency: concurrency as number,
          urlOption: 'sample_url',
          tokenOption: 'sample_token',
          concurrencyOption: 'sample_concurrency',
        });
      }
    }

    it('refuses a concurrency that is not a positive integer', () => {
      for (const value of ['5', 0, -1, 1.5]) {
        expect(() => new SampleTwake(value), String(value)).to.throw(
          /sample_concurrency must be a positive integer/
        );
      }
    });
  });

  describe('Calendar options in the configuration', () => {
    const names = [
      'DM_CALENDAR_WEBADMIN_URL',
      'DM_CALENDAR_WEBADMIN_TOKEN',
      'DM_CALENDAR_CONCURRENCY',
      'DM_CALENDAR_RESOURCE_BASE',
      'DM_CALENDAR_RESOURCE_OBJECTCLASS',
      'DM_CALENDAR_RESOURCE_CREATOR',
      'DM_CALENDAR_RESOURCE_DOMAIN',
      'DM_CALENDAR_FIRSTNAME_ATTRIBUTE',
      'DM_CALENDAR_LASTNAME_ATTRIBUTE',
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
      expect(config.calendar_webadmin_url).to.equal('http://localhost:8080');
      expect(config.calendar_webadmin_token).to.equal('');
      expect(config.calendar_concurrency).to.equal(10);
      expect(config.calendar_resource_base).to.equal('');
      expect(config.calendar_resource_objectclass).to.equal('');
      expect(config.calendar_resource_creator).to.equal('admin@example.com');
      expect(config.calendar_resource_domain).to.equal('');
      expect(config.calendar_firstname_attribute).to.equal('givenName');
      expect(config.calendar_lastname_attribute).to.equal('sn');
    });

    it('reads the environment and the CLI as before', () => {
      process.env.DM_CALENDAR_CONCURRENCY = '4';
      process.env.DM_CALENDAR_RESOURCE_BASE = 'ou=resources,dc=example,dc=com';
      const config = parse([
        'node',
        'ldap-rest',
        '--calendar-resource-objectclass',
        'calendarResource',
        '--calendar-resource-creator',
        'resources@example.com',
        '--calendar-firstname-attribute',
        'cn',
      ]);
      expect(config.calendar_concurrency).to.equal(4);
      expect(config.calendar_resource_base).to.equal(
        'ou=resources,dc=example,dc=com'
      );
      expect(config.calendar_resource_objectclass).to.equal('calendarResource');
      expect(config.calendar_resource_creator).to.equal(
        'resources@example.com'
      );
      expect(config.calendar_firstname_attribute).to.equal('cn');
    });
  });

  describe('Drive options in the configuration', () => {
    const names = [
      'DM_TWAKE_DRIVE_WEBADMIN_URL',
      'DM_TWAKE_DRIVE_WEBADMIN_TOKEN',
      'DM_TWAKE_DRIVE_CONCURRENCY',
      'DM_TWAKE_DRIVE_DOMAIN_ATTRIBUTE',
      'DM_TWAKE_DRIVE_DEFAULT_DOMAIN_TEMPLATE',
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
      expect(config.twake_drive_webadmin_url).to.equal('');
      expect(config.twake_drive_webadmin_token).to.equal('');
      expect(config.twake_drive_concurrency).to.equal(10);
      expect(config.twake_drive_domain_attribute).to.equal('twakeCozyDomain');
      expect(config.twake_drive_default_domain_template).to.equal('');
    });

    it('reads the environment and the CLI as before', () => {
      process.env.DM_TWAKE_DRIVE_CONCURRENCY = '4';
      process.env.DM_TWAKE_DRIVE_DOMAIN_ATTRIBUTE = 'cozyDomain';
      const config = parse([
        'node',
        'ldap-rest',
        '--twake-drive-webadmin-url',
        'https://drive.example.com',
        '--twake-drive-default-domain-template',
        '{uid}.example.com',
      ]);
      expect(config.twake_drive_concurrency).to.equal(4);
      expect(config.twake_drive_domain_attribute).to.equal('cozyDomain');
      expect(config.twake_drive_webadmin_url).to.equal(
        'https://drive.example.com'
      );
      expect(config.twake_drive_default_domain_template).to.equal(
        '{uid}.example.com'
      );
    });
  });

  describe('Twake options in the configuration', () => {
    it('keeps the defaults the parser used to declare', () => {
      const config = parse();
      expect(config.migration_proxy_concurrency).to.equal(10);
      expect(config.migration_proxy_branch).to.deep.equal([]);
      expect(config.cozy_admin_user).to.equal('admin');
      expect(config.cozy_apps).to.equal('home,drive,settings,notes,dataproxy');
      expect(config.cloudery_offer).to.equal('b2b_twake_default');
      expect(config.cloudery_org_id_header).to.equal('x-cloudery-org-id');
      expect(config.cloudery_workflow_max_attempts).to.equal(60);
      expect(config.twake_lifecycle_deleted_value).to.equal('TRUE');
      expect(config.twake_lifecycle_member_attribute).to.equal('member');
      expect(config.twake_group_max_page_limit).to.equal(1000);
      expect(config.twake_group_member_fields).to.deep.equal({});
      expect(config.twake_space_class).to.deep.equal(['top', 'twakeSpace']);
      expect(config.twake_space_sync_queue).to.equal(
        'twake.space.sync.requested.ldap-rest'
      );
      expect(config.twake_tombstone_default_reason).to.equal('deleted');
      expect(config.twake_tombstone_erase_min_age).to.equal(2592000);
      expect(config.twake_instance_provider).to.equal('cloudery');
      expect(config.twake_instance_id).to.equal('{uid}');
      expect(config.twake_instance_timeout).to.equal(30000);
      expect(config.twake_instance_organization_id_attribute).to.equal('ou');
    });

    it('refuses a zero where the default used to apply', () => {
      const cases: [string, () => unknown][] = [
        ['DM_TWAKE_GROUP_MAX_PAGE_LIMIT', () => twakeGroupsOptionsOf(parse())],
        ['DM_TWAKE_INSTANCE_TIMEOUT', () => twakeInstancesOptionsOf(parse())],
        [
          'DM_CLOUDERY_WORKFLOW_POLL_INTERVAL_MS',
          () => clouderyOptionsOf(parse()),
        ],
        ['DM_CLOUDERY_WORKFLOW_MAX_ATTEMPTS', () => clouderyOptionsOf(parse())],
      ];
      for (const [name, read] of cases) {
        const saved = process.env[name];
        process.env[name] = '0';
        try {
          expect(read, name).to.throw(/must be at least 1/);
        } finally {
          if (saved === undefined) delete process.env[name];
          else process.env[name] = saved;
        }
      }
    });

    it('keeps a declared default for an empty string, unless it is a value', () => {
      const saved = {
        DM_CALENDAR_FIRSTNAME_ATTRIBUTE:
          process.env.DM_CALENDAR_FIRSTNAME_ATTRIBUTE,
        DM_COZY_APPS: process.env.DM_COZY_APPS,
        DM_TWAKE_INSTANCE_COZY_APPS: process.env.DM_TWAKE_INSTANCE_COZY_APPS,
        DM_TWAKE_INSTANCE_COZY_CONTEXT:
          process.env.DM_TWAKE_INSTANCE_COZY_CONTEXT,
        DM_TWAKE_INSTANCE_CLOUDERY_OFFER:
          process.env.DM_TWAKE_INSTANCE_CLOUDERY_OFFER,
      };
      try {
        process.env.DM_CALENDAR_FIRSTNAME_ATTRIBUTE = '';
        expect(
          calendarOptionsOf(parse()).calendar_firstname_attribute
        ).to.equal('givenName');
        expect(
          calendarOptionsOf(
            parse(['node', 'ldap-rest', '--calendar-firstname-attribute', ''])
          ).calendar_firstname_attribute
        ).to.equal('givenName');

        process.env.DM_COZY_APPS = '';
        expect(cozyOptionsOf(parse()).cozy_apps).to.equal('');

        const instanceEmpties = [
          ['DM_TWAKE_INSTANCE_COZY_APPS', 'twake_instance_cozy_apps'],
          ['DM_TWAKE_INSTANCE_COZY_CONTEXT', 'twake_instance_cozy_context'],
          ['DM_TWAKE_INSTANCE_CLOUDERY_OFFER', 'twake_instance_cloudery_offer'],
        ] as const;
        for (const [name, key] of instanceEmpties) {
          process.env[name] = '';
          expect(twakeInstancesOptionsOf(parse())[key], name).to.equal('');
        }
      } finally {
        for (const [name, value] of Object.entries(saved))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
    });

    it('reads the environment and the CLI as before', () => {
      const saved = {
        DM_TWAKE_TOMBSTONE_REASONS: process.env.DM_TWAKE_TOMBSTONE_REASONS,
        DM_TWAKE_INSTANCE_PROVIDER: process.env.DM_TWAKE_INSTANCE_PROVIDER,
      };
      process.env.DM_TWAKE_TOMBSTONE_REASONS = 'gone;erased';
      process.env.DM_TWAKE_INSTANCE_PROVIDER = 'cozy-stack';
      try {
        const config = parse([
          'node',
          'ldap-rest',
          '--twake-group-member-fields',
          '{"member":"uid"}',
          '--twake-space-class',
          'top',
          '--twake-space-class',
          'space',
        ]);
        expect(config.twake_tombstone_reasons).to.deep.equal([
          'gone',
          'erased',
        ]);
        expect(config.twake_instance_provider).to.equal('cozy-stack');
        expect(config.twake_group_member_fields).to.deep.equal({
          member: 'uid',
        });
        expect(config.twake_space_class).to.deep.equal(['top', 'space']);
      } finally {
        for (const [name, value] of Object.entries(saved))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
    });
  });

  describe('authentication and authorization options', () => {
    it('keeps the defaults the parser used to declare', () => {
      const config = parse();
      expect(config.auth_token).to.deep.equal([]);
      expect(config.auth_fake_user).to.equal('');
      expect(config.auth_totp_window).to.equal(1);
      expect(config.auth_totp_step).to.equal(30);
      expect(config.auth_hmac_window).to.equal(120000);
      expect(config.llng_ini).to.equal('/etc/lemonldap-ng/lemonldap-ng.ini');
      expect(config.authz_per_route).to.deep.equal([]);
      expect(config.authz_per_branch_config).to.deep.equal({
        default: { read: true, write: false, delete: false },
      });
      expect(config.authz_per_branch_cache_ttl).to.equal(60);
      expect(config.authz_dynamic_token_attribute).to.equal('userPassword');
      expect(config.authz_local_admin_attribute).to.equal(
        'twakeLocalAdminLink'
      );
      expect(config.oidc_username_claim).to.equal('sub');
      expect(config.rate_limit_window_ms).to.equal(15 * 60 * 1000);
      expect(config.rate_limit_max).to.equal(100);
      expect(config.crowdsec_url).to.equal(
        'http://localhost:8080/v1/decisions'
      );
      expect(config.trusted_proxy_auth_header).to.equal('Auth-User');
    });

    it('reads the environment and the CLI as before', () => {
      const saved = {
        DM_AUTH_TOKENS: process.env.DM_AUTH_TOKENS,
        DM_AUTHZ_GLOBAL_BRANCHES: process.env.DM_AUTHZ_GLOBAL_BRANCHES,
      };
      process.env.DM_AUTH_TOKENS = 't1;t2';
      process.env.DM_AUTHZ_GLOBAL_BRANCHES =
        'ou=global,dc=example,dc=com;ou=other,dc=example,dc=com';
      try {
        const config = parse([
          'node',
          'ldap-rest',
          '--auth-totp-step',
          '60',
          '--trusted-proxy',
          '10.0.0.0/8',
          '--crowdsec-cache-ttl',
          '30',
        ]);
        expect(config.auth_token).to.deep.equal(['t1', 't2']);
        expect(config.authz_global_branch).to.deep.equal([
          'ou=global,dc=example,dc=com',
          'ou=other,dc=example,dc=com',
        ]);
        expect(config.auth_totp_step).to.equal(60);
        expect(config.trusted_proxy).to.deep.equal(['10.0.0.0/8']);
        expect(config.crowdsec_cache_ttl).to.equal(30);
      } finally {
        for (const [name, value] of Object.entries(saved))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
    });

    it('refuses a zero where the default used to apply', () => {
      const cases: [string, () => unknown][] = [
        ['DM_AUTH_TOTP_STEP', () => totpOptionsOf(parse())],
        ['DM_AUTH_HMAC_WINDOW', () => hmacOptionsOf(parse())],
        ['DM_RATE_LIMIT_WINDOW_MS', () => rateLimitOptionsOf(parse())],
        ['DM_RATE_LIMIT_MAX', () => rateLimitOptionsOf(parse())],
        ['DM_CROWDSEC_CACHE_TTL', () => crowdsecOptionsOf(parse())],
        ['DM_AUTHZ_PER_BRANCH_CACHE_TTL', () => perBranchOptionsOf(parse())],
        ['DM_AUTHZ_DYNAMIC_CACHE_TTL', () => dynamicOptionsOf(parse())],
      ];
      for (const [name, read] of cases) {
        const saved = process.env[name];
        process.env[name] = '0';
        try {
          expect(read, name).to.throw(/must be at least 1/);
        } finally {
          if (saved === undefined) delete process.env[name];
          else process.env[name] = saved;
        }
      }
    });
  });

  describe('LDAP plugin options', () => {
    it('keeps the defaults the parser used to declare', () => {
      const saved = {
        DM_LDAP_TOP_ORGANIZATION: process.env.DM_LDAP_TOP_ORGANIZATION,
        DM_LDAP_GROUP_BASE: process.env.DM_LDAP_GROUP_BASE,
        DM_GROUP_SCHEMA: process.env.DM_GROUP_SCHEMA,
        DM_GROUP_DUMMY_USER: process.env.DM_GROUP_DUMMY_USER,
        DM_EXTERNAL_MEMBERS_BRANCH: process.env.DM_EXTERNAL_MEMBERS_BRANCH,
      };
      for (const name of Object.keys(saved)) delete process.env[name];
      try {
        const config = parse();
        expect(config.ldap_top_organization).to.equal('');
        expect(config.ldap_organization_class).to.deep.equal([
          'top',
          'organizationalUnit',
          'twakeDepartment',
        ]);
        expect(config.ldap_organization_link_attribute).to.equal(
          'twakeDepartmentLink'
        );
        expect(config.ldap_organization_path_separator).to.equal(' / ');
        expect(config.ldap_organization_max_subnodes).to.equal(50);
        expect(config.enterprise_domain_name_attribute).to.equal(
          'associatedDomain'
        );
        expect(config.ldap_group_base).to.equal('');
        expect(config.ldap_groups_main_attribute).to.equal('cn');
        expect(config.group_class).to.deep.equal(['top', 'groupOfNames']);
        expect(config.groups_allow_unexistent_members).to.equal(false);
        expect(config.group_default_attributes).to.deep.equal({});
        expect(config.group_dummy_user).to.equal('cn=fakeuser');
        expect(config.group_schema).to.match(
          /static\/schemas\/twake\/groups\.json$/
        );
        expect(config.external_members_branch).to.equal(
          'ou=contacts,dc=example,dc=com'
        );
        expect(config.ldap_flat_schema).to.deep.equal([]);
        expect(config.ldap_flat_auto_repair).to.equal(true);
        expect(config.ldap_raw_max_results).to.equal(200);
        expect(config.ldap_raw_schema_cache_ttl).to.equal(3600);
        expect(config.bulk_import_max_file_size).to.equal('10485760');
        expect(config.bulk_import_batch_size).to.equal('100');
        expect(config.trash_add_metadata).to.equal('true');
        expect(config.ppolicy_warn_days).to.equal(14);
        expect(config.ppolicy_min_length).to.equal(12);
        expect(config.ppolicy_require_digit).to.equal(true);
      } finally {
        for (const [name, value] of Object.entries(saved))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
    });

    it('reads the environment and the CLI as before', () => {
      const saved = {
        DM_LDAP_ORGANIZATION_CLASSES: process.env.DM_LDAP_ORGANIZATION_CLASSES,
        DM_LDAP_RAW_HIDDEN_ATTRIBUTES:
          process.env.DM_LDAP_RAW_HIDDEN_ATTRIBUTES,
        DM_ALLOW_UNEXISTENT_MEMBERS: process.env.DM_ALLOW_UNEXISTENT_MEMBERS,
      };
      process.env.DM_LDAP_ORGANIZATION_CLASSES = 'top;organizationalUnit';
      process.env.DM_LDAP_RAW_HIDDEN_ATTRIBUTES = 'userPassword;entryUUID';
      process.env.DM_ALLOW_UNEXISTENT_MEMBERS = 'true';
      try {
        const config = parse([
          'node',
          'ldap-rest',
          '--group-dummy-user',
          'cn=placeholder',
          '--bulk-import-batch-size',
          '250',
          '--ppolicy-min-length',
          '8',
        ]);
        expect(config.ldap_organization_class).to.deep.equal([
          'top',
          'organizationalUnit',
        ]);
        expect(config.ldap_raw_hidden_attribute).to.deep.equal([
          'userPassword',
          'entryUUID',
        ]);
        expect(config.group_dummy_user).to.equal('cn=placeholder');
        expect(config.bulk_import_batch_size).to.equal('250');
        expect(config.ppolicy_min_length).to.equal(8);
        expect(config.groups_allow_unexistent_members).to.equal(true);
      } finally {
        for (const [name, value] of Object.entries(saved))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
    });

    it('refuses a zero where the default used to apply', () => {
      const cases: [string, () => unknown][] = [
        [
          'DM_LDAP_ORGANIZATION_MAX_SUBNODES',
          () => readOptions(organizationOptions, parse()),
        ],
        ['DM_LDAP_RAW_MAX_RESULTS', () => readOptions(rawOptions, parse())],
        [
          'DM_PPOLICY_WARN_DAYS',
          () => readOptions(passwordPolicyOptions, parse()),
        ],
        [
          'DM_PPOLICY_MIN_LENGTH',
          () => readOptions(passwordPolicyOptions, parse()),
        ],
      ];
      for (const [name, read] of cases) {
        const saved = process.env[name];
        process.env[name] = '0';
        try {
          expect(read, name).to.throw(/must be at least 1/);
        } finally {
          if (saved === undefined) delete process.env[name];
          else process.env[name] = saved;
        }
      }
    });
  });

  describe('utility plugin options', () => {
    it('keeps the defaults the parser used to declare', () => {
      const config = parse();
      expect(config.metrics_port).to.equal(9464);
      expect(config.storage_backend).to.equal('');
      expect(config.storage_sweep_interval).to.equal(600);
      expect(config.storage_ldap_object_class).to.equal('applicationProcess');
      expect(config.storage_postgres_table).to.equal('ldap_rest_storage');
      expect(config.storage_valkey_prefix).to.equal('ldap-rest:');
      expect(config.bcl_retention).to.equal(604800);
      expect(config.static_name).to.equal('static');
      expect(config.static_csp).to.equal("frame-ancestors 'self'");
      expect(config.static_frame_options).to.equal('SAMEORIGIN');
      expect(config.static_path).to.match(/static$/);
    });

    it('reads the environment and the CLI as before', () => {
      const saved = {
        DM_METRICS_PORT: process.env.DM_METRICS_PORT,
        DM_STORAGE_BACKEND: process.env.DM_STORAGE_BACKEND,
      };
      process.env.DM_METRICS_PORT = '9999';
      process.env.DM_STORAGE_BACKEND = 'file';
      try {
        const config = parse([
          'node',
          'ldap-rest',
          '--bcl-retention',
          '60',
          '--storage-valkey-prefix',
          'x:',
        ]);
        expect(config.metrics_port).to.equal(9999);
        expect(config.storage_backend).to.equal('file');
        expect(config.bcl_retention).to.equal(60);
        expect(config.storage_valkey_prefix).to.equal('x:');
      } finally {
        for (const [name, value] of Object.entries(saved))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
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

    it('accepts a false only where the option allows it', () => {
      const withFalse = defineOptions({
        header: opt.stringOrFalse({ default: 'x' }),
        plain: opt.string({ default: 'x' }),
      });
      expect(readOptions(withFalse, { header: false }).header).to.equal(false);
      expect(() =>
        readOptions(withFalse, { header: 'x', plain: false })
      ).to.throw(/--plain must be a string/);
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

    it('reads the configuration again when it changed', () => {
      const dm = new DM();
      const plugin = new Sample(dm);
      dm.config.sample_size = 4;
      expect(plugin.options(definitions).sample_size).to.equal(4);
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
        /--required-value is required/
      );
    });
  });
});
