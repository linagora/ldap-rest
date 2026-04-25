/**
 * LDAP Bulk Import Plugin
 * Provides CSV-based bulk import for LDAP resources based on JSON schemas
 * @author LDAP-Rest Team
 */

import fs from 'fs';

import type { Express, Request, Response } from 'express';
import type { SearchResult } from 'ldapts';
import multer from 'multer';
import { parse as csvParse } from 'csv-parse/sync';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { AttributesList, AttributeValue } from '../../lib/ldapActions';
import { badRequest, serverError } from '../../lib/expressFormatedResponses';
import { escapeDnValue, validateDnValue } from '../../lib/utils';

interface BulkImportSchema {
  base?: string;
  mainAttribute?: string;
  properties: {
    [key: string]: {
      type?: string;
      fixed?: boolean;
      default?: AttributeValue;
      const?: AttributeValue;
      required?: boolean;
      role?: string[];
    };
  };
}

interface BulkImportResource {
  name: string;
  schema: BulkImportSchema;
  base: string;
  mainAttribute: string;
}

interface BulkImportResult {
  success: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{
    line: number;
    identifier?: string;
    error: string;
  }>;
  details: {
    duration: string;
    linesProcessed: number;
  };
}

/**
 * Shared OpenAPI schemas surfaced by this plugin. Picked up by
 * scripts/generate-openapi.ts and merged into `components.schemas`.
 *
 * @openapi-component
 * BulkImportResult:
 *   type: object
 *   description: Summary returned after a bulk import operation.
 *   required: [success, total, created, updated, skipped, failed, errors, details]
 *   properties:
 *     success:
 *       type: boolean
 *       description: True when no fatal error aborted the import early.
 *     total:
 *       type: integer
 *       description: Total number of CSV data rows (excluding header).
 *       example: 42
 *     created:
 *       type: integer
 *       description: Entries successfully created (or counted in dry-run).
 *       example: 38
 *     updated:
 *       type: integer
 *       description: Existing entries updated.
 *       example: 2
 *     skipped:
 *       type: integer
 *       description: Existing entries skipped because `updateExisting` was false.
 *       example: 1
 *     failed:
 *       type: integer
 *       description: Rows that caused an error.
 *       example: 1
 *     errors:
 *       type: array
 *       items:
 *         type: object
 *         required: [line, error]
 *         properties:
 *           line:
 *             type: integer
 *             description: 1-based CSV line number (2 = first data row).
 *           identifier:
 *             type: string
 *             description: Value of the main attribute for the failing row (if known).
 *           error:
 *             type: string
 *             description: Error message.
 *       example:
 *         - line: 5
 *           identifier: bob
 *           error: 'Missing required attribute: mail'
 *     details:
 *       type: object
 *       required: [duration, linesProcessed]
 *       properties:
 *         duration:
 *           type: string
 *           description: Wall-clock time for the import (e.g. `1.2s`).
 *           example: 1.2s
 *         linesProcessed:
 *           type: integer
 *           description: Total data rows attempted.
 *           example: 42
 */
export default class LdapBulkImport extends DmPlugin {
  name = 'ldapBulkImport';
  roles: Role[] = ['configurable'] as const;

  private resources: Map<string, BulkImportResource> = new Map();
  private upload: multer.Multer;

