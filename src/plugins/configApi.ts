/**
 * @module plugins/configApi
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Plugin that exposes API configuration for LDAP editor applications
 * Provides information about available resources, schemas, and endpoints
 */
import fs from 'fs';

import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../abstract/plugin';
import { transformSchemas } from '../lib/utils';
import { wantJson } from '../lib/expressFormatedResponses';
import type { Schema } from '../config/schema';

import type LdapFlatGeneric from './ldap/flatGeneric';
import type LdapGroups from './ldap/groups';
import type LdapOrganization from './ldap/organization';
import type LdapBulkImport from './ldap/bulkImport';

interface FlatResourceConfig {
  name: string;
  singularName: string;
  pluralName: string;
  mainAttribute: string;
  objectClass: string[];
  base: string;
  schema: Schema;
  schemaUrl?: string;
  endpoints: {
    list: string;
    get: string;
    create: string;
    update: string;
    delete: string;
  };
}

interface GroupsConfig {
  enabled: boolean;
  base: string;
  mainAttribute: string;
  objectClass: string[];
  schema?: Schema;
  schemaUrl?: string;
  endpoints: {
    list: string;
    get: string;
    create: string;
    update: string;
    delete: string;
    addMember: string;
    removeMember: string;
  };
}

interface OrganizationsConfig {
  enabled: boolean;
  topOrganization: string;
  organizationClass: string[];
  linkAttribute: string;
  pathAttribute: string;
  pathSeparator: string;
  maxSubnodes: number;
  schema?: Schema;
  schemaUrl?: string;
  endpoints: {
    getTop: string;
    get: string;
    getSubnodes: string;
    searchSubnodes: string;
  };
}

interface BulkImportResourceConfig {
  name: string;
  mainAttribute: string;
  base: string;
  maxFileSize: number;
  batchSize: number;
  endpoints: {
    template: string;
    import: string;
  };
}

interface BulkImportConfig {
  enabled: boolean;
  resources: BulkImportResourceConfig[];
}

