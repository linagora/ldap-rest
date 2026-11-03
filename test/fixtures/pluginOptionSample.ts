/** A plugin module whose only export is the class the loader reads */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const sampleOptions = defineOptions({
  sample_timeout: opt.number({ env: 'DM_SAMPLE_TIMEOUT', default: 5 }),
});

export type SampleOptions = OptionsOf<typeof sampleOptions>;

export default class Sample {
  static optionDefinitions = sampleOptions;
}
