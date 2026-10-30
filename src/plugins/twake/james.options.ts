/**
 * James plugin options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const jamesOptions = defineOptions({
  james_webadmin_url: opt.string({
    env: 'DM_JAMES_WEBADMIN_URL',
    default: 'http://localhost:8000',
  }),
  james_webadmin_token: opt.string({
    env: 'DM_JAMES_WEBADMIN_TOKEN',
    default: '',
  }),
  james_signature_template: opt.string({
    env: 'DM_JAMES_SIGNATURE_TEMPLATE',
    default: '',
  }),
  james_concurrency: opt.number({
    env: 'DM_JAMES_CONCURRENCY',
    default: 10,
    min: 1,
  }),
  james_init_delay: opt.number({
    env: 'DM_JAMES_INIT_DELAY',
    default: 1000,
  }),
  james_retry_attempts: opt.number({
    env: 'DM_JAMES_RETRY_ATTEMPTS',
    default: 5,
  }),
  james_retry_delay: opt.number({
    env: 'DM_JAMES_RETRY_DELAY',
    default: 1000,
  }),
  james_mailing_list_branch: opt.array({
    env: 'DM_JAMES_MAILING_LIST_BRANCHES',
    default: [],
    plural: 'james-mailing-list-branches',
    kind: 'dns',
  }),
  james_mailbox_type_attribute: opt.string({
    env: 'DM_JAMES_MAILBOX_TYPE_ATTRIBUTE',
    default: 'twakeMailboxType',
  }),
  james_sync_forwards: opt.boolean({
    env: 'DM_JAMES_SYNC_FORWARDS',
    default: false,
  }),
  james_team_mailbox_any_domain: opt.boolean({
    env: 'DM_JAMES_TEAM_MAILBOX_ANY_DOMAIN',
    default: false,
  }),
});

export type JamesOptions = OptionsOf<typeof jamesOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function jamesOptionsOf(config: Config): JamesOptions {
  return readOptions(jamesOptions, config);
}
