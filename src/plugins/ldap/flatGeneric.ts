/**
 * @module plugins/ldap/flatGeneric
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Generic plugin to manage LDAP flat entities from schema files
 * Automatically creates sub-plugins based on schema metadata
 */
import fs from 'fs';

import type { Express } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import LdapFlat from '../../abstract/ldapFlat';
import type { DM } from '../../bin';
import { transformSchemas } from '../../lib/utils';
import type { Schema } from '../../config/schema';
import type { AttributesList } from '../../lib/ldapActions';

interface EnrichedSchema extends Schema {
  entity: {
    name: string;
    mainAttribute: string;
    objectClass: string[];
    singularName: string;
    pluralName: string;
    base: string;
    defaultAttributes?: Record<string, unknown>;
  };
}

/**
 * Concrete implementation of LdapFlat for generic instances
 */
class LdapFlatInstance extends LdapFlat {
  name: string = 'ldapFlatInstance';
  roles: Role[] = ['api'] as const;

  // Ensure department sync is loaded to maintain consistency
  // when organizations are renamed/moved
  dependencies = {
    departmentSync: 'core/ldap/departmentSync',
  };

  constructor(server: DM, config: ConstructorParameters<typeof LdapFlat>[1]) {
    super(server, config);
  }
}

export default class LdapFlatGeneric extends DmPlugin {
  name = 'ldapFlatGeneric';
  roles: Role[] = ['configurable'] as const;
  instances: LdapFlatInstance[] = [];
  private schemaPaths: string[] = [];

  constructor(server: DM) {
    super(server);

    const schemas = this.config.ldap_flat_schema || [];

    if (schemas.length === 0) {
      this.logger.warn('No schemas provided for ldapFlatGeneric plugin');
      return;
    }

    // Load each schema and create an instance
    schemas.forEach((schemaPath) => {
      try {
        const schemaData = fs.readFileSync(schemaPath, 'utf8');
        const schema = JSON.parse(
          transformSchemas(schemaData, this.config)
        ) as EnrichedSchema;

        if (!schema.entity) {
          throw new Error(
            `Schema ${schemaPath} is missing "entity" metadata section`
          );
        }

        // Validate required fields
        const required = [
          'name',
          'mainAttribute',
          'objectClass',
          'singularName',
          'pluralName',
          'base',
        ];
        for (const field of required) {
          if (!schema.entity[field as keyof typeof schema.entity]) {
            throw new Error(`Schema ${schemaPath} is missing entity.${field}`);
          }
        }

        // Resolve base with config placeholders
        let base = schema.entity.base;
        // Replace all {config_key} patterns with actual config values
        base = base.replace(/\{([^}]+)\}/g, (match, key) => {
          const configKey = key as keyof typeof this.config;
          const value = this.config[configKey];
          return typeof value === 'string' ? value : match;
        });

        // Create the instance
        const instance = new LdapFlatInstance(server, {
          base,
          mainAttribute: schema.entity.mainAttribute,
          objectClass: schema.entity.objectClass,
          defaultAttributes: (schema.entity.defaultAttributes ||
            {}) as AttributesList,
          schemaPath,
          singularName: schema.entity.singularName,
          pluralName: schema.entity.pluralName,
          hookPrefix: `ldap${schema.entity.name}`,
        });

        instance.name = `ldapFlat:${schema.entity.name}`;
        this.instances.push(instance);
        this.schemaPaths.push(schemaPath);

        this.logger.info(
          `Created ldapFlat instance for "${schema.entity.name}" (${schema.entity.pluralName})`
        );
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        this.logger.error(`Failed to load schema ${schemaPath}: ${err}`);
      }
    });
  }

  /**
   * Register all instance APIs
   */
  api(app: Express): void {
    this.instances.forEach(instance => {
      instance.api(app);
    });
  }

  /**
   * Provide configuration for config API
   */
  getConfigApiData(): Record<string, unknown> {
    const apiPrefix = this.config.api_prefix || '/api';
    const staticName = this.config.static_name || 'static';

    const flatResources = this.instances.map((instance, index) => {
      // Generate schema URL if static plugin is loaded
      let schemaUrl: string | undefined;
      if (this.server.loadedPlugins['static'] && this.schemaPaths[index]) {
        const schemaPath = this.schemaPaths[index];
        const schemasIndex = schemaPath.indexOf('/schemas/');
        if (schemasIndex !== -1) {
          const relativePath = schemaPath.substring(schemasIndex);
          schemaUrl = `/${staticName}${relativePath}`;
        }
      }

      return {
        name: instance.name.replace('ldapFlat:', ''),
        singularName: instance.singularName,
        pluralName: instance.pluralName,
        mainAttribute: instance.mainAttribute,
        objectClass: instance.objectClass,
        base: instance.base,
        schema: instance.schema || { strict: false, attributes: {} },
        schemaUrl,
        endpoints: {
          list: `${apiPrefix}/v1/ldap/${instance.pluralName}`,
          get: `${apiPrefix}/v1/ldap/${instance.pluralName}/:id`,
          create: `${apiPrefix}/v1/ldap/${instance.pluralName}`,
          update: `${apiPrefix}/v1/ldap/${instance.pluralName}/:id`,
          delete: `${apiPrefix}/v1/ldap/${instance.pluralName}/:id`,
        },
      };
    });

    return {
      flatResources,
    };
  }
}
