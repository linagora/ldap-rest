/**
 * @module plugins/scim/bulk
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM 2.0 Bulk operations (RFC 7644 §3.7).
 *
 * Executes operations sequentially. Supports `bulkId` cross-references:
 * a POST with `"bulkId":"abc"` creates a resource; subsequent operations
 * in the same request can reference it as "bulkId:abc" anywhere a SCIM
 * id or member.value is expected (resolved to the concrete id before
 * dispatch).
 */
import type winston from 'winston';

import type { Config } from '../../config/args';
import type { DmRequest } from '../../lib/auth/base';
import { launchHooks } from '../../lib/utils';

import type { ScimUsers } from './users';
import type { ScimGroups } from './groups';
import {
  type BulkRequest,
  type BulkResponse,
  type BulkOperationRequest,
  type BulkOperationResponse,
  type ScimUser,
  type ScimGroup,
  type PatchRequest,
  SCHEMA_BULK_RESPONSE,
} from './types';
import {
  scimInvalidValue,
  writeScimErrorFromException,
  ScimError,
} from './errors';

export interface ScimBulkOptions {
  config: Config;
  logger: winston.Logger;
  users: ScimUsers;
  groups: ScimGroups;
  scimPrefix: string;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  hooks: { [K: string]: Function[] | undefined };
}

const BULK_REF_RE = /^bulkId:([A-Za-z0-9_-]+)$/;

export class ScimBulk {
  private readonly config: Config;
  private readonly logger: winston.Logger;
  private readonly users: ScimUsers;
  private readonly groups: ScimGroups;
  private readonly scimPrefix: string;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private readonly hooks: { [K: string]: Function[] | undefined };

  constructor(opts: ScimBulkOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.users = opts.users;
    this.groups = opts.groups;
    this.scimPrefix = opts.scimPrefix;
    this.hooks = opts.hooks;
  }

  async execute(req: DmRequest, body: BulkRequest): Promise<BulkResponse> {
    const maxOps = (this.config.scim_bulk_max_operations as number) || 100;
    if (!body.Operations || !Array.isArray(body.Operations)) {
      throw scimInvalidValue('Missing Operations array');
    }
    if (body.Operations.length > maxOps) {
      throw scimInvalidValue(
        `Too many operations: ${body.Operations.length} (max ${maxOps})`
      );
    }

    const refs = new Map<string, { id: string; type: 'User' | 'Group' }>();
    const responses: BulkOperationResponse[] = [];
    let errorCount = 0;
    const failOnErrors = body.failOnErrors ?? 0;

    for (const op of body.Operations) {
      if (failOnErrors > 0 && errorCount >= failOnErrors) {
        break;
      }
      const response = await this.executeOne(req, op, refs);
      responses.push(response);
      if (parseInt(response.status, 10) >= 400) errorCount++;
    }

    const bulkResp: BulkResponse = {
      schemas: [SCHEMA_BULK_RESPONSE],
      Operations: responses,
    };
    void launchHooks(this.hooks.scimbulkdone, bulkResp);
    return bulkResp;
  }