  constructor(parent: DM) {
    super(parent);

    // Configure multer for file uploads
    const maxFileSize =
      parseInt(this.config.bulk_import_max_file_size as string, 10) || 10485760; // 10MB default

    this.upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxFileSize },
      fileFilter: (
        req: Express.Request,
        file: Express.Multer.File,
        cb: multer.FileFilterCallback
      ) => {
        if (
          file.mimetype === 'text/csv' ||
          file.originalname.endsWith('.csv')
        ) {
          cb(null, true);
        } else {
          cb(new Error('Only CSV files are allowed'));
        }
      },
    });

    // Load schemas configuration
    const schemasConfig = this.config.bulk_import_schemas as string;
    if (!schemasConfig) {
      this.logger.warn('No bulk import schemas configured');
      return;
    }

    // Parse schemas config: "users:path/to/schema.json,groups:path/to/schema.json"
    const schemaEntries = schemasConfig.split(',').map(entry => entry.trim());

    for (const entry of schemaEntries) {
      const [resourceName, schemaPath] = entry.split(':').map(s => s.trim());
      if (!resourceName || !schemaPath) {
        this.logger.warn(`Invalid schema entry: ${entry}`);
        continue;
      }

      try {
        const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent) as BulkImportSchema;

        this.resources.set(resourceName, {
          name: resourceName,
          schema,
          base: (schema.base || this.config.ldap_base) as string,
          mainAttribute: schema.mainAttribute || 'cn',
        });

        this.logger.info(
          `Loaded bulk import resource: ${resourceName} from ${schemaPath}`
        );
      } catch (error) {
        this.logger.error(
          `Failed to load schema for ${resourceName}: ${(error as Error).message}`
        );
      }
    }
  }

  api(app: Express): void {
    for (const [resourceName, resource] of this.resources) {
      /**
       * @openapi
       * summary: Download CSV import template
       * description: |
       *   Returns a CSV file with the header row listing all editable columns for
       *   the `{resource}` type. Fixed, calculated, and organization-path columns
       *   are excluded because they are injected automatically during import.
       *
       *   Use this template as the starting point for a bulk import file.
       * responses:
       *   '200':
       *     description: CSV template file.
       *     content:
       *       text/csv:
       *         schema: { type: string }
       *         example: |
       *           cn,sn,givenName,mail,organizationDn
       *   '404':
       *     description: Resource type not found.
       *     content:
       *       application/json:
       *         schema: { $ref: '#/components/schemas/Error' }
       */
      // GET CSV template
      app.get(
        `${this.config.api_prefix}/v1/ldap/bulk-import/${resourceName}/template.csv`,
        (req, res) => this.getTemplate(req, res, resource)
      );

      /**
       * @openapi
       * summary: Bulk import from CSV
       * description: |
       *   Accepts a multipart/form-data upload containing a CSV file and optional
       *   control flags. Each data row is mapped to an LDAP entry using the resource
       *   schema. Multi-valued attributes can be expressed with semicolons
       *   (`val1;val2;val3`). An `organizationDn` column (not listed in the template
       *   header) may be provided to set the organization link and path attributes
       *   automatically.
       *
       *   **Dry-run mode** (`dryRun=true`) validates and counts rows without writing
       *   to LDAP. `continueOnError` (default `true`) keeps processing subsequent rows
       *   after an individual row fails.
       * requestBody:
       *   required: true
       *   content:
       *     multipart/form-data:
       *       schema:
       *         type: object
       *         required: [file]
       *         properties:
       *           file:
       *             type: string
       *             format: binary
       *             description: CSV file to import (max 10 MB by default).
       *           dryRun:
       *             type: boolean
       *             description: |
       *               When true, validate and count rows without writing to LDAP.
       *           updateExisting:
       *             type: boolean
       *             description: |
       *               When true, existing entries are updated (replace). When false
       *               (default), they are skipped.
       *           continueOnError:
       *             type: boolean
       *             default: true
       *             description: |
       *               Continue processing subsequent rows after a row-level error.
       * responses:
       *   '200':
       *     description: Import result summary.
       *     content:
       *       application/json:
       *         schema: { $ref: '#/components/schemas/BulkImportResult' }
       *         example:
       *           success: true
       *           total: 10
       *           created: 9
       *           updated: 0
       *           skipped: 0
       *           failed: 1
       *           errors:
       *             - line: 7
       *               identifier: charlie
       *               error: 'Missing required attribute: mail'
       *           details:
       *             duration: 0.8s
       *             linesProcessed: 10
       *   '400':
       *     description: No file uploaded or malformed request.
       *     content:
       *       application/json:
       *         schema: { $ref: '#/components/schemas/Error' }
       *   '500':
       *     description: Unexpected server error.
       *     content:
       *       application/json:
       *         schema: { $ref: '#/components/schemas/Error' }
       */
      // POST bulk import
      app.post(
        `${this.config.api_prefix}/v1/ldap/bulk-import/${resourceName}`,
        this.upload.single('file'),
        async (req, res) => this.bulkImport(req, res, resource)
      );
    }
  }

  /**
   * Generate CSV template from schema
   */
  private getTemplate(
    req: Request,
    res: Response,
    resource: BulkImportResource
  ): void {
    const headers = this.getEditableAttributes(resource.schema);
    headers.push('organizationDn'); // Special column for organization link/path

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${resource.name}-template.csv"`
    );
    res.send(headers.join(',') + '\n');
  }

  /**
   * Bulk import from CSV file
   */
  private async bulkImport(
    req: Request & { file?: Express.Multer.File },
    res: Response,
    resource: BulkImportResource
  ): Promise<void> {
    if (!req.file) {
      return badRequest(res, 'No file uploaded');
    }

    const dryRun =
      (req.body as { dryRun?: string }).dryRun === 'true' ||
      (req.body as { dryRun?: boolean }).dryRun === true;
    const updateExisting =
      (req.body as { updateExisting?: string }).updateExisting === 'true' ||
      (req.body as { updateExisting?: boolean }).updateExisting === true;
    const continueOnError =
      (req.body as { continueOnError?: string }).continueOnError !== 'false' &&
      (req.body as { continueOnError?: boolean }).continueOnError !== false;

    const startTime = Date.now();
    const result: BulkImportResult = {
      success: true,
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      details: {
        duration: '',
        linesProcessed: 0,
      },
    };

    try {
      // Parse CSV
      const csvContent = req.file.buffer.toString('utf-8');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const records = csvParse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];

      result.total = records.length;

      // Process each record
      for (let i = 0; i < records.length; i++) {
        const line = i + 2; // +2 because of header and 0-based index
        const record = records[i];

        try {
          const { dn, entry } = await this.processRecord(record, resource);

          // const identifier = entry[resource.mainAttribute];

          // Check if entry exists
          const exists = await this.entryExists(dn);

          if (exists && !updateExisting) {
            result.skipped++;
            continue;
          }

          if (dryRun) {
            result.created++;
            continue;
          }

          // Create or update entry
          if (exists && updateExisting) {
            await this.server.ldap.modify(
              dn,
              { replace: entry },
              req as Request
            );
            result.updated++;
          } else {
            await this.server.ldap.add(dn, entry, req as Request);
            result.created++;
          }
        } catch (error) {
          result.failed++;
          result.errors.push({
            line,
            identifier: record[resource.mainAttribute],
            error: (error as Error).message,
          });

          if (!continueOnError) {
            throw error;
          }
        }
      }

      result.details.linesProcessed = records.length;
      result.details.duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

      res.json(result);
    } catch (error) {
      return serverError(res, error);
    }
  }

  /**
   * Process a single CSV record
   */
  private async processRecord(
    csvLine: Record<string, string>,
    resource: BulkImportResource
  ): Promise<{ dn: string; entry: AttributesList }> {
    const entry: AttributesList = {};
    const schema = resource.schema;

    // 1. Extract organizationDn
    const orgDn = csvLine.organizationDn;
    delete csvLine.organizationDn;

    // 2. Add fixed fields from schema
    for (const [attr, def] of Object.entries(schema.properties || {})) {
      if (def.fixed === true) {
        const value = def.default || def.const;
        if (value !== undefined) {
          entry[attr] = value;
        }
      }
    }

    // 3. Add fields from CSV
    for (const [attr, value] of Object.entries(csvLine)) {
      if (value && value.trim() !== '') {
        // Support multi-value: "val1;val2;val3"
        entry[attr] = value.includes(';')
          ? value.split(';').map(v => v.trim())
          : value;
      }
    }

    // 4. Calculate organizationLink and organizationPath
    if (orgDn) {
      const linkAttr = this.findAttributeByRole(schema, 'organizationLink');
      if (linkAttr) {
        entry[linkAttr] = orgDn;
      }

      const pathAttr = this.findAttributeByRole(schema, 'organizationPath');
      if (pathAttr) {
        const org = await this.fetchOrganization(orgDn);
        const pathValue = org[pathAttr];
        entry[pathAttr] = Array.isArray(pathValue) ? pathValue[0] : pathValue;
      }
    }

    // 5. Validate required attributes
    for (const [attr, def] of Object.entries(schema.properties || {})) {
      if (def.required === true && !entry[attr]) {
        throw new Error(`Missing required attribute: ${attr}`);
      }
    }

    // 6. Build DN
    const mainAttr = resource.mainAttribute;
    const rawMainValue = entry[mainAttr];
    if (!rawMainValue) {
      throw new Error(`Missing main attribute: ${mainAttr}`);
    }
    // Handle array values by taking the first element
    const mainValue = Array.isArray(rawMainValue)
      ? String(rawMainValue[0])
      : String(rawMainValue);
    validateDnValue(mainValue, mainAttr);
    const dn = `${mainAttr}=${escapeDnValue(mainValue)},${resource.base}`;

    return { dn, entry };
  }

  /**
   * Get editable attributes from schema (exclude fixed and calculated)
   */
  private getEditableAttributes(schema: BulkImportSchema): string[] {
    const attrs: string[] = [];
    for (const [name, def] of Object.entries(schema.properties || {})) {
      // Exclude fixed
      if (def.fixed === true) continue;

      // Exclude organizationLink and organizationPath (calculated auto)
      if (def.role?.includes('organizationLink')) continue;
      if (def.role?.includes('organizationPath')) continue;

      attrs.push(name);
    }
    return attrs;
  }

  /**
   * Find attribute by role in schema
   */
  private findAttributeByRole(
    schema: BulkImportSchema,
    role: string
  ): string | null {
    for (const [name, def] of Object.entries(schema.properties || {})) {
      if (def.role?.includes(role)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Fetch organization to get its path
   */
  private async fetchOrganization(dn: string): Promise<AttributesList> {
    const result = await this.server.ldap.search(
      { paged: false, scope: 'base' },
      dn
    );

    if ((result as SearchResult).searchEntries.length === 0) {
      throw new Error(`Organization not found: ${dn}`);
    }

    return (result as SearchResult).searchEntries[0];
  }

  /**
   * Check if entry exists
   */
  private async entryExists(dn: string): Promise<boolean> {
    try {
      const result = await this.server.ldap.search(
        { paged: false, scope: 'base' },
        dn
      );
      return (result as SearchResult).searchEntries.length > 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      return false;
    }
  }

  /**
   * Provide configuration for config API
   */
  getConfigApiData(): Record<string, unknown> {
    const apiPrefix = this.config.api_prefix || '/api';
    const resources: Array<{
      name: string;
      mainAttribute: string;
      base: string;
      maxFileSize: number;
      batchSize: number;
      endpoints: {
        template: string;
        import: string;
      };
    }> = [];

    this.resources.forEach((resource, resourceName) => {
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
