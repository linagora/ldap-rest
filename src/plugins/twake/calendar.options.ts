/**
 * Twake Calendar plugin options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const calendarOptions = defineOptions({
  calendar_webadmin_url: opt.string({
    env: 'DM_CALENDAR_WEBADMIN_URL',
    default: 'http://localhost:8080',
  }),
  calendar_webadmin_token: opt.string({
    env: 'DM_CALENDAR_WEBADMIN_TOKEN',
    default: '',
  }),
  calendar_concurrency: opt.number({
    env: 'DM_CALENDAR_CONCURRENCY',
    default: 10,
    min: 1,
  }),
  calendar_resource_base: opt.string({
    env: 'DM_CALENDAR_RESOURCE_BASE',
    default: '',
  }),
  calendar_resource_objectclass: opt.string({
    env: 'DM_CALENDAR_RESOURCE_OBJECTCLASS',
    default: '',
  }),
  calendar_resource_creator: opt.string({
    env: 'DM_CALENDAR_RESOURCE_CREATOR',
    default: 'admin@example.com',
  }),
  calendar_resource_domain: opt.string({
    env: 'DM_CALENDAR_RESOURCE_DOMAIN',
    default: '',
  }),
  calendar_firstname_attribute: opt.string({
    env: 'DM_CALENDAR_FIRSTNAME_ATTRIBUTE',
    default: 'givenName',
  }),
  calendar_lastname_attribute: opt.string({
    env: 'DM_CALENDAR_LASTNAME_ATTRIBUTE',
    default: 'sn',
  }),
});

export type CalendarOptions = OptionsOf<typeof calendarOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function calendarOptionsOf(config: Config): CalendarOptions {
  return readOptions(calendarOptions, config);
}
