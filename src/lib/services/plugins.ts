/**
 * The loaded plugins, as the core services that need to see them all read
 * them.
 *
 * A plugin that needs another one asks for that one's service; this answers
 * only the cross-cutting questions: whether a plugin is loaded, and which
 * ones take part in configuration, operational attributes, generated
 * attributes or authorization.
 *
 * @see docs/plugin-development/services.md
 */
import type DmPlugin from '../../abstract/plugin';
import type { GeneratedAttributeFiller } from '../../config/schema';

import { serviceToken } from './index';

export interface PluginInfo {
  /** Whether a plugin with this registry name is loaded. */
  has(name: string): boolean;
  /** The plugins serving the configuration API. */
  configurable(): readonly DmPlugin[];
  /** The plugins declaring operational attributes to follow. */
  operationalAttributeFollowers(): readonly DmPlugin[];
  /** The plugins able to fill a generated attribute. */
  generatedAttributeFillers(): readonly GeneratedAttributeFiller[];
  /** The authorization plugins. */
  authzPlugins(): readonly DmPlugin[];
}

export const PluginInfoService = serviceToken<PluginInfo>('plugins');
