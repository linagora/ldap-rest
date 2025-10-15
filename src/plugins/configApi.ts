/**
 * @module plugins/configApi
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Plugin that exposes API configuration for LDAP editor applications
 * Provides information about available resources, schemas, and endpoints
 *
 * Uses autodiscovery pattern: plugins with 'configurable' role automatically
 * expose their configuration via getConfigApiData() method
 */
import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../abstract/plugin';
import { wantJson } from '../lib/expressFormatedResponses';

interface ConfigApiResponse {
  apiPrefix: string;
  ldapBase: string;
  features: Record<string, unknown>;
}

export default class ConfigApi extends DmPlugin {
  name = 'configApi';
  roles: Role[] = ['api'] as const;

  /**
   * API routes
   */

  api(app: Express): void {
    const apiPrefix = this.config.api_prefix || '/api';

    app.get(`${apiPrefix}/v1/config`, (req: Request, res: Response) => {
      if (!wantJson(req, res)) return;

      const config: ConfigApiResponse = {
        apiPrefix: apiPrefix,
        ldapBase: this.config.ldap_base || '',
        features: this.collectPluginConfigs(),
      };

      res.json(config);
    });

    this.logger.info(`Configuration API registered at ${apiPrefix}/v1/config`);
  }

  /**
   * Collect configuration from all plugins with 'configurable' role
   */
  private collectPluginConfigs(): Record<string, unknown> {
    const features: Record<string, unknown> = {};

    // Iterate through all loaded plugins
    for (const [pluginName, plugin] of Object.entries(
      this.server.loadedPlugins
    )) {
      // Skip self
      if (pluginName === 'configApi') continue;

      // Check if plugin has 'configurable' role
      if (plugin.roles?.includes('configurable') && plugin.getConfigApiData) {
        try {
          const pluginConfig = plugin.getConfigApiData();
          if (pluginConfig) {
            features[pluginName] = pluginConfig;
          }
        } catch (err) {
          this.logger.warn(
            `Failed to get config from plugin ${pluginName}: ${String(err)}`
          );
        }
      }
    }

    return features;
  }
}
