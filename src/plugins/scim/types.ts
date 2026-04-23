/**
 * @module plugins/scim/types
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM 2.0 type definitions (RFC 7643 / RFC 7644).
 */

export const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCHEMA_LIST_RESPONSE =
  'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCHEMA_PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCHEMA_BULK_REQUEST =
  'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
export const SCHEMA_BULK_RESPONSE =
  'urn:ietf:params:scim:api:messages:2.0:BulkResponse';
export const SCHEMA_SERVICE_PROVIDER_CONFIG =
  'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
export const SCHEMA_RESOURCE_TYPE =
  'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
export const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

export interface Meta {
  resourceType: 'User' | 'Group';
  created?: string;
  lastModified?: string;
  location?: string;
  version?: string;
}

export interface MultiValued<T extends string = string> {
  value: T;
  display?: string;
  type?: string;
  primary?: boolean;
  $ref?: string;
}

export interface ScimName {
  formatted?: string;
  familyName?: string;
  givenName?: string;
  middleName?: string;
  honorificPrefix?: string;
  honorificSuffix?: string;
}

export interface ScimUser {
  schemas: string[];
  id?: string;
  externalId?: string;
  userName?: string;
  name?: ScimName;
  displayName?: string;
  nickName?: string;
  profileUrl?: string;
  title?: string;
  userType?: string;
  preferredLanguage?: string;
  locale?: string;
  timezone?: string;
  active?: boolean;
  password?: string;
  emails?: MultiValued[];
  phoneNumbers?: MultiValued[];
  ims?: MultiValued[];
  photos?: MultiValued[];
  addresses?: ScimAddress[];
  groups?: MultiValued[];
  entitlements?: MultiValued[];
  roles?: MultiValued[];
  x509Certificates?: MultiValued[];
  meta?: Meta;
  [ext: string]: unknown;
}

export interface ScimAddress {
  formatted?: string;
  streetAddress?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  type?: string;
  primary?: boolean;
}

export interface ScimGroup {
  schemas: string[];
  id?: string;
  externalId?: string;
  displayName?: string;
  members?: MultiValued[];
  meta?: Meta;
  [ext: string]: unknown;
}

export type ScimResource = ScimUser | ScimGroup;

export interface ListResponse<T> {
  schemas: [typeof SCHEMA_LIST_RESPONSE];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export type ScimErrorType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive';

export interface ScimErrorResponse {
  schemas: [typeof SCHEMA_ERROR];
  status: string;
  scimType?: ScimErrorType;
  detail?: string;
}

export interface PatchOperation {
  op: 'add' | 'remove' | 'replace' | 'Add' | 'Remove' | 'Replace';
  path?: string;
  value?: unknown;
}

export interface PatchRequest {
  schemas: string[];
  Operations: PatchOperation[];
}

export interface BulkOperationRequest {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  bulkId?: string;
  version?: string;
  path: string;
  data?: unknown;
}

export interface BulkRequest {
  schemas: string[];
  failOnErrors?: number;
  Operations: BulkOperationRequest[];
}

export interface BulkOperationResponse {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  bulkId?: string;
  version?: string;
  location?: string;
  status: string;
  response?: ScimErrorResponse;
}

export interface BulkResponse {
  schemas: [typeof SCHEMA_BULK_RESPONSE];
  Operations: BulkOperationResponse[];
}

/**
 * Internal mapping description: SCIM attribute → LDAP attribute(s).
 *
 * - ldap: one LDAP attribute name (simple mapping)
 * - ldapPrimary/ldapSecondary: primary vs non-primary in multi-valued attr (emails)
 * - sub: nested SCIM attribute name (for name.familyName etc.)
 * - multi: 'single' or 'array' (hint for formatting)
 * - operational: read-only from LDAP operational attribute
 */
export interface MappingEntry {
  scim: string;
  ldap?: string;
  ldapPrimary?: string;
  ldapSecondary?: string;
  sub?: Record<string, string>;
  multi?: 'single' | 'array';
  readOnly?: boolean;
  operational?: boolean;
  converter?: 'boolean' | 'number' | 'string';
}

export interface ResourceMapping {
  resourceType: 'User' | 'Group';
  schemas: string[];
  entries: MappingEntry[];
}

export interface ServiceProviderConfig {
  schemas: [typeof SCHEMA_SERVICE_PROVIDER_CONFIG];
  documentationUri?: string;
  patch: { supported: boolean };
  bulk: {
    supported: boolean;
    maxOperations: number;
    maxPayloadSize: number;
  };
  filter: { supported: boolean; maxResults: number };
  changePassword: { supported: boolean };
  sort: { supported: boolean };
  etag: { supported: boolean };
  authenticationSchemes: Array<{
    name: string;
    description: string;
    specUri?: string;
    documentationUri?: string;
    type: string;
    primary?: boolean;
  }>;
  meta?: { resourceType: 'ServiceProviderConfig'; location?: string };
}

export interface ResourceTypeDefinition {
  schemas: [typeof SCHEMA_RESOURCE_TYPE];
  id: string;
  name: string;
  endpoint: string;
  description?: string;
  schema: string;
  schemaExtensions?: Array<{ schema: string; required: boolean }>;
  meta?: { resourceType: 'ResourceType'; location?: string };
}

export interface SchemaDefinition {
  schemas: [typeof SCHEMA_SCHEMA];
  id: string;
  name: string;
  description?: string;
  attributes: unknown[];
  meta?: { resourceType: 'Schema'; location?: string };
}