  private async executeOne(
    req: DmRequest,
    op: BulkOperationRequest,
    refs: Map<string, { id: string; type: 'User' | 'Group' }>
  ): Promise<BulkOperationResponse> {
    const base: BulkOperationResponse = {
      method: op.method,
      bulkId: op.bulkId,
      status: '200',
    };
    try {
      if (!op.method || !op.path) {
        throw scimInvalidValue('method and path are required');
      }
      // Resolve bulkId references inside data
      if (op.data && typeof op.data === 'object') {
        this.resolveRefs(op.data as Record<string, unknown>, refs);
      }

      const pathParts = op.path.replace(/^\//, '').split('/');
      const resource = pathParts[0];
      const maybeId = pathParts[1];
      if (resource !== 'Users' && resource !== 'Groups') {
        throw scimInvalidValue(`Unsupported bulk path '${op.path}'`);
      }
      const isUser = resource === 'Users';

      // Resolve ID from bulkId if provided
      let targetId = maybeId;
      if (targetId && BULK_REF_RE.test(targetId)) {
        const m = BULK_REF_RE.exec(targetId)!;
        const ref = refs.get(m[1]);
        if (!ref) throw scimInvalidValue(`Unknown bulkId reference '${m[1]}'`);
        targetId = ref.id;
      }

      switch (op.method) {
        case 'POST': {
          if (targetId) throw scimInvalidValue('POST must not include an id');
          const created = isUser
            ? await this.users.create(req, op.data as ScimUser)
            : await this.groups.create(req, op.data as ScimGroup);
          base.status = '201';
          base.location = this.buildLocation(resource, created.id!, req);
          base.version = (created.meta?.version as string) || undefined;
          if (op.bulkId) {
            refs.set(op.bulkId, {
              id: created.id!,
              type: isUser ? 'User' : 'Group',
            });
          }
          return base;
        }
        case 'PUT': {
          if (!targetId) throw scimInvalidValue('PUT requires an id');
          const replaced = isUser
            ? await this.users.replace(req, targetId, op.data as ScimUser)
            : await this.groups.replace(req, targetId, op.data as ScimGroup);
          base.status = '200';
          base.location = this.buildLocation(resource, replaced.id!, req);
          return base;
        }
        case 'PATCH': {
          if (!targetId) throw scimInvalidValue('PATCH requires an id');
          const patched = isUser
            ? await this.users.patch(req, targetId, op.data as PatchRequest)
            : await this.groups.patch(req, targetId, op.data as PatchRequest);
          base.status = '200';
          base.location = this.buildLocation(resource, patched.id!, req);
          return base;
        }
        case 'DELETE': {
          if (!targetId) throw scimInvalidValue('DELETE requires an id');
          if (isUser) {
            await this.users.delete(req, targetId);
          } else {
            await this.groups.delete(req, targetId);
          }
          base.status = '204';
          return base;
        }
        default:
          throw scimInvalidValue(
            `Unsupported method '${String(op.method as unknown)}'`
          );
      }
    } catch (err) {
      const status = err instanceof ScimError ? err.statusCode : 500;
      base.status = String(status);
      base.response = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: String(status),
        ...(err instanceof ScimError && err.scimType
          ? { scimType: err.scimType }
          : {}),
        detail: err instanceof Error ? err.message : String(err),
      };
      return base;
    }
  }

  private resolveRefs(
    obj: Record<string, unknown>,
    refs: Map<string, { id: string; type: 'User' | 'Group' }>
  ): void {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        const m = BULK_REF_RE.exec(v);
        if (m) {
          const ref = refs.get(m[1]);
          if (ref) obj[k] = ref.id;
        }
        continue;
      }
      if (Array.isArray(v)) {
        const arr = v as unknown[];
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          if (typeof item === 'string') {
            const m = BULK_REF_RE.exec(item);
            if (m) {
              const ref = refs.get(m[1]);
              if (ref) arr[i] = ref.id;
            }
          } else if (item && typeof item === 'object') {
            this.resolveRefs(item as Record<string, unknown>, refs);
          }
        }
        continue;
      }
      if (v && typeof v === 'object') {
        this.resolveRefs(v as Record<string, unknown>, refs);
      }
    }
  }

  private buildLocation(
    resource: 'Users' | 'Groups',
    id: string,
    req?: DmRequest
  ): string {
    const fromConfig = (this.config.scim_base_url as string) || '';
    const baseUrl = fromConfig
      ? fromConfig.replace(/\/$/, '')
      : req?.protocol && req.get
        ? `${req.protocol}://${String(req.get('host') || '')}`
        : '';
    return `${baseUrl}${this.scimPrefix}/${resource}/${encodeURIComponent(id)}`;
  }
}

// Helper for consumers that want to serialize an error via bulk-style
export { writeScimErrorFromException };
