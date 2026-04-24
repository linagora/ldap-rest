/**
 * @module plugins/scim/scim
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM 2.0 plugin. Loads via `--plugin core/scim`.
 *
 * Exposes /scim/v2/{Users,Groups,Bulk,ServiceProviderConfig,ResourceTypes,Schemas}.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import type { Express, Request } from 'express';
import bodyParser from 'body-parser';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type ldapActions from '../../lib/ldapActions';
import type { DmRequest } from '../../lib/auth/base';

import { BaseResolver } from './baseResolver';
import { ScimUsers } from './users';
import { ScimGroups } from './groups';
import { ScimBulk } from './bulk';
import { ScimDiscovery } from './discovery';
import {
  scimAsyncHandler,
  writeScimError,
  writeScimErrorFromException,
  SCIM_CONTENT_TYPE,
} from './errors';
import {
  type BulkRequest,
  type PatchRequest,
  type ScimGroup,
  type ScimUser,
} from './types';

export default class Scim extends DmPlugin {
  name = 'scim';
  roles: Role[] = ['api', 'configurable'] as const;

  ldap: ldapActions;
  private readonly scimPrefix: string;
  private readonly users: ScimUsers;
  private readonly groups: ScimGroups;
  private readonly bulk: ScimBulk;
  private readonly discovery: ScimDiscovery;
  private readonly baseResolver: BaseResolver;

  constructor(server: DM) {
    super(server);
    this.ldap = server.ldap;
    this.scimPrefix = (this.config.scim_prefix as string) || '/scim/v2';

    this.baseResolver = new BaseResolver(this.config);

    this.users = new ScimUsers({
      ldap: this.ldap,
      config: this.config,
      logger: this.logger,
      baseResolver: this.baseResolver,
      hooks: this.registeredHooks as {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        [K: string]: Function[] | undefined;
      },
    });

    this.groups = new ScimGroups({
      ldap: this.ldap,
      config: this.config,
      logger: this.logger,
      baseResolver: this.baseResolver,
      users: this.users,
      hooks: this.registeredHooks as {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        [K: string]: Function[] | undefined;
      },
    });

    this.bulk = new ScimBulk({
      config: this.config,
      logger: this.logger,
      users: this.users,
      groups: this.groups,
      scimPrefix: this.scimPrefix,
      hooks: this.registeredHooks as {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        [K: string]: Function[] | undefined;
      },
    });

    const schemaDir =
      this.config.schemas_path ||
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'static',
        'schemas'
      );
    this.discovery = new ScimDiscovery({
      config: this.config,
      schemaDir: join(schemaDir, 'scim'),
      scimPrefix: this.scimPrefix,
      loadedPlugins: server.loadedPlugins,
    });
  }

  private scimJson(
    res: import('express').Response,
    status: number,
    body: unknown
  ): void {
    res.status(status).type(SCIM_CONTENT_TYPE).json(body);
  }

  private readScimBody(req: Request): unknown {
    // Accept application/scim+json as well as application/json
    const ct = String(req.headers['content-type'] || '');
    if (
      !ct.startsWith('application/scim+json') &&
      !ct.startsWith('application/json')
    ) {
      return undefined;
    }
    return req.body;
  }

  api(app: Express): void {
    const prefix = this.scimPrefix;

    // SCIM 2.0 uses Content-Type: application/scim+json (RFC 7644 §3.1.1).
    // The global bodyParser.json() installed by DM only accepts application/json,
    // so we install a scoped parser that handles both for all SCIM routes.
    app.use(
      prefix,
      bodyParser.json({
        type: ['application/json', 'application/scim+json'],
        limit: `${
          (this.config.scim_bulk_max_payload_size as number) || 1048576
        }b`,
      })
    );

    /** Users */
    app.get(
      `${prefix}/Users`,
      scimAsyncHandler(async (req, res) => {
        const q = this.parseListQuery(req);
        const list = await this.users.list(req as DmRequest, q);
        this.scimJson(res, 200, list);
      })
    );
    app.get(
      `${prefix}/Users/:id`,
      scimAsyncHandler(async (req, res) => {
        const user = await this.users.get(
          req as DmRequest,
          decodeURIComponent(req.params.id as string)
        );
        this.scimJson(res, 200, user);
      })
    );
    app.post(
      `${prefix}/Users`,
      scimAsyncHandler(async (req, res) => {
        const body = this.readScimBody(req);
        if (!body || typeof body !== 'object') {
          return writeScimError(res, 400, 'Missing body', 'invalidSyntax');
        }
        const user = await this.users.create(
          req as DmRequest,
          body as ScimUser
        );
        this.scimJson(res, 201, user);
      })
    );
    app.put(
      `${prefix}/Users/:id`,
      scimAsyncHandler(async (req, res) => {
        const body = this.readScimBody(req);
        if (!body || typeof body !== 'object') {
          return writeScimError(res, 400, 'Missing body', 'invalidSyntax');
        }
        const user = await this.users.replace(
          req as DmRequest,
          decodeURIComponent(req.params.id as string),
          body as ScimUser
        );
        this.scimJson(res, 200, user);
      })
    );
    app.patch(
      `${prefix}/Users/:id`,
      scimAsyncHandler(async (req, res) => {
        const body = this.readScimBody(req);
        if (!body || typeof body !== 'object') {
          return writeScimError(res, 400, 'Missing body', 'invalidSyntax');
        }
        const user = await this.users.patch(
          req as DmRequest,
          decodeURIComponent(req.params.id as string),
          body as PatchRequest
        );
        this.scimJson(res, 200, user);
      })
    );
    app.delete(
      `${prefix}/Users/:id`,
      scimAsyncHandler(async (req, res) => {
        await this.users.delete(
          req as DmRequest,
          decodeURIComponent(req.params.id as string)
        );
        res.status(204).end();
      })
    );

    /** Groups */
    app.get(
      `${prefix}/Groups`,
      scimAsyncHandler(async (req, res) => {
        const q = this.parseListQuery(req);
        const list = await this.groups.list(req as DmRequest, q);
        this.scimJson(res, 200, list);
      })
    );
    app.get(
      `${prefix}/Groups/:id`,
      scimAsyncHandler(async (req, res) => {
        const group = await this.groups.get(
          req as DmRequest,
          decodeURIComponent(req.params.id as string)
        );
        this.scimJson(res, 200, group);
      })
    );
    app.post(
      `${prefix}/Groups`,
      scimAsyncHandler(async (req, res) => {
        const body = this.readScimBody(req);
        if (!body || typeof body !== 'object') {
          return writeScimError(res, 400, 'Missing body', 'invalidSyntax');
        }
        const group = await this.groups.create(
          req as DmRequest,
          body as ScimGroup
        );
        this.scimJson(res, 201, group);
      })
    );
    app.put(
      `${prefix}/Groups/:id`,
      scimAsyncHandler(async (req, res) => {
        const body = this.readScimBody(req);
        if (!body || typeof body !== 'object') {
          return writeScimError(res, 400, 'Missing body', 'invalidSyntax');
        }
        const group = await this.groups.replace(
          req as DmRequest,
          decodeURIComponent(req.params.id as string),
          body as ScimGroup
        );
        this.scimJson(res, 200, group);
      })
    );
    app.patch(
      `${prefix}/Groups/:id`,
      scimAsyncHandler(async (req, res) => {
        const body = this.readScimBody(req);
        if (!body || typeof body !== 'object') {
          return writeScimError(res, 400, 'Missing body', 'invalidSyntax');
        }
        const group = await this.groups.patch(
          req as DmRequest,
          decodeURIComponent(req.params.id as string),
          body as PatchRequest
        );
        this.scimJson(res, 200, group);
      })
    );
    app.delete(
      `${prefix}/Groups/:id`,
      scimAsyncHandler(async (req, res) => {
        await this.groups.delete(
          req as DmRequest,
          decodeURIComponent(req.params.id as string)
        );
        res.status(204).end();
      })
    );

    /** Bulk */
    app.post(
      `${prefix}/Bulk`,
      scimAsyncHandler(async (req, res) => {
        const body = this.readScimBody(req);
        if (!body || typeof body !== 'object') {
          return writeScimError(res, 400, 'Missing body', 'invalidSyntax');
        }
        const maxPayload =
          (this.config.scim_bulk_max_payload_size as number) || 1048576;
        const size = JSON.stringify(body).length;
        if (size > maxPayload) {
          return writeScimError(
            res,
            413,
            `Bulk payload too large: ${size} > ${maxPayload}`,
            'invalidValue'
          );
        }
        const response = await this.bulk.execute(
          req as DmRequest,
          body as BulkRequest
        );
        this.scimJson(res, 200, response);
      })
    );

    /** Discovery */
    app.get(
      `${prefix}/ServiceProviderConfig`,
      scimAsyncHandler((req, res) => {
        this.scimJson(
          res,
          200,
          this.discovery.serviceProviderConfig(req as DmRequest)
        );
      })
    );
    app.get(
      `${prefix}/ResourceTypes`,
      scimAsyncHandler((req, res) => {
        const types = this.discovery.resourceTypes(req as DmRequest);
        this.scimJson(res, 200, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
          totalResults: types.length,
          Resources: types,
          startIndex: 1,
          itemsPerPage: types.length,
        });
      })
    );
    app.get(
      `${prefix}/ResourceTypes/:name`,
      scimAsyncHandler((req, res) => {
        const rt = this.discovery.resourceType(
          req.params.name as string,
          req as DmRequest
        );
        if (!rt) return writeScimError(res, 404, 'ResourceType not found');
        this.scimJson(res, 200, rt);
      })
    );
    app.get(
      `${prefix}/Schemas`,
      scimAsyncHandler((req, res) => {
        const schemas = this.discovery.schemas(req as DmRequest);
        this.scimJson(res, 200, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
          totalResults: schemas.length,
          Resources: schemas,
          startIndex: 1,
          itemsPerPage: schemas.length,
        });
      })
    );
    app.get(
      `${prefix}/Schemas/:id`,
      scimAsyncHandler((req, res) => {
        const s = this.discovery.schema(
          decodeURIComponent(req.params.id as string),
          req as DmRequest
        );
        if (!s) return writeScimError(res, 404, 'Schema not found');
        this.scimJson(res, 200, s);
      })
    );
  }

  private parseListQuery(req: Request): {
    filter?: string;
    startIndex?: number;
    count?: number;
    attributes?: string[];
    excludedAttributes?: string[];
    sortBy?: string;
    sortOrder?: 'ascending' | 'descending';
  } {
    const q = req.query;
    const toInt = (v: unknown): number | undefined => {
      if (typeof v !== 'string') return undefined;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    const toCsv = (v: unknown): string[] | undefined => {
      if (typeof v !== 'string') return undefined;
      return v
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    };
    const sortOrder = typeof q.sortOrder === 'string' ? q.sortOrder : undefined;
    return {
      filter: typeof q.filter === 'string' ? q.filter : undefined,
      startIndex: toInt(q.startIndex),
      count: toInt(q.count),
      attributes: toCsv(q.attributes),
      excludedAttributes: toCsv(q.excludedAttributes),
      sortBy: typeof q.sortBy === 'string' ? q.sortBy : undefined,
      sortOrder:
        sortOrder === 'ascending' || sortOrder === 'descending'
          ? sortOrder
          : undefined,
    };
  }

  getConfigApiData(): Record<string, unknown> {
    const prefix = this.scimPrefix;

    // Expose SCIM core schema files via the static plugin when loaded, so
    // clients can fetch them without going through the SCIM /Schemas endpoint.
    let schemaUrls: Record<string, string> | undefined;
    if (this.server.loadedPlugins['static']) {
      const staticName = (this.config.static_name as string) || 'static';
      schemaUrls = {
        user: `/${staticName}/schemas/scim/User.json`,
        group: `/${staticName}/schemas/scim/Group.json`,
        defaultMapping: `/${staticName}/schemas/scim/default-mapping.json`,
      };
    }

    // Report the active LDAP↔SCIM mapping so UI builders can render
    // attribute selectors / filter helpers without re-parsing the server config.
    const userMapping = this.users.userMapping;
    const groupMapping = this.groups.groupMapping;
    const filterableUserAttrs = userMapping.entries
      .map(e => e.scim)
      .concat(['id', 'active']);
    const filterableGroupAttrs = groupMapping.entries
      .map(e => e.scim)
      .concat(['id']);

    return {
      enabled: true,
      version: '2.0',
      prefix,
      endpoints: {
        users: `${prefix}/Users`,
        user: `${prefix}/Users/:id`,
        groups: `${prefix}/Groups`,
        group: `${prefix}/Groups/:id`,
        bulk: `${prefix}/Bulk`,
        serviceProviderConfig: `${prefix}/ServiceProviderConfig`,
        resourceTypes: `${prefix}/ResourceTypes`,
        schemas: `${prefix}/Schemas`,
      },
      schemaUrls,
      capabilities: {
        patch: true,
        bulk: true,
        filter: true,
        sort: true,
        etag: Boolean(this.config.scim_etag),
        changePassword: false,
        maxResults: (this.config.scim_max_results as number) || 200,
        bulkMaxOperations:
          (this.config.scim_bulk_max_operations as number) || 100,
        bulkMaxPayloadSize:
          (this.config.scim_bulk_max_payload_size as number) || 1048576,
      },
      resourceTypes: [
        {
          id: 'User',
          endpoint: `${prefix}/Users`,
          schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
          rdnAttribute:
            (this.config.scim_user_rdn_attribute as string) || 'uid',
          objectClass: this.config.scim_user_object_class as string[],
          filterableAttributes: filterableUserAttrs,
          mapping: userMapping.entries,
        },
        {
          id: 'Group',
          endpoint: `${prefix}/Groups`,
          schema: 'urn:ietf:params:scim:schemas:core:2.0:Group',
          rdnAttribute:
            (this.config.scim_group_rdn_attribute as string) || 'cn',
          objectClass: this.config.scim_group_object_class as string[],
          filterableAttributes: filterableGroupAttrs,
          mapping: groupMapping.entries,
        },
      ],
      idStrategy: (this.config.scim_id_attribute as string) || 'rdn',
      baseResolution: {
        userBaseTemplate:
          (this.config.scim_user_base_template as string) || undefined,
        groupBaseTemplate:
          (this.config.scim_group_base_template as string) || undefined,
        hasBaseMap: Boolean(this.config.scim_base_map),
        // `userBase` / `groupBase` are NOT exposed here because they may vary
        // per-request via req.user; clients should treat SCIM ids as opaque.
      },
    };
  }
}

export { writeScimErrorFromException };
