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

/**
 * @openapi-component
 * Config:
 *   type: object
 *   description: |
 *     Aggregated server configuration. The top-level fields are always
 *     present; `features` is a dynamic map whose keys are the names of
 *     loaded plugins that declare the `configurable` role.  Each plugin
 *     contributes an arbitrary sub-object — consult the individual plugin
 *     documentation for its exact shape.
 *   additionalProperties: true
 *   properties:
 *     apiPrefix:
 *       type: string
 *       description: The API base path configured on this server.
 *       example: /api
 *     ldapBase:
 *       type: string
 *       description: The root LDAP suffix used by this server.
 *       example: dc=example,dc=com
 *     features:
 *       type: object
 *       description: |
 *         Per-plugin configuration blocks.  Keys match the plugin's
 *         `name` field; values are plugin-specific objects.
 *       additionalProperties: true
 *       example:
 *         ldapGroups:
 *           enabled: true
 *           base: ou=groups,dc=example,dc=com
 *           mainAttribute: cn
 *           objectClass: [top, groupOfNames]
 *         static:
 *           enabled: true
 *           staticPath: /static
 *         appAccountsApi:
 *           enabled: true
 *           base: ou=app-accounts,dc=example,dc=com
 *           maxAccounts: 5
 *   example:
 *     apiPrefix: /api
 *     ldapBase: dc=example,dc=com
 *     features:
 *       ldapGroups:
 *         enabled: true
 *         base: ou=groups,dc=example,dc=com
 *         mainAttribute: cn
 *       static:
 *         enabled: true
 *         staticPath: /static
 */
export default class ConfigApi extends DmPlugin {
  name = 'configApi';
  roles: Role[] = ['api'] as const;

  /**
   * API routes
   */

  api(app: Express): void {
    const apiPrefix = this.config.api_prefix || '/api';

    /**
     * @openapi
     * summary: Get server configuration
     * description: |
     *   Returns aggregated runtime configuration for all loaded plugins.
     *   Plugins that declare the `configurable` role expose a named block
     *   under `features` via their `getConfigApiData()` method.  The
     *   response shape is open-ended (`additionalProperties: true`) because
     *   the exact keys depend on which plugins are active.
     *
     *   Typical consumers include browser-embedded LDAP editors that need
     *   to discover available schemas, endpoint prefixes, and feature flags
     *   without hard-coding server topology.
     * responses:
     *   '200':
     *     description: Server configuration.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Config' }
     *         example:
     *           apiPrefix: /api
     *           ldapBase: dc=example,dc=com
     *           features:
     *             ldapGroups:
     *               enabled: true
     *               base: ou=groups,dc=example,dc=com
     *               mainAttribute: cn
     *               objectClass: [top, groupOfNames]
     *             static:
     *               enabled: true
     *               staticPath: /static
     *               endpoints:
     *                 schema: /static/schemas/:name
     *                 schemaInSubdir: /static/schemas/:dir/:name
     */
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
