/**
 * @module plugins/scim/discovery
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM 2.0 discovery endpoints:
 *   GET /ServiceProviderConfig
 *   GET /ResourceTypes (and /ResourceTypes/User, /ResourceTypes/Group)
 *   GET /Schemas       (and /Schemas/{urn})
 */
import fs from 'fs';
import path from 'path';

import type { Config } from '../../config/args';
import type { DmRequest } from '../../lib/auth/base';

import {
  type ResourceTypeDefinition,
  type ServiceProviderConfig,
  type SchemaDefinition,
  SCHEMA_USER,
  SCHEMA_GROUP,
  SCHEMA_RESOURCE_TYPE,
  SCHEMA_SCHEMA,
  SCHEMA_SERVICE_PROVIDER_CONFIG,
} from './types';

export interface DiscoveryOptions {
  config: Config;
  schemaDir: string;
  scimPrefix: string;
  loadedPlugins: { [name: string]: unknown };
}

interface AuthScheme {
  name: string;
  description: string;
  type: string;
  specUri?: string;
  documentationUri?: string;
  primary?: boolean;
}

export class ScimDiscovery {
  private readonly config: Config;
  private readonly schemaDir: string;
  private readonly scimPrefix: string;
  private readonly loadedPlugins: { [name: string]: unknown };

  constructor(opts: DiscoveryOptions) {
    this.config = opts.config;
    this.schemaDir = opts.schemaDir;
    this.scimPrefix = opts.scimPrefix;
    this.loadedPlugins = opts.loadedPlugins;
  }

  private baseUrl(req?: DmRequest): string {
    const fromConfig = (this.config.scim_base_url as string) || '';
    if (fromConfig) return fromConfig.replace(/\/$/, '');
    if (req?.protocol && req.get) {
      return `${req.protocol}://${String(req.get('host') || '')}`;
    }
    return '';
  }

  private location(req: DmRequest | undefined, suffix: string): string {
    return `${this.baseUrl(req)}${this.scimPrefix}${suffix}`;
  }

  private authSchemes(): AuthScheme[] {
    const schemes: AuthScheme[] = [];
    if (this.loadedPlugins['authToken']) {
      schemes.push({
        name: 'OAuth Bearer Token',
        description:
          'Bearer token configured via --auth-token. Send "Authorization: Bearer <token>".',
        type: 'oauthbearertoken',
        primary: schemes.length === 0,
      });
    }
    if (this.loadedPlugins['openidconnect']) {
      schemes.push({
        name: 'OpenID Connect',
        description: 'OIDC-issued access token.',
        type: 'oauth2',
        specUri: 'https://openid.net/specs/openid-connect-core-1_0.html',
        primary: schemes.length === 0,
      });
    }
    if (this.loadedPlugins['authHmac']) {
      schemes.push({
        name: 'HMAC',
        description: 'Signed request via HMAC-SHA256.',
        type: 'httpbasic',
        primary: schemes.length === 0,
      });
    }
    if (schemes.length === 0) {
      schemes.push({
        name: 'No authentication',
        description:
          'No authentication plugin loaded. NOT RECOMMENDED for production.',
        type: 'httpbasic',
        primary: true,
      });
    }
    return schemes;
  }

  serviceProviderConfig(req?: DmRequest): ServiceProviderConfig {
    return {
      schemas: [SCHEMA_SERVICE_PROVIDER_CONFIG],
      patch: { supported: true },
      bulk: {
        supported: true,
        maxOperations: (this.config.scim_bulk_max_operations as number) || 100,
        maxPayloadSize:
          (this.config.scim_bulk_max_payload_size as number) || 1048576,
      },
      filter: {
        supported: true,
        maxResults: (this.config.scim_max_results as number) || 200,
      },
      changePassword: { supported: false },
      // Sorting is parsed for backwards compatibility but not consistently
      // applied server-side (see Users/Groups list handlers). We advertise
      // it as unsupported to avoid clients depending on stale guarantees.
      sort: { supported: false },
      etag: { supported: Boolean(this.config.scim_etag) },
      authenticationSchemes: this.authSchemes(),
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: this.location(req, '/ServiceProviderConfig'),
      },
    };
  }

  resourceTypes(req?: DmRequest): ResourceTypeDefinition[] {
    return [
      {
        schemas: [SCHEMA_RESOURCE_TYPE],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        description: 'User Account',
        schema: SCHEMA_USER,
        meta: {
          resourceType: 'ResourceType',
          location: this.location(req, '/ResourceTypes/User'),
        },
      },
      {
        schemas: [SCHEMA_RESOURCE_TYPE],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        description: 'Group',
        schema: SCHEMA_GROUP,
        meta: {
          resourceType: 'ResourceType',
          location: this.location(req, '/ResourceTypes/Group'),
        },
      },
    ];
  }

  resourceType(
    name: string,
    req?: DmRequest
  ): ResourceTypeDefinition | undefined {
    return this.resourceTypes(req).find(r => r.id === name);
  }

  schemas(req?: DmRequest): SchemaDefinition[] {
    const userSchema = this.loadSchema('User.json', SCHEMA_USER);
    const groupSchema = this.loadSchema('Group.json', SCHEMA_GROUP);
    const all = [userSchema, groupSchema].filter(
      (s): s is SchemaDefinition => s != null
    );
    for (const s of all) {
      s.meta = {
        resourceType: 'Schema',
        location: this.location(req, `/Schemas/${s.id}`),
      };
    }
    return all;
  }

  schema(id: string, req?: DmRequest): SchemaDefinition | undefined {
    return this.schemas(req).find(s => s.id === id);
  }

  private loadSchema(
    filename: string,
    urn: string
  ): SchemaDefinition | undefined {
    const filepath = path.join(this.schemaDir, filename);
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      const parsed = JSON.parse(content) as Partial<SchemaDefinition>;
      return {
        schemas: [SCHEMA_SCHEMA],
        id: urn,
        name: (parsed.name as string) || urn.split(':').pop() || urn,
        description: parsed.description,
        attributes: (parsed.attributes as unknown[]) || [],
      };
    } catch {
      return undefined;
    }
  }
}