interface ConfigApiResponse {
  apiPrefix: string;
  ldapBase: string;
  features: {
    groups?: GroupsConfig;
    organizations?: OrganizationsConfig;
    bulkImport?: BulkImportConfig;
    flatResources: FlatResourceConfig[];
  };
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
        features: {
          flatResources: this.getFlatResourcesConfig(),
        },
      };

      // Add groups if available
      const groupsConfig = this.getGroupsConfig();
      if (groupsConfig) {
        config.features.groups = groupsConfig;
      }

      // Add organizations if available
      const orgsConfig = this.getOrganizationsConfig();
      if (orgsConfig) {
        config.features.organizations = orgsConfig;
      }

      // Add bulk import if available
      const bulkImportConfig = this.getBulkImportConfig();
      if (bulkImportConfig) {
        config.features.bulkImport = bulkImportConfig;
      }

      res.json(config);
    });

    this.logger.info(`Configuration API registered at ${apiPrefix}/v1/config`);
  }

  /**
   * Generate schema URL if static plugin is loaded
   */
  private getSchemaUrl(schemaPath: string): string | undefined {
    // Check if static plugin is loaded
    if (!this.server.loadedPlugins['static']) {
      return undefined;
    }

    const staticName = this.config.static_name || 'static';
    const staticPath = this.config.static_path;

    if (!staticPath || !schemaPath) {
      return undefined;
    }

    // Extract relative path from schema file path
    // Schema path format: /path/to/static/schemas/dir/file.json
    // We need: /static/schemas/dir/file.json
    const schemasIndex = schemaPath.indexOf('/schemas/');
    if (schemasIndex === -1) {
      return undefined;
    }

    const relativePath = schemaPath.substring(schemasIndex);
    return `/${staticName}${relativePath}`;
  }

  /**
   * Get configuration for ldapFlat instances
   */
  private getFlatResourcesConfig(): FlatResourceConfig[] {
    const flatPlugin = this.server.loadedPlugins[
      'ldapFlatGeneric'
    ] as LdapFlatGeneric;
    if (!flatPlugin || !flatPlugin.instances) {
      return [];
    }

    const resources: FlatResourceConfig[] = [];

    const schemas = this.config.ldap_flat_schema || [];
    let schemaIndex = 0;

    flatPlugin.instances.forEach(instance => {
      // Load and parse schema
      let schema: Schema | undefined;
      if (instance.schema) {
        schema = instance.schema;
      }

      const apiPrefix = this.config.api_prefix || '/api';
      const resourceName = instance.pluralName;

      // Generate schema URL if static plugin is loaded
      const schemaPath = schemas[schemaIndex];
      const schemaUrl = schemaPath ? this.getSchemaUrl(schemaPath) : undefined;
      schemaIndex++;

      resources.push({
        name: instance.name.replace('ldapFlat:', ''),
        singularName: instance.singularName,
        pluralName: instance.pluralName,
        mainAttribute: instance.mainAttribute,
        objectClass: instance.objectClass,
        base: instance.base,
        schema: schema || { strict: false, attributes: {} },
        schemaUrl,
        endpoints: {
          list: `${apiPrefix}/v1/ldap/${resourceName}`,
          get: `${apiPrefix}/v1/ldap/${resourceName}/:id`,
          create: `${apiPrefix}/v1/ldap/${resourceName}`,
          update: `${apiPrefix}/v1/ldap/${resourceName}/:id`,
          delete: `${apiPrefix}/v1/ldap/${resourceName}/:id`,
        },
      });
    });

    return resources;
  }

  /**
   * Get configuration for groups plugin
   */
  private getGroupsConfig(): GroupsConfig | undefined {
    const groupsPlugin = this.server.loadedPlugins['ldapGroups'] as LdapGroups;
    if (!groupsPlugin) {
      return undefined;
    }

    const apiPrefix = this.config.api_prefix || '/api';
    let schema: Schema | undefined;

    // Load group schema if available
    if (this.config.group_schema) {
      try {
        const schemaData = fs.readFileSync(this.config.group_schema, 'utf8');
        schema = JSON.parse(
          transformSchemas(schemaData, this.config)
        ) as Schema;
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        this.logger.warn(`Failed to load group schema: ${err}`);
      }
    }

    // Generate schema URL if static plugin is loaded
    const schemaUrl = this.config.group_schema
      ? this.getSchemaUrl(this.config.group_schema)
      : undefined;

    return {
      enabled: true,
      base: this.config.ldap_group_base || '',
      mainAttribute: this.config.ldap_groups_main_attribute || 'cn',
      objectClass: this.config.group_class || ['top', 'groupOfNames'],
      schema,
      schemaUrl,
      endpoints: {
        list: `${apiPrefix}/v1/ldap/groups`,
        get: `${apiPrefix}/v1/ldap/groups/:id`,
        create: `${apiPrefix}/v1/ldap/groups`,
        update: `${apiPrefix}/v1/ldap/groups/:id`,
        delete: `${apiPrefix}/v1/ldap/groups/:id`,
        addMember: `${apiPrefix}/v1/ldap/groups/:id/members`,
        removeMember: `${apiPrefix}/v1/ldap/groups/:id/members/:memberId`,
      },
    };
  }

  /**
   * Get configuration for organizations plugin
   */
  private getOrganizationsConfig(): OrganizationsConfig | undefined {
    const orgPlugin = this.server.loadedPlugins[
      'ldapOrganizations'
    ] as LdapOrganization;
    if (!orgPlugin) {
      return undefined;
    }

    const apiPrefix = this.config.api_prefix || '/api';

    // Load organization schema if available
    let schema: Schema | undefined;
    if (this.config.organization_schema) {
      try {
        const schemaData = fs.readFileSync(
          this.config.organization_schema,
          'utf8'
        );
        schema = JSON.parse(
          transformSchemas(schemaData, this.config)
        ) as Schema;
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        this.logger.warn(`Failed to load organization schema: ${err}`);
      }
    }

    // Generate schema URL if static plugin is loaded
    const schemaUrl = this.config.organization_schema
      ? this.getSchemaUrl(this.config.organization_schema)
      : undefined;

    return {
      enabled: true,
      topOrganization: this.config.ldap_top_organization || '',
      organizationClass: this.config.ldap_organization_class || [
        'top',
        'organizationalUnit',
      ],
      linkAttribute: this.config.ldap_organization_link_attribute || '',
      pathAttribute: this.config.ldap_organization_path_attribute || '',
      pathSeparator: this.config.ldap_organization_path_separator || ' / ',
      maxSubnodes: this.config.ldap_organization_max_subnodes || 50,
      schema,
      schemaUrl,
      endpoints: {
        getTop: `${apiPrefix}/v1/ldap/organizations`,
        get: `${apiPrefix}/v1/ldap/organizations/:dn`,
        getSubnodes: `${apiPrefix}/v1/ldap/organizations/:dn/subnodes`,
        searchSubnodes: `${apiPrefix}/v1/ldap/organizations/:dn/subnodes/search`,
      },
    };
  }

  /**
   * Get configuration for bulk import plugin
   */
  private getBulkImportConfig(): BulkImportConfig | undefined {
    const bulkImportPlugin = this.server.loadedPlugins[
      'ldapBulkImport'
    ] as LdapBulkImport;
    if (!bulkImportPlugin) {
      return undefined;
    }

    const apiPrefix = this.config.api_prefix || '/api';
    const resources: BulkImportResourceConfig[] = [];

    // Access the resources map from the plugin
    // @ts-expect-error - accessing private property for configuration purposes
    const resourcesMap = bulkImportPlugin.resources as Map<
      string,
      {
        name: string;
        base: string;
        mainAttribute: string;
      }
    >;

    if (!resourcesMap) {
      return undefined;
    }

    resourcesMap.forEach((resource, resourceName) => {
      resources.push({
        name: resourceName,
        mainAttribute: resource.mainAttribute,
        base: resource.base,
        maxFileSize:
          parseInt(this.config.bulk_import_max_file_size as string, 10) ||
          10485760,
        batchSize:
          parseInt(this.config.bulk_import_batch_size as string, 10) || 100,
        endpoints: {
          template: `${apiPrefix}/v1/ldap/bulk-import/${resourceName}/template.csv`,
          import: `${apiPrefix}/v1/ldap/bulk-import/${resourceName}`,
        },
      });
    });

    return {
      enabled: true,
      resources,
    };
  }
}
