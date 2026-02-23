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
      // GET CSV template
      app.get(
        `${this.config.api_prefix}/v1/ldap/bulk-import/${resourceName}/template.csv`,
        (req, res) => this.getTemplate(req, res, resource)
      );

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
    const mainValue = entry[mainAttr];
    if (!mainValue) {
      throw new Error(`Missing main attribute: ${mainAttr}`);
    }
    validateDnValue(mainValue as string, mainAttr);
    const dn = `${mainAttr}=${escapeDnValue(mainValue as string)},${resource.base}`;

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
