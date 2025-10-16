#!/usr/bin/env tsx
/**
 * OpenAPI Generator for Mini-DM
 *
 * Generates OpenAPI 3.0 specification by analyzing TypeScript source code.
 * Extracts routes from plugin api() methods without requiring runtime execution.
 *
 * Usage: npm run generate:openapi
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface OpenAPIRoute {
  method: 'get' | 'post' | 'put' | 'delete' | 'patch';
  path: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query' | 'header' | 'body';
    required?: boolean;
    schema?: any;
    description?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content: {
      [mediaType: string]: {
        schema: any;
      };
    };
  };
  responses?: {
    [statusCode: string]: {
      description: string;
      content?: {
        [mediaType: string]: {
          schema: any;
        };
      };
    };
  };
  tags?: string[];
}

interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{
    url: string;
    description: string;
    variables?: {
      [key: string]: {
        default: string;
        enum?: string[];
        description?: string;
      };
    };
  }>;
  paths: {
    [path: string]: {
      [method: string]: any;
    };
  };
  components?: {
    schemas?: {
      [name: string]: any;
    };
  };
  tags?: Array<{
    name: string;
    description: string;
  }>;
}

class OpenAPIGenerator {
  private program: ts.Program;
  private checker: ts.TypeChecker;
  private routes: Map<string, OpenAPIRoute[]> = new Map();
  private pluginTags: Map<string, string> = new Map([
    ['ldapGroups', 'Groups'],
    ['ldapOrganizations', 'Organizations'],
    ['ldapFlatGeneric', 'Entities'],
    ['ldapBulkImport', 'Bulk Import'],
    ['james', 'Apache James Integration'],
    ['calendarResources', 'Calendar Resources'],
    ['configApi', 'Configuration'],
    ['static', 'Static Files'],
    ['trash', 'Trash'],
    ['externalUsersInGroups', 'External Users'],
  ]);

  constructor(private rootDir: string) {
    // Create TypeScript program
    const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) {
      throw new Error('tsconfig.json not found');
    }

    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    const { options, fileNames } = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      path.dirname(configPath)
    );

    this.program = ts.createProgram(fileNames, options);
    this.checker = this.program.getTypeChecker();
  }

  /**
   * Analyze all plugin files
   */
  public analyze(): void {
    const pluginsDir = path.join(this.rootDir, 'src', 'plugins');
    this.analyzeDirectory(pluginsDir);
  }

  private analyzeDirectory(dir: string): void {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        this.analyzeDirectory(fullPath);
      } else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        this.analyzeFile(fullPath);
      }
    }
  }

  private analyzeFile(filePath: string): void {
    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) return;

    // Visit all nodes in the file
    ts.forEachChild(sourceFile, node => this.visitNode(node, sourceFile));
  }

  private visitNode(node: ts.Node, sourceFile: ts.SourceFile): void {
    // Look for class declarations
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;

      // Check if it extends DmPlugin
      const heritage = node.heritageClauses?.find(
        clause => clause.token === ts.SyntaxKind.ExtendsKeyword
      );
      if (heritage?.types[0]?.expression.getText(sourceFile) === 'DmPlugin') {
        this.analyzePluginClass(node, sourceFile, className);
      }
    }

    // Recursively visit children
    ts.forEachChild(node, child => this.visitNode(child, sourceFile));
  }

  private analyzePluginClass(
    classNode: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    className: string
  ): void {
    // Find the api() method
    const apiMethod = classNode.members.find(
      member =>
        ts.isMethodDeclaration(member) &&
        member.name &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'api'
    ) as ts.MethodDeclaration | undefined;

    if (!apiMethod || !apiMethod.body) return;

    // Extract plugin name from 'name = ...' property
    const nameProp = classNode.members.find(
      member =>
        ts.isPropertyDeclaration(member) &&
        member.name &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'name'
    ) as ts.PropertyDeclaration | undefined;

    let pluginName = className;
    if (nameProp?.initializer && ts.isStringLiteral(nameProp.initializer)) {
      pluginName = nameProp.initializer.text;
    }

    // Analyze the api() method body
    const routes = this.extractRoutesFromMethod(apiMethod.body, sourceFile, pluginName);
    if (routes.length > 0) {
      this.routes.set(pluginName, routes);
    }
  }

  private extractRoutesFromMethod(
    body: ts.Block,
    sourceFile: ts.SourceFile,
    pluginName: string
  ): OpenAPIRoute[] {
    const routes: OpenAPIRoute[] = [];

    const visit = (node: ts.Node): void => {
      // Look for app.get(), app.post(), etc.
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr)) {
          const obj = expr.expression.getText(sourceFile);
          const method = expr.name.text as OpenAPIRoute['method'];

          if (
            obj === 'app' &&
            ['get', 'post', 'put', 'delete', 'patch'].includes(method)
          ) {
            const route = this.parseRoute(node, method, sourceFile, pluginName);
            if (route) {
              routes.push(route);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(body);
    return routes;
  }

  private parseRoute(
    callExpr: ts.CallExpression,
    method: OpenAPIRoute['method'],
    sourceFile: ts.SourceFile,
    pluginName: string
  ): OpenAPIRoute | null {
    if (callExpr.arguments.length < 2) return null;

    // First argument is the path
    const pathArg = callExpr.arguments[0];
    let pathTemplate = '';

    // Handle template literals with ${this.config.api_prefix}
    if (ts.isTemplateExpression(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) {
      const text = pathArg.getText(sourceFile);
      // Replace template variables with proper values
      pathTemplate = text
        .replace(/`/g, '')
        .replace(/\$\{this\.config\.api_prefix\}/g, '/api')
        .replace(/\$\{[^}]*api_prefix[^}]*\}/g, '/api')
        .replace(/\$\{apiPrefix\}/g, '/api')
        .replace(/\$\{this\.config\.static_name\}/g, 'static')  // No leading slash
        .replace(/\$\{[^}]*static_name[^}]*\}/g, 'static')
        .replace(/\$\{resourceName\}/g, '{resource}')
        .replace(/\$\{[^}]*resourceName[^}]*\}/g, '{resource}');
    } else if (ts.isStringLiteral(pathArg)) {
      pathTemplate = pathArg.text;
    }

    if (!pathTemplate) return null;

    // Convert Express-style :param to OpenAPI {param}
    pathTemplate = pathTemplate.replace(/:(\w+)/g, '{$1}');

    // Clean up double slashes
    pathTemplate = pathTemplate.replace(/\/\//g, '/');

    // Extract parameters from path
    const pathParams = this.extractPathParameters(pathTemplate);

    // Extract JSDoc comments if any
    const leadingComments = this.getLeadingComments(callExpr, sourceFile);
    const summary = this.extractSummaryFromComments(leadingComments);
    const description = this.extractDescriptionFromComments(leadingComments);

    const route: OpenAPIRoute = {
      method,
      path: pathTemplate,
      summary: summary || this.generateSummary(method, pathTemplate),
      description,
      parameters: pathParams,
      responses: {
        '200': {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
        '400': {
          description: 'Bad request',
        },
        '401': {
          description: 'Unauthorized',
        },
        '404': {
          description: 'Not found',
        },
        '500': {
          description: 'Internal server error',
        },
      },
      tags: [this.pluginTags.get(pluginName) || pluginName],
    };

    // Add requestBody for POST/PUT/PATCH
    if (['post', 'put', 'patch'].includes(method)) {
      route.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object' },
          },
        },
      };

      // Handle multipart for bulk import
      if (pathTemplate.includes('bulk-import')) {
        route.requestBody.content = {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                file: {
                  type: 'string',
                  format: 'binary',
                  description: 'CSV file to import',
                },
                dryRun: {
                  type: 'boolean',
                  description: 'Validate without creating entries',
                },
                updateExisting: {
                  type: 'boolean',
                  description: 'Update existing entries',
                },
                continueOnError: {
                  type: 'boolean',
                  description: 'Continue processing on errors',
                  default: true,
                },
              },
              required: ['file'],
            },
          },
        };
      }
    }

    // Special handling for CSV template
    if (method === 'get' && pathTemplate.includes('template.csv')) {
      route.responses['200'] = {
        description: 'CSV template',
        content: {
          'text/csv': {
            schema: { type: 'string' },
          },
        },
      };
    }

    return route;
  }

  private extractPathParameters(path: string): OpenAPIRoute['parameters'] {
    const params: OpenAPIRoute['parameters'] = [];
    const matches = path.matchAll(/\{(\w+)\}/g);

    for (const match of matches) {
      params.push({
        name: match[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: `${match[1]} parameter`,
      });
    }

    return params.length > 0 ? params : undefined;
  }

  private getLeadingComments(node: ts.Node, sourceFile: ts.SourceFile): string {
    const fullText = sourceFile.getFullText();
    const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
    if (!ranges) return '';

    return ranges
      .map(range => fullText.substring(range.pos, range.end))
      .join('\n');
  }

  private extractSummaryFromComments(comments: string): string | undefined {
    const match = comments.match(/@openapi\s+summary:\s*(.+)/i);
    return match ? match[1].trim() : undefined;
  }

  private extractDescriptionFromComments(comments: string): string | undefined {
    const match = comments.match(/@openapi\s+description:\s*(.+)/i);
    return match ? match[1].trim() : undefined;
  }

  private generateSummary(method: string, path: string): string {
    const action = {
      get: 'Get',
      post: 'Create',
      put: 'Update',
      delete: 'Delete',
      patch: 'Modify',
    }[method] || method.toUpperCase();

    // Extract resource from path
    const parts = path.split('/').filter(p => p && !p.startsWith('{'));
    const resource = parts[parts.length - 1] || 'resource';

    return `${action} ${resource}`;
  }

  /**
   * Generate OpenAPI spec
   */
  public generateSpec(): OpenAPISpec {
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      info: {
        title: 'Mini-DM API',
        version: '1.0.0',
        description: 'RESTful API for LDAP management with Mini-DM',
      },
      servers: [
        {
          url: 'http://localhost:8081',
          description: 'Development server',
        },
        {
          url: '{protocol}://{host}:{port}',
          description: 'Custom server',
          variables: {
            protocol: {
              default: 'http',
              enum: ['http', 'https'],
              description: 'Protocol scheme'
            },
            host: {
              default: 'localhost',
              description: 'Host name'
            },
            port: {
              default: '8081',
              description: 'Port number'
            }
          }
        },
      ],
      paths: {},
      tags: Array.from(new Set(this.pluginTags.values())).map(tag => ({
        name: tag,
        description: `${tag} operations`,
      })),
    };

    // Build paths
    for (const [pluginName, routes] of this.routes) {
      for (const route of routes) {
        if (!spec.paths[route.path]) {
          spec.paths[route.path] = {};
        }

        spec.paths[route.path][route.method] = {
          summary: route.summary,
          description: route.description,
          tags: route.tags,
          parameters: route.parameters,
          requestBody: route.requestBody,
          responses: route.responses,
        };
      }
    }

    return spec;
  }

  /**
   * Write spec to file
   */
  public writeSpec(outputPath: string): void {
    const spec = this.generateSpec();
    fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf-8');
    console.log(`✅ OpenAPI spec generated: ${outputPath}`);
    console.log(`   Found ${this.routes.size} plugins`);
    console.log(`   Generated ${Object.keys(spec.paths).length} paths`);
  }
}

// Main
const rootDir = path.join(__dirname, '..');
const outputPath = path.join(rootDir, 'openapi.json');

try {
  console.log('🔍 Analyzing Mini-DM plugins...');
  const generator = new OpenAPIGenerator(rootDir);
  generator.analyze();
  generator.writeSpec(outputPath);
  console.log('✨ Done!');
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}
