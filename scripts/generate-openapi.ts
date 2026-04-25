#!/usr/bin/env tsx
/**
 * OpenAPI Generator for LDAP-Rest
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
    ['scim', 'SCIM 2.0'],
    ['ldapPasswordPolicy', 'Password Policy'],
    ['appAccountsApi', 'App Accounts'],
    ['hello', 'Demo'],
    ['authzDynamic', 'Authorization (Dynamic)'],
  ]);

  // Recognized plugin base classes (anything ultimately deriving from
  // DmPlugin via these). Without this, plugins extending an intermediate
  // base (e.g. AuthBase) would be silently skipped.
  private readonly pluginBaseClasses = new Set(['DmPlugin', 'AuthBase']);

  constructor(private rootDir: string) {
    // Create TypeScript program
    const configPath = ts.findConfigFile(
      rootDir,
      ts.sys.fileExists,
      'tsconfig.json'
    );
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

      // Check if it extends a recognized plugin base class
      const heritage = node.heritageClauses?.find(
        clause => clause.token === ts.SyntaxKind.ExtendsKeyword
      );
      const baseName = heritage?.types[0]?.expression.getText(sourceFile);
      if (baseName && this.pluginBaseClasses.has(baseName)) {
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

    // Collect local `const X = ...` declarations within the api() body
    // so we can substitute `${X}` in route paths (e.g. SCIM uses
    // `const prefix = this.scimPrefix` then `\`${prefix}/Users\``).
    const localVars = this.collectLocalStringVars(apiMethod.body, classNode);

    // Analyze the api() method body
    const routes = this.extractRoutesFromMethod(
      apiMethod.body,
      sourceFile,
      pluginName,
      localVars
    );
    if (routes.length > 0) {
      this.routes.set(pluginName, routes);
    }
  }

  /**
   * Walk the api() method body and resolve every top-level
   * `const X = <string-ish-expr>` to a concrete string value, using class
   * field initializers as fallbacks. Anything we can't resolve statically is
   * simply skipped — its `${X}` will remain in the path so the bug is visible.
   */
  private collectLocalStringVars(
    body: ts.Block,
    classNode: ts.ClassDeclaration
  ): Map<string, string> {
    const vars = new Map<string, string>();
    // Walk recursively so vars declared inside `if (...) { ... }` blocks
    // (e.g. authzDynamic's optional reload endpoint) still resolve.
    const visit = (n: ts.Node): void => {
      if (ts.isVariableStatement(n)) {
        for (const decl of n.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const value = this.resolveStringExpression(
            decl.initializer,
            classNode,
            vars
          );
          if (value !== undefined) {
            vars.set(decl.name.text, value);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return vars;
  }

  /**
   * Best-effort static resolution of an expression to a string. Handles
   * string literals, simple template literals, `a || b` fallbacks, and
   * `this.<field>` references resolved against the class's field
   * initializers. Returns undefined when the value cannot be determined.
   */
  private resolveStringExpression(
    expr: ts.Expression,
    classNode: ts.ClassDeclaration,
    locals: Map<string, string>
  ): string | undefined {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return expr.text;
    }

    if (ts.isTemplateExpression(expr)) {
      let out = expr.head.text;
      for (const span of expr.templateSpans) {
        const inner = this.resolveStringExpression(
          span.expression,
          classNode,
          locals
        );
        if (inner === undefined) return undefined;
        out += inner + span.literal.text;
      }
      return out;
    }

    if (ts.isIdentifier(expr)) {
      return locals.get(expr.text);
    }

    if (ts.isParenthesizedExpression(expr)) {
      return this.resolveStringExpression(expr.expression, classNode, locals);
    }

    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      return this.resolveStringExpression(expr.expression, classNode, locals);
    }

    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      // For `a || b` fallbacks the right-hand side is the static default.
      // Prefer it; fall back to LHS for completeness.
      return (
        this.resolveStringExpression(expr.right, classNode, locals) ??
        this.resolveStringExpression(expr.left, classNode, locals)
      );
    }

    if (ts.isPropertyAccessExpression(expr)) {
      // Hardcoded fallbacks for config knobs whose runtime defaults we know.
      const text = expr.getText();
      if (text === 'this.config.api_prefix') return '/api';
      if (text === 'this.config.scim_prefix') return '/scim/v2';

      // `this.<field>` → look up the class property's initializer.
      if (
        expr.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isIdentifier(expr.name)
      ) {
        const fieldName = expr.name.text;
        const value = this.resolveClassField(classNode, fieldName, locals);
        if (value !== undefined) return value;
      }
    }

    return undefined;
  }

  /**
   * Resolve a class property to a string by inspecting its declaration
   * initializer or, if absent, an assignment in the constructor of the
   * form `this.<field> = <expr>`.
   */
  private resolveClassField(
    classNode: ts.ClassDeclaration,
    fieldName: string,
    locals: Map<string, string>
  ): string | undefined {
    const prop = classNode.members.find(
      m =>
        ts.isPropertyDeclaration(m) &&
        m.name &&
        ts.isIdentifier(m.name) &&
        m.name.text === fieldName
    ) as ts.PropertyDeclaration | undefined;

    if (prop?.initializer) {
      const v = this.resolveStringExpression(
        prop.initializer,
        classNode,
        locals
      );
      if (v !== undefined) return v;
    }

    // Look for `this.<field> = ...` assignment in constructor.
    const ctor = classNode.members.find(m => ts.isConstructorDeclaration(m)) as
      | ts.ConstructorDeclaration
      | undefined;
    if (ctor?.body) {
      for (const stmt of ctor.body.statements) {
        if (!ts.isExpressionStatement(stmt)) continue;
        const e = stmt.expression;
        if (
          ts.isBinaryExpression(e) &&
          e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(e.left) &&
          e.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(e.left.name) &&
          e.left.name.text === fieldName
        ) {
          const v = this.resolveStringExpression(e.right, classNode, locals);
          if (v !== undefined) return v;
        }
      }
    }
    return undefined;
  }

  private extractRoutesFromMethod(
    body: ts.Block,
    sourceFile: ts.SourceFile,
    pluginName: string,
    localVars: Map<string, string>
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
            const route = this.parseRoute(
              node,
              method,
              sourceFile,
              pluginName,
              localVars
            );
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
    pluginName: string,
    localVars: Map<string, string>
  ): OpenAPIRoute | null {
    if (callExpr.arguments.length < 2) return null;

    // First argument is the path
    const pathArg = callExpr.arguments[0];
    let pathTemplate = '';

    // Handle template literals with ${this.config.api_prefix}
    if (
      ts.isTemplateExpression(pathArg) ||
      ts.isNoSubstitutionTemplateLiteral(pathArg)
    ) {
      const text = pathArg.getText(sourceFile);
      // Replace template variables with proper values
      pathTemplate = text
        .replace(/`/g, '')
        .replace(/\$\{this\.config\.api_prefix\}/g, '/api')
        .replace(/\$\{[^}]*api_prefix[^}]*\}/g, '/api')
        .replace(/\$\{apiPrefix\}/g, '/api')
        .replace(/\$\{this\.config\.static_name\}/g, 'static') // No leading slash
        .replace(/\$\{[^}]*static_name[^}]*\}/g, 'static')
        .replace(/\$\{resourceName\}/g, '{resource}')
        .replace(/\$\{[^}]*resourceName[^}]*\}/g, '{resource}');

      // Substitute any remaining `${name}` from the local-const map we
      // built from the api() body (e.g. `const prefix = this.scimPrefix`).
      for (const [name, value] of localVars) {
        const re = new RegExp(`\\$\\{${name}\\}`, 'g');
        pathTemplate = pathTemplate.replace(re, value);
      }
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
    const action =
      {
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
        title: 'LDAP-Rest API',
        version: '1.0.0',
        description: 'RESTful API for LDAP management with LDAP-Rest',
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
              description: 'Protocol scheme',
            },
            host: {
              default: 'localhost',
              description: 'Host name',
            },
            port: {
              default: '8081',
              description: 'Port number',
            },
          },
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
  console.log('🔍 Analyzing LDAP-Rest plugins...');
  const generator = new OpenAPIGenerator(rootDir);
  generator.analyze();
  generator.writeSpec(outputPath);
  console.log('✨ Done!');
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}
