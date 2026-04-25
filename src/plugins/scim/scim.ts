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

/**
 * Reusable SCIM 2.0 schemas surfaced by this plugin.
 * Picked up by scripts/generate-openapi.ts and merged into `components.schemas`.
 *
 * @openapi-component
 * ScimUser:
 *   type: object
 *   description: |
 *     SCIM 2.0 User resource (RFC 7643 §4.1).
 *   required: [schemas, userName]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:schemas:core:2.0:User']
 *     id:
 *       type: string
 *       description: Opaque server-assigned identifier.
 *       example: 2819c223-7f76-453a-919d-413861904646
 *     externalId:
 *       type: string
 *       description: Provisioner-assigned identifier.
 *       example: 701984
 *     userName:
 *       type: string
 *       description: Unique user identifier (login name).
 *       example: bjensen
 *     name:
 *       type: object
 *       properties:
 *         formatted: { type: string, example: Ms. Barbara J Jensen III }
 *         familyName: { type: string, example: Jensen }
 *         givenName: { type: string, example: Barbara }
 *         middleName: { type: string, example: Jane }
 *         honorificPrefix: { type: string, example: Ms. }
 *         honorificSuffix: { type: string, example: III }
 *     displayName:
 *       type: string
 *       example: Babs Jensen
 *     nickName:
 *       type: string
 *       example: Babs
 *     profileUrl:
 *       type: string
 *       example: https://login.example.com/bjensen
 *     title:
 *       type: string
 *       example: Tour Guide
 *     userType:
 *       type: string
 *       example: Employee
 *     preferredLanguage:
 *       type: string
 *       example: en-US
 *     locale:
 *       type: string
 *       example: en-US
 *     timezone:
 *       type: string
 *       example: America/Los_Angeles
 *     active:
 *       type: boolean
 *       example: true
 *     emails:
 *       type: array
 *       items:
 *         type: object
 *         properties:
 *           value: { type: string }
 *           display: { type: string }
 *           type: { type: string }
 *           primary: { type: boolean }
 *       example:
 *         - value: bjensen@example.com
 *           type: work
 *           primary: true
 *     phoneNumbers:
 *       type: array
 *       items:
 *         type: object
 *         properties:
 *           value: { type: string }
 *           type: { type: string }
 *           primary: { type: boolean }
 *     addresses:
 *       type: array
 *       items:
 *         type: object
 *         properties:
 *           streetAddress: { type: string }
 *           locality: { type: string }
 *           region: { type: string }
 *           postalCode: { type: string }
 *           country: { type: string }
 *           type: { type: string }
 *           primary: { type: boolean }
 *     groups:
 *       type: array
 *       description: Groups the user belongs to (read-only).
 *       items:
 *         type: object
 *         properties:
 *           value: { type: string }
 *           $ref: { type: string }
 *           display: { type: string }
 *     meta:
 *       type: object
 *       properties:
 *         resourceType: { type: string, example: User }
 *         created: { type: string, format: date-time }
 *         lastModified: { type: string, format: date-time }
 *         location: { type: string }
 *         version: { type: string }
 * ScimGroup:
 *   type: object
 *   description: |
 *     SCIM 2.0 Group resource (RFC 7643 §4.2).
 *   required: [schemas, displayName]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:schemas:core:2.0:Group']
 *     id:
 *       type: string
 *       description: Opaque server-assigned identifier.
 *       example: e9e30dba-f08f-4109-8486-d5c6a331660a
 *     externalId:
 *       type: string
 *       example: 00g1emaKYZTWRINFRGETl
 *     displayName:
 *       type: string
 *       example: Tour Guides
 *     members:
 *       type: array
 *       description: Members of the group.
 *       items:
 *         type: object
 *         properties:
 *           value: { type: string, description: User or Group id }
 *           $ref: { type: string }
 *           display: { type: string }
 *       example:
 *         - value: 2819c223-7f76-453a-919d-413861904646
 *           display: Babs Jensen
 *         - value: 902c246b-6245-4190-8e05-00816be7344a
 *           display: Mandy Pepperidge
 *     meta:
 *       type: object
 *       properties:
 *         resourceType: { type: string, example: Group }
 *         created: { type: string, format: date-time }
 *         lastModified: { type: string, format: date-time }
 *         location: { type: string }
 *         version: { type: string }
 * ScimListResponse:
 *   type: object
 *   description: |
 *     SCIM 2.0 list query response (urn:ietf:params:scim:api:messages:2.0:ListResponse).
 *   required: [schemas, totalResults, Resources]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:api:messages:2.0:ListResponse']
 *     totalResults:
 *       type: integer
 *       description: Total number of matching resources.
 *       example: 2
 *     startIndex:
 *       type: integer
 *       description: 1-based index of the first result returned.
 *       example: 1
 *     itemsPerPage:
 *       type: integer
 *       description: Number of resources returned in this page.
 *       example: 2
 *     Resources:
 *       type: array
 *       items: {}
 *       description: The matching resources.
 * ScimError:
 *   type: object
 *   description: |
 *     SCIM 2.0 error response (urn:ietf:params:scim:api:messages:2.0:Error).
 *   required: [schemas, status]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:api:messages:2.0:Error']
 *     status:
 *       type: string
 *       description: HTTP status code as a string.
 *       example: '404'
 *     scimType:
 *       type: string
 *       description: |
 *         SCIM error type keyword (RFC 7644 §3.12). One of: invalidFilter,
 *         tooMany, uniqueness, mutability, invalidSyntax, invalidPath,
 *         noTarget, invalidValue, invalidVers, sensitive.
 *       example: mutability
 *     detail:
 *       type: string
 *       description: Human-readable error description.
 *       example: Resource 2819c223-7f76-453a-919d-413861904646 not found.
 *   example:
 *     schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
 *     status: '404'
 *     detail: Resource 2819c223-7f76-453a-919d-413861904646 not found.
 * ScimPatchOp:
 *   type: object
 *   description: |
 *     SCIM 2.0 patch request body (urn:ietf:params:scim:api:messages:2.0:PatchOp,
 *     RFC 7644 §3.5.2).
 *   required: [schemas, Operations]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:api:messages:2.0:PatchOp']
 *     Operations:
 *       type: array
 *       items:
 *         type: object
 *         required: [op]
 *         properties:
 *           op:
 *             type: string
 *             enum: [add, remove, replace, Add, Remove, Replace]
 *           path:
 *             type: string
 *             description: SCIM attribute path (e.g. "emails[type eq \"work\"].value").
 *           value:
 *             description: New value for the target attribute.
 *   example:
 *     schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp']
 *     Operations:
 *       - op: replace
 *         path: active
 *         value: false
 *       - op: replace
 *         path: emails[type eq "work"].value
 *         value: bjensen@newdomain.example.com
 * ScimBulkRequest:
 *   type: object
 *   description: |
 *     SCIM 2.0 Bulk request (urn:ietf:params:scim:api:messages:2.0:BulkRequest,
 *     RFC 7644 §3.7).
 *   required: [schemas, Operations]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest']
 *     failOnErrors:
 *       type: integer
 *       description: |
 *         Stop processing after this many errors. Omit or set to 0 to
 *         continue on errors and process all operations.
 *       example: 1
 *     Operations:
 *       type: array
 *       items:
 *         type: object
 *         required: [method, path]
 *         properties:
 *           method:
 *             type: string
 *             enum: [POST, PUT, PATCH, DELETE]
 *           bulkId:
 *             type: string
 *             description: |
 *               Temporary client-assigned identifier for this operation.
 *               Subsequent operations in the same request may reference the
 *               created resource as "bulkId:<value>".
 *           path:
 *             type: string
 *             description: Resource path relative to the SCIM prefix (e.g. /Users or /Groups/123).
 *           data:
 *             description: Request body for POST/PUT/PATCH operations.
 *   example:
 *     schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest']
 *     failOnErrors: 1
 *     Operations:
 *       - method: POST
 *         bulkId: qwerty
 *         path: /Users
 *         data:
 *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
 *           userName: bjensen
 *           name:
 *             familyName: Jensen
 *             givenName: Barbara
 *       - method: DELETE
 *         path: /Users/2819c223-7f76-453a-919d-413861904646
 * ScimBulkResponse:
 *   type: object
 *   description: |
 *     SCIM 2.0 Bulk response (urn:ietf:params:scim:api:messages:2.0:BulkResponse).
 *   required: [schemas, Operations]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:api:messages:2.0:BulkResponse']
 *     Operations:
 *       type: array
 *       items:
 *         type: object
 *         required: [method, status]
 *         properties:
 *           method:
 *             type: string
 *             enum: [POST, PUT, PATCH, DELETE]
 *           bulkId:
 *             type: string
 *           location:
 *             type: string
 *             description: URL of the created/modified resource.
 *           version:
 *             type: string
 *           status:
 *             type: string
 *             description: HTTP status code for this individual operation.
 *           response:
 *             $ref: '#/components/schemas/ScimError'
 *             description: Present only when the operation failed.
 *   example:
 *     schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkResponse']
 *     Operations:
 *       - method: POST
 *         bulkId: qwerty
 *         location: https://example.com/scim/v2/Users/2819c223-7f76-453a-919d-413861904646
 *         status: '201'
 *       - method: DELETE
 *         status: '204'
 * ScimResourceType:
 *   type: object
 *   description: SCIM 2.0 ResourceType definition (RFC 7643 §6).
 *   required: [schemas, id, name, endpoint, schema]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType']
 *     id: { type: string, example: User }
 *     name: { type: string, example: User }
 *     endpoint: { type: string, example: /Users }
 *     description: { type: string, example: User Account }
 *     schema:
 *       type: string
 *       example: urn:ietf:params:scim:schemas:core:2.0:User
 *     schemaExtensions:
 *       type: array
 *       items:
 *         type: object
 *         properties:
 *           schema: { type: string }
 *           required: { type: boolean }
 *     meta:
 *       type: object
 *       properties:
 *         resourceType: { type: string, example: ResourceType }
 *         location: { type: string }
 * ScimSchema:
 *   type: object
 *   description: SCIM 2.0 Schema definition (RFC 7643 §7).
 *   required: [schemas, id, name, attributes]
 *   properties:
 *     schemas:
 *       type: array
 *       items: { type: string }
 *       example: ['urn:ietf:params:scim:schemas:core:2.0:Schema']
 *     id:
 *       type: string
 *       example: urn:ietf:params:scim:schemas:core:2.0:User
 *     name: { type: string, example: User }
 *     description: { type: string, example: User Account }
 *     attributes:
 *       type: array
 *       items: {}
 *       description: Schema attribute definitions.
 *     meta:
 *       type: object
 *       properties:
 *         resourceType: { type: string, example: Schema }
 *         location: { type: string }
 */
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
    /**
     * @openapi
     * summary: List users
     * description: |
     *   Returns a paginated list of SCIM User resources matching the optional
     *   filter. Pagination is controlled by `startIndex` (1-based) and `count`.
     *   The response always uses the `ListResponse` envelope.
     * parameters:
     *   - in: query
     *     name: filter
     *     schema: { type: string }
     *     description: |
     *       SCIM filter expression (RFC 7644 §3.4.2.2), e.g.
     *       `userName eq "bjensen"` or `emails.value co "@example.com"`.
     *     example: 'userName eq "bjensen"'
     *   - in: query
     *     name: startIndex
     *     schema: { type: integer, default: 1 }
     *     description: 1-based index of the first result to return.
     *     example: 1
     *   - in: query
     *     name: count
     *     schema: { type: integer }
     *     description: Maximum number of results to return per page.
     *     example: 10
     *   - in: query
     *     name: attributes
     *     schema: { type: string }
     *     description: Comma-separated SCIM attribute names to include in the response.
     *     example: 'userName,emails'
     *   - in: query
     *     name: excludedAttributes
     *     schema: { type: string }
     *     description: Comma-separated SCIM attribute names to exclude from the response.
     *     example: 'password,x509Certificates'
     *   - in: query
     *     name: sortBy
     *     schema: { type: string }
     *     description: Attribute to sort results by (parsed but sort not guaranteed server-side).
     *   - in: query
     *     name: sortOrder
     *     schema: { type: string, enum: [ascending, descending] }
     *     description: Sort direction.
     * responses:
     *   '200':
     *     description: User list.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimListResponse' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse']
     *           totalResults: 2
     *           startIndex: 1
     *           itemsPerPage: 2
     *           Resources:
     *             - schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *               id: 2819c223-7f76-453a-919d-413861904646
     *               userName: bjensen
     *               displayName: Babs Jensen
     *               active: true
     *               emails:
     *                 - value: bjensen@example.com
     *                   type: work
     *                   primary: true
     *             - schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *               id: c75ad752-64ae-4823-840d-ffa80929976c
     *               userName: jsmith
     *               displayName: John Smith
     *               active: true
     *   '400':
     *     description: Invalid filter expression.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '400'
     *           scimType: invalidFilter
     *           detail: 'Filter parse error: unexpected token near "eq"'
     */
    app.get(
      `${prefix}/Users`,
      scimAsyncHandler(async (req, res) => {
        const q = this.parseListQuery(req);
        const list = await this.users.list(req as DmRequest, q);
        this.scimJson(res, 200, list);
      })
    );
    /**
     * @openapi
     * summary: Get user by ID
     * description: |
     *   Returns a single SCIM User resource. The `:id` value is the server-
     *   assigned opaque identifier returned when the resource was created.
     * responses:
     *   '200':
     *     description: User resource.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimUser' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *           id: 2819c223-7f76-453a-919d-413861904646
     *           externalId: '701984'
     *           userName: bjensen
     *           name:
     *             formatted: Ms. Barbara J Jensen III
     *             familyName: Jensen
     *             givenName: Barbara
     *             honorificPrefix: Ms.
     *             honorificSuffix: III
     *           displayName: Babs Jensen
     *           active: true
     *           emails:
     *             - value: bjensen@example.com
     *               type: work
     *               primary: true
     *           meta:
     *             resourceType: User
     *             created: '2024-01-10T09:00:00Z'
     *             lastModified: '2024-01-15T12:30:00Z'
     *             location: 'https://example.com/scim/v2/Users/2819c223-7f76-453a-919d-413861904646'
     *   '404':
     *     description: User not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '404'
     *           detail: Resource 2819c223-7f76-453a-919d-413861904646 not found.
     */
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
    /**
     * @openapi
     * summary: Create user
     * description: |
     *   Creates a new SCIM User resource. The `userName` attribute is required.
     *   Returns the created resource with status 201 and a `Location` header.
     * requestBody:
     *   required: true
     *   content:
     *     application/scim+json:
     *       schema: { $ref: '#/components/schemas/ScimUser' }
     *       example:
     *         schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *         userName: bjensen
     *         externalId: '701984'
     *         name:
     *           familyName: Jensen
     *           givenName: Barbara
     *         displayName: Babs Jensen
     *         emails:
     *           - value: bjensen@example.com
     *             type: work
     *             primary: true
     *         active: true
     * responses:
     *   '201':
     *     description: User created.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimUser' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *           id: 2819c223-7f76-453a-919d-413861904646
     *           userName: bjensen
     *           displayName: Babs Jensen
     *           active: true
     *           meta:
     *             resourceType: User
     *             created: '2024-01-10T09:00:00Z'
     *             location: 'https://example.com/scim/v2/Users/2819c223-7f76-453a-919d-413861904646'
     *   '400':
     *     description: Request body is missing or malformed.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '400'
     *           scimType: invalidSyntax
     *           detail: 'Missing body'
     *   '409':
     *     description: A user with that userName already exists.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '409'
     *           scimType: uniqueness
     *           detail: 'User bjensen already exists'
     */
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
    /**
     * @openapi
     * summary: Replace user
     * description: |
     *   Replaces all attributes of an existing SCIM User resource with the
     *   values in the request body (full replacement, RFC 7644 §3.5.1).
     *   Any attributes omitted from the body are cleared on the server.
     * requestBody:
     *   required: true
     *   content:
     *     application/scim+json:
     *       schema: { $ref: '#/components/schemas/ScimUser' }
     *       example:
     *         schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *         id: 2819c223-7f76-453a-919d-413861904646
     *         userName: bjensen
     *         name:
     *           familyName: Jensen
     *           givenName: Barbara
     *         displayName: Babs Jensen
     *         emails:
     *           - value: bjensen@newdomain.example.com
     *             type: work
     *             primary: true
     *         active: true
     * responses:
     *   '200':
     *     description: User replaced.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimUser' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *           id: 2819c223-7f76-453a-919d-413861904646
     *           userName: bjensen
     *           displayName: Babs Jensen
     *           active: true
     *   '400':
     *     description: Request body is missing or malformed.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *   '404':
     *     description: User not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '404'
     *           detail: Resource 2819c223-7f76-453a-919d-413861904646 not found.
     */
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
    /**
     * @openapi
     * summary: Patch user
     * description: |
     *   Applies a partial update to a SCIM User resource using PatchOp
     *   (RFC 7644 §3.5.2). Supported operations: `add`, `remove`, `replace`.
     *   The `path` attribute uses SCIM attribute notation including filter
     *   expressions (e.g. `emails[type eq "work"].value`).
     * requestBody:
     *   required: true
     *   content:
     *     application/scim+json:
     *       schema: { $ref: '#/components/schemas/ScimPatchOp' }
     *       example:
     *         schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp']
     *         Operations:
     *           - op: replace
     *             path: active
     *             value: false
     *           - op: replace
     *             path: 'emails[type eq "work"].value'
     *             value: bjensen@newdomain.example.com
     * responses:
     *   '200':
     *     description: User patched.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimUser' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *           id: 2819c223-7f76-453a-919d-413861904646
     *           userName: bjensen
     *           active: false
     *   '400':
     *     description: Request body is missing or malformed.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *   '404':
     *     description: User not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     */
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
    /**
     * @openapi
     * summary: Delete user
     * description: |
     *   Permanently removes a SCIM User resource. Returns 204 No Content on
     *   success; the response body is empty.
     * responses:
     *   '204':
     *     description: User deleted.
     *   '404':
     *     description: User not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '404'
     *           detail: Resource 2819c223-7f76-453a-919d-413861904646 not found.
     */
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
    /**
     * @openapi
     * summary: List groups
     * description: |
     *   Returns a paginated list of SCIM Group resources matching the optional
     *   filter. Pagination is controlled by `startIndex` (1-based) and `count`.
     * parameters:
     *   - in: query
     *     name: filter
     *     schema: { type: string }
     *     description: |
     *       SCIM filter expression (RFC 7644 §3.4.2.2), e.g.
     *       `displayName eq "Tour Guides"`.
     *     example: 'displayName eq "Tour Guides"'
     *   - in: query
     *     name: startIndex
     *     schema: { type: integer, default: 1 }
     *     description: 1-based index of the first result to return.
     *     example: 1
     *   - in: query
     *     name: count
     *     schema: { type: integer }
     *     description: Maximum number of results to return per page.
     *     example: 10
     *   - in: query
     *     name: attributes
     *     schema: { type: string }
     *     description: Comma-separated SCIM attribute names to include.
     *     example: 'displayName,members'
     *   - in: query
     *     name: excludedAttributes
     *     schema: { type: string }
     *     description: Comma-separated SCIM attribute names to exclude.
     *   - in: query
     *     name: sortBy
     *     schema: { type: string }
     *     description: Attribute to sort by (parsed but not guaranteed server-side).
     *   - in: query
     *     name: sortOrder
     *     schema: { type: string, enum: [ascending, descending] }
     * responses:
     *   '200':
     *     description: Group list.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimListResponse' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse']
     *           totalResults: 2
     *           startIndex: 1
     *           itemsPerPage: 2
     *           Resources:
     *             - schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group']
     *               id: e9e30dba-f08f-4109-8486-d5c6a331660a
     *               displayName: Tour Guides
     *               members:
     *                 - value: 2819c223-7f76-453a-919d-413861904646
     *                   display: Babs Jensen
     *             - schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group']
     *               id: fc348aa8-3835-40eb-a20b-c726e15c55b5
     *               displayName: Employees
     *               members: []
     *   '400':
     *     description: Invalid filter expression.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     */
    app.get(
      `${prefix}/Groups`,
      scimAsyncHandler(async (req, res) => {
        const q = this.parseListQuery(req);
        const list = await this.groups.list(req as DmRequest, q);
        this.scimJson(res, 200, list);
      })
    );
    /**
     * @openapi
     * summary: Get group by ID
     * description: Returns a single SCIM Group resource by its server-assigned ID.
     * responses:
     *   '200':
     *     description: Group resource.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimGroup' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group']
     *           id: e9e30dba-f08f-4109-8486-d5c6a331660a
     *           displayName: Tour Guides
     *           members:
     *             - value: 2819c223-7f76-453a-919d-413861904646
     *               display: Babs Jensen
     *             - value: 902c246b-6245-4190-8e05-00816be7344a
     *               display: Mandy Pepperidge
     *           meta:
     *             resourceType: Group
     *             created: '2024-01-10T09:00:00Z'
     *             lastModified: '2024-01-15T12:30:00Z'
     *             location: 'https://example.com/scim/v2/Groups/e9e30dba-f08f-4109-8486-d5c6a331660a'
     *   '404':
     *     description: Group not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '404'
     *           detail: Resource e9e30dba-f08f-4109-8486-d5c6a331660a not found.
     */
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
    /**
     * @openapi
     * summary: Create group
     * description: |
     *   Creates a new SCIM Group resource. The `displayName` attribute is
     *   required. Returns the created resource with status 201 and a
     *   `Location` header.
     * requestBody:
     *   required: true
     *   content:
     *     application/scim+json:
     *       schema: { $ref: '#/components/schemas/ScimGroup' }
     *       example:
     *         schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group']
     *         displayName: Tour Guides
     *         members:
     *           - value: 2819c223-7f76-453a-919d-413861904646
     *             display: Babs Jensen
     * responses:
     *   '201':
     *     description: Group created.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimGroup' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group']
     *           id: e9e30dba-f08f-4109-8486-d5c6a331660a
     *           displayName: Tour Guides
     *           members:
     *             - value: 2819c223-7f76-453a-919d-413861904646
     *               display: Babs Jensen
     *           meta:
     *             resourceType: Group
     *             created: '2024-01-10T09:00:00Z'
     *             location: 'https://example.com/scim/v2/Groups/e9e30dba-f08f-4109-8486-d5c6a331660a'
     *   '400':
     *     description: Request body is missing or malformed.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *   '409':
     *     description: A group with that displayName already exists.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '409'
     *           scimType: uniqueness
     *           detail: 'Group Tour Guides already exists'
     */
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
    /**
     * @openapi
     * summary: Replace group
     * description: |
     *   Replaces all attributes of an existing SCIM Group resource with the
     *   values in the request body (full replacement, RFC 7644 §3.5.1).
     * requestBody:
     *   required: true
     *   content:
     *     application/scim+json:
     *       schema: { $ref: '#/components/schemas/ScimGroup' }
     *       example:
     *         schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group']
     *         id: e9e30dba-f08f-4109-8486-d5c6a331660a
     *         displayName: Tour Guides
     *         members:
     *           - value: 2819c223-7f76-453a-919d-413861904646
     *             display: Babs Jensen
     *           - value: 902c246b-6245-4190-8e05-00816be7344a
     *             display: Mandy Pepperidge
     * responses:
     *   '200':
     *     description: Group replaced.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimGroup' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group']
     *           id: e9e30dba-f08f-4109-8486-d5c6a331660a
     *           displayName: Tour Guides
     *           members:
     *             - value: 2819c223-7f76-453a-919d-413861904646
     *               display: Babs Jensen
     *   '400':
     *     description: Request body is missing or malformed.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *   '404':
     *     description: Group not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     */
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
    /**
     * @openapi
     * summary: Patch group
     * description: |
     *   Applies a partial update to a SCIM Group resource using PatchOp
     *   (RFC 7644 §3.5.2). Typical use-cases: adding or removing members,
     *   renaming the group.
     * requestBody:
     *   required: true
     *   content:
     *     application/scim+json:
     *       schema: { $ref: '#/components/schemas/ScimPatchOp' }
     *       example:
     *         schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp']
     *         Operations:
     *           - op: add
     *             path: members
     *             value:
     *               - value: 2819c223-7f76-453a-919d-413861904646
     *                 display: Babs Jensen
     *           - op: remove
     *             path: 'members[value eq "902c246b-6245-4190-8e05-00816be7344a"]'
     * responses:
     *   '200':
     *     description: Group patched.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimGroup' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group']
     *           id: e9e30dba-f08f-4109-8486-d5c6a331660a
     *           displayName: Tour Guides
     *           members:
     *             - value: 2819c223-7f76-453a-919d-413861904646
     *               display: Babs Jensen
     *   '400':
     *     description: Request body is missing or malformed.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *   '404':
     *     description: Group not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     */
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
    /**
     * @openapi
     * summary: Delete group
     * description: |
     *   Permanently removes a SCIM Group resource. Returns 204 No Content on
     *   success; the response body is empty.
     * responses:
     *   '204':
     *     description: Group deleted.
     *   '404':
     *     description: Group not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '404'
     *           detail: Resource e9e30dba-f08f-4109-8486-d5c6a331660a not found.
     */
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
    /**
     * @openapi
     * summary: Execute bulk operations
     * description: |
     *   Executes multiple SCIM operations in a single HTTP request (RFC 7644
     *   §3.7). Operations are processed sequentially. Supports `bulkId`
     *   cross-references: a POST operation with `"bulkId":"abc"` creates a
     *   resource; subsequent operations in the same request can reference it
     *   as `"bulkId:abc"` wherever a SCIM id is expected.
     *
     *   The `failOnErrors` field controls how many errors to tolerate before
     *   aborting. Set to 0 (default) to process all operations regardless of
     *   individual errors.
     *
     *   Maximum payload size and operation count are configurable server-side
     *   (defaults: 1 MiB / 100 operations). Exceeding either returns 413.
     * requestBody:
     *   required: true
     *   content:
     *     application/scim+json:
     *       schema: { $ref: '#/components/schemas/ScimBulkRequest' }
     *       example:
     *         schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest']
     *         failOnErrors: 1
     *         Operations:
     *           - method: POST
     *             bulkId: qwerty
     *             path: /Users
     *             data:
     *               schemas: ['urn:ietf:params:scim:schemas:core:2.0:User']
     *               userName: bjensen
     *               name:
     *                 familyName: Jensen
     *                 givenName: Barbara
     *           - method: DELETE
     *             path: /Users/2819c223-7f76-453a-919d-413861904646
     * responses:
     *   '200':
     *     description: Bulk operations completed (may include per-operation errors).
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimBulkResponse' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkResponse']
     *           Operations:
     *             - method: POST
     *               bulkId: qwerty
     *               location: 'https://example.com/scim/v2/Users/2819c223-7f76-453a-919d-413861904646'
     *               status: '201'
     *             - method: DELETE
     *               status: '204'
     *   '400':
     *     description: Request body is missing, malformed, or exceeds operation count limit.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *   '413':
     *     description: Payload exceeds maximum allowed size.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '413'
     *           scimType: invalidValue
     *           detail: 'Bulk payload too large: 2097152 > 1048576'
     */
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
    /**
     * @openapi
     * summary: Get service provider configuration
     * description: |
     *   Returns the SCIM 2.0 ServiceProviderConfig document (RFC 7643 §5).
     *   Describes which optional features this server supports: PATCH, Bulk,
     *   filtering, sorting, ETags, and the active authentication schemes.
     *   No authentication is required for this endpoint.
     * responses:
     *   '200':
     *     description: Service provider configuration.
     *     content:
     *       application/scim+json:
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig']
     *           patch: { supported: true }
     *           bulk:
     *             supported: true
     *             maxOperations: 100
     *             maxPayloadSize: 1048576
     *           filter: { supported: true, maxResults: 200 }
     *           changePassword: { supported: false }
     *           sort: { supported: false }
     *           etag: { supported: false }
     *           authenticationSchemes:
     *             - name: OAuth Bearer Token
     *               description: 'Bearer token. Send "Authorization: Bearer <token>".'
     *               type: oauthbearertoken
     *               primary: true
     *           meta:
     *             resourceType: ServiceProviderConfig
     *             location: 'https://example.com/scim/v2/ServiceProviderConfig'
     */
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
    /**
     * @openapi
     * summary: List resource types
     * description: |
     *   Returns all registered SCIM ResourceType definitions wrapped in a
     *   ListResponse envelope (RFC 7643 §6). This server exposes `User` and
     *   `Group` resource types.
     * responses:
     *   '200':
     *     description: Resource types list.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimListResponse' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse']
     *           totalResults: 2
     *           startIndex: 1
     *           itemsPerPage: 2
     *           Resources:
     *             - schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType']
     *               id: User
     *               name: User
     *               endpoint: /Users
     *               description: User Account
     *               schema: urn:ietf:params:scim:schemas:core:2.0:User
     *               meta:
     *                 resourceType: ResourceType
     *                 location: 'https://example.com/scim/v2/ResourceTypes/User'
     *             - schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType']
     *               id: Group
     *               name: Group
     *               endpoint: /Groups
     *               description: Group
     *               schema: urn:ietf:params:scim:schemas:core:2.0:Group
     *               meta:
     *                 resourceType: ResourceType
     *                 location: 'https://example.com/scim/v2/ResourceTypes/Group'
     */
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
    /**
     * @openapi
     * summary: Get resource type by name
     * description: |
     *   Returns a single SCIM ResourceType definition by its `id` (name).
     *   Supported values: `User`, `Group`.
     * responses:
     *   '200':
     *     description: Resource type definition.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimResourceType' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType']
     *           id: User
     *           name: User
     *           endpoint: /Users
     *           description: User Account
     *           schema: urn:ietf:params:scim:schemas:core:2.0:User
     *           meta:
     *             resourceType: ResourceType
     *             location: 'https://example.com/scim/v2/ResourceTypes/User'
     *   '404':
     *     description: ResourceType not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '404'
     *           detail: ResourceType not found
     */
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
    /**
     * @openapi
     * summary: List schemas
     * description: |
     *   Returns all SCIM Schema definitions wrapped in a ListResponse envelope
     *   (RFC 7643 §7). Schemas describe the attributes available on User and
     *   Group resources. Schema files are loaded from the server's configured
     *   `schemas_path` (defaults to `static/schemas/scim/`).
     * responses:
     *   '200':
     *     description: Schema list.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimListResponse' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse']
     *           totalResults: 2
     *           startIndex: 1
     *           itemsPerPage: 2
     *           Resources:
     *             - schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema']
     *               id: urn:ietf:params:scim:schemas:core:2.0:User
     *               name: User
     *               description: User Account
     *               attributes: []
     *               meta:
     *                 resourceType: Schema
     *                 location: 'https://example.com/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User'
     *             - schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema']
     *               id: urn:ietf:params:scim:schemas:core:2.0:Group
     *               name: Group
     *               description: Group
     *               attributes: []
     *               meta:
     *                 resourceType: Schema
     *                 location: 'https://example.com/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group'
     */
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
    /**
     * @openapi
     * summary: Get schema by ID
     * description: |
     *   Returns a single SCIM Schema definition by its URN identifier.
     *   The `:id` segment must be URL-encoded (the generator extracts it as
     *   a path parameter automatically). Example URNs:
     *   - `urn:ietf:params:scim:schemas:core:2.0:User`
     *   - `urn:ietf:params:scim:schemas:core:2.0:Group`
     * responses:
     *   '200':
     *     description: Schema definition.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimSchema' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema']
     *           id: urn:ietf:params:scim:schemas:core:2.0:User
     *           name: User
     *           description: User Account
     *           attributes:
     *             - name: userName
     *               type: string
     *               multiValued: false
     *               required: true
     *               caseExact: false
     *               mutability: readWrite
     *               returned: default
     *               uniqueness: server
     *           meta:
     *             resourceType: Schema
     *             location: 'https://example.com/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User'
     *   '404':
     *     description: Schema not found.
     *     content:
     *       application/scim+json:
     *         schema: { $ref: '#/components/schemas/ScimError' }
     *         example:
     *           schemas: ['urn:ietf:params:scim:api:messages:2.0:Error']
     *           status: '404'
     *           detail: Schema not found
     */
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
