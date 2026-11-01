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
import * as yaml from 'js-yaml';
import { fileURLToPath, pathToFileURL } from 'url';
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

export class OpenAPIGenerator {
  private program: ts.Program;
  private checker: ts.TypeChecker;
  private routes: Map<string, OpenAPIRoute[]> = new Map();
  private components: Record<string, unknown> = {};
  private pluginTags: Map<string, string> = new Map([
    ['ldapGroups', 'Groups'],
    ['ldapOrganizations', 'Organizations'],
    ['ldapFlatGeneric', 'Entities'],
    ['ldapBulkImport', 'Bulk Import'],
    ['james', 'Apache James Integration'],
    ['calendar', 'Twake Calendar'],
    ['configApi', 'Configuration'],
    ['static', 'Static Files'],
    ['trash', 'Trash'],
    ['externalUsersInGroups', 'External Users'],
    ['scim', 'SCIM 2.0'],
    ['ldapPasswordPolicy', 'Password Policy'],
    ['appAccountsApi', 'App Accounts'],
    ['hello', 'Demo'],
    ['authzDynamic', 'Authorization (Dynamic)'],
    ['james', 'Apache James Integration'],
    // Abstract LdapFlat exposes the generic per-resource CRUD surface;
    // every concrete flat plugin (users, mailgroups, …) inherits from it.
    ['LdapFlat', 'Entities'],
  ]);

  // Recognized plugin base classes (anything ultimately deriving from
  // DmPlugin via these). Without this, plugins extending an intermediate
  // base (e.g. AuthBase, TwakePlugin) would be silently skipped.
  private readonly pluginBaseClasses = new Set([
    'DmPlugin',
    'AuthBase',
    'AuthzBase',
    'TwakePlugin',
    'LdapGroups',
  ]);

  /**
   * The plugin classes the file walk found. They are analyzed once the walk
   * is over, because reading a declared schema imports its module.
   */
  private readonly pendingClasses: Array<{
    classNode: ts.ClassDeclaration;
    sourceFile: ts.SourceFile;
    className: string;
  }> = [];

  /** Imported schema modules, by absolute file path. */
  private readonly schemaModules = new Map<string, Promise<object>>();

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
   * Analyze all plugin files. Walks `src/plugins/` for concrete plugins
   * plus `src/abstract/` so abstract bases like LdapFlat (which carries
   * the generic per-resource CRUD routes inherited by every flat
   * plugin) are documented too.
   */
  public async analyze(
    dirs: string[] = [
      path.join(this.rootDir, 'src', 'plugins'),
      path.join(this.rootDir, 'src', 'abstract'),
    ]
  ): Promise<void> {
    for (const dir of dirs) this.analyzeDirectory(dir);
    for (const pending of this.pendingClasses)
      await this.analyzePluginClass(
        pending.classNode,
        pending.sourceFile,
        pending.className
      );
  }

  private analyzeDirectory(dir: string): void {
    const files = fs.readdirSync(dir).sort();
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

    // Pull `@openapi-component` schemas defined anywhere in the file into
    // the global `components.schemas` registry.
    this.collectComponentsFromFile(sourceFile);

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
        this.pendingClasses.push({ classNode: node, sourceFile, className });
      }
    }

    // Recursively visit children
    ts.forEachChild(node, child => this.visitNode(child, sourceFile));
  }

  private async analyzePluginClass(
    classNode: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    className: string
  ): Promise<void> {
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

    for (const call of this.definedRouteCalls(classNode)) {
      const route = await this.parseDefinedRoute(
        call,
        sourceFile,
        pluginName,
        localVars
      );
      if (route) routes.push(route);
    }

    if (routes.length > 0) {
      this.routes.set(pluginName, routes);
    }
  }

  /**
   * The `defineRoute(…)` calls of a plugin class, in source order.
   *
   * The whole class is walked, not only `api()`: a plugin may declare its
   * routes in a helper method. The callee is resolved through the checker,
   * so an aliased import (`import { defineRoute as route }`) is found too.
   */
  private definedRouteCalls(
    classNode: ts.ClassDeclaration
  ): ts.CallExpression[] {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && this.isDefineRoute(node.expression))
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(classNode);
    return calls;
  }

  /** Whether an expression names the `defineRoute` of `src/lib/route.ts`. */
  private isDefineRoute(expr: ts.Expression): boolean {
    let symbol = this.checker.getSymbolAtLocation(expr);
    for (let depth = 0; symbol?.flags && depth < 8; depth++) {
      if (!(symbol.flags & ts.SymbolFlags.Alias)) break;
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    if (!symbol || symbol.getName() !== 'defineRoute') return false;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    return (
      declaration?.getSourceFile().fileName ===
      path.join(this.rootDir, 'src', 'lib', 'route.ts')
    );
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
      ts.ConstructorDeclaration | undefined;
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

  /**
   * Turn a path expression into the OpenAPI path: resolve the template
   * substitutions the generator knows, and spell `:param` `{param}`.
   *
   * @param pathArg the path expression, in the app call or the declaration
   * @param sourceFile the file holding it
   * @param localVars the `const X = '…'` of the `api()` body
   * @returns the path, or an empty string when it cannot be resolved
   */
  private resolveRoutePath(
    pathArg: ts.Expression,
    sourceFile: ts.SourceFile,
    localVars: Map<string, string>
  ): string {
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
        .replace(/\$\{[^}]*resourceName[^}]*\}/g, '{resource}')
        // LdapFlat instances each have a different `this.pluralName`;
        // the spec describes the generic shape with a `{resource}`
        // placeholder.
        .replace(/\$\{this\.pluralName\}/g, '{resource}');

      // Substitute any remaining `${name}` from the local-const map we
      // built from the api() body (e.g. `const prefix = this.scimPrefix`).
      for (const [name, value] of localVars) {
        const re = new RegExp(`\\$\\{${name}\\}`, 'g');
        pathTemplate = pathTemplate.replace(re, value);
      }
    } else if (ts.isStringLiteral(pathArg)) {
      pathTemplate = pathArg.text;
    } else if (ts.isIdentifier(pathArg)) {
      // `const base = \`…/spaces\`` then `path: base`
      pathTemplate = localVars.get(pathArg.text) ?? '';
    }

    if (!pathTemplate) return '';

    // Convert Express-style :param to OpenAPI {param}
    pathTemplate = pathTemplate.replace(/:(\w+)/g, '{$1}');

    // Clean up double slashes
    return pathTemplate.replace(/\/\//g, '/');
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
    const pathTemplate = this.resolveRoutePath(pathArg, sourceFile, localVars);

    if (!pathTemplate) return null;

    // Extract parameters from path
    const pathParams = this.extractPathParameters(pathTemplate);

    // Pull any `@openapi` YAML overrides authored above the route. These
    // are merged on top of the generated defaults below, so a plugin can
    // override anything (summary, parameters, requestBody, responses,
    // tags, security, …) without us having to add ad-hoc heuristics.
    const overrides = this.extractRouteOverrides(callExpr, sourceFile);

    // Strict opt-in: routes without an `@openapi` block are excluded from
    // the spec. The published doc should reflect intentionally-documented
    // surface only, not auto-extracted noise. We log a warning so authors
    // notice when a new route slips in without documentation.
    if (Object.keys(overrides).length === 0) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        callExpr.getStart()
      );
      console.warn(
        `⚠️  Skipping undocumented route: ${method.toUpperCase()} ${pathTemplate} ` +
          `(${path.relative(this.rootDir, sourceFile.fileName)}:${line + 1})`
      );
      return null;
    }

    const route: OpenAPIRoute = {
      method,
      path: pathTemplate,
      summary:
        (overrides.summary as string | undefined) ||
        this.generateSummary(method, pathTemplate),
      description: overrides.description as string | undefined,
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
      route.responses!['200'] = {
        description: 'CSV template',
        content: {
          'text/csv': {
            schema: { type: 'string' },
          },
        },
      };
    }

    return this.applyOverrides(route, overrides);
  }

  /**
   * Deep-merge an `@openapi` block over the generated route: YAML wins.
   * Parameters are concatenated with the generated ones, deduplicated by
   * `in` + `name`, because dropping a path parameter would produce an
   * invalid document.
   */
  private applyOverrides(
    route: OpenAPIRoute,
    overrides: Record<string, unknown>
  ): OpenAPIRoute {
    if (Object.keys(overrides).length === 0) return route;

    const { summary: _s, description: _d, ...rest } = overrides;

    if (Array.isArray(rest.parameters) && route.parameters) {
      const seen = new Set(
        (rest.parameters as Array<{ in?: string; name?: string }>).map(
          p => `${p.in}:${p.name}`
        )
      );
      const merged = [
        ...route.parameters.filter(p => !seen.has(`${p.in}:${p.name}`)),
        ...(rest.parameters as NonNullable<OpenAPIRoute['parameters']>),
      ];
      rest.parameters = merged as unknown as Record<string, unknown>[];
    }

    const merged = this.deepMerge(
      route as unknown as Record<string, unknown>,
      rest
    );
    return merged as unknown as OpenAPIRoute;
  }

  /**
   * Read the declaration of a `defineRoute` call.
   *
   * The declaration is the document: its schemas become the parameters and
   * the request body, its `responses` the answer schemas, and its summary or
   * description the operation's. An `@openapi` block above the call still
   * wins, as it does over the generated defaults of an `app.<verb>` route.
   */
  private async parseDefinedRoute(
    callExpr: ts.CallExpression,
    sourceFile: ts.SourceFile,
    pluginName: string,
    localVars: Map<string, string>
  ): Promise<OpenAPIRoute | null> {
    const declaration = callExpr.arguments[1];
    if (!declaration || !ts.isObjectLiteralExpression(declaration)) {
      this.warnUnreadable(
        callExpr,
        sourceFile,
        'the declaration is not an object literal'
      );
      return null;
    }

    const property = (name: string): ts.PropertyAssignment | undefined =>
      this.propertyOf(declaration, name, sourceFile);

    const methodProp = property('method');
    const pathProp = property('path');
    if (!methodProp || !pathProp) {
      this.warnUnreadable(
        callExpr,
        sourceFile,
        'the method or the path is missing'
      );
      return null;
    }
    if (!ts.isStringLiteral(methodProp.initializer)) {
      this.warnUnreadable(callExpr, sourceFile, 'the method is not a literal');
      return null;
    }
    const method = methodProp.initializer.text as OpenAPIRoute['method'];
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
      this.warnUnreadable(callExpr, sourceFile, `unknown method ${method}`);
      return null;
    }

    const path = this.resolveRoutePath(
      pathProp.initializer,
      sourceFile,
      localVars
    );
    if (!path) {
      this.warnUnreadable(callExpr, sourceFile, 'the path cannot be resolved');
      return null;
    }

    const overrides = this.extractRouteOverrides(callExpr, sourceFile);
    const summary = this.stringProperty(property('summary'));
    const description = this.stringProperty(property('description'));
    const tags = this.stringArrayProperty(property('tags'));

    const responses: NonNullable<OpenAPIRoute['responses']> = {
      '200': { description: 'Successful response' },
      '400': { description: 'Bad request' },
      '401': { description: 'Unauthorized' },
      '404': { description: 'Not found' },
      '500': { description: 'Internal server error' },
    };

    const route: OpenAPIRoute = {
      method,
      path,
      summary:
        summary ||
        (overrides.summary as string | undefined) ||
        this.generateSummary(method, path),
      description: description || (overrides.description as string | undefined),
      parameters: this.mergeParameters(this.extractPathParameters(path), [
        ...(await this.pathParametersOf(property('params'), path, sourceFile)),
        ...(await this.parametersOf(property('query'), sourceFile, 'query')),
      ]),
      responses,
      tags: tags.length
        ? tags
        : [this.pluginTags.get(pluginName) || pluginName],
    };

    // An `@openapi` block describing the body wins whole: merging the two
    // schemas would leave a `$ref` next to the keys of the other.
    const documentedSchema = (
      overrides.requestBody as
        { content?: Record<string, { schema?: unknown }> } | undefined
    )?.content?.['application/json']?.schema;
    const body = await this.schemaOf(property('body'), sourceFile);
    if (body !== undefined && documentedSchema === undefined) {
      route.requestBody = {
        required: ((body as { required?: string[] }).required?.length ?? 0) > 0,
        content: { 'application/json': { schema: body } },
      };
    }

    const responsesProp = property('responses');
    if (
      responsesProp &&
      ts.isObjectLiteralExpression(responsesProp.initializer)
    ) {
      for (const entry of responsesProp.initializer.properties) {
        if (!ts.isPropertyAssignment(entry)) continue;
        const code = entry.name.getText(sourceFile).replace(/^['"]|['"]$/g, '');
        // `{ schema, description }` or a bare schema
        const wrapper = ts.isObjectLiteralExpression(entry.initializer)
          ? entry.initializer
          : undefined;
        const schemaProp = wrapper
          ? this.propertyOf(wrapper, 'schema', sourceFile)
          : undefined;
        const schema = await this.resolveSchema(
          schemaProp?.initializer ?? entry.initializer,
          sourceFile
        );
        if (schema === undefined) continue;
        const description = wrapper
          ? this.stringProperty(
              this.propertyOf(wrapper, 'description', sourceFile)
            )
          : undefined;
        responses[code] = {
          description:
            description ?? responses[code]?.description ?? `${code} response`,
          content: { 'application/json': { schema } },
        };
      }
    }

    return this.applyOverrides(route, overrides);
  }

  /** The property assignment `name` of an object literal, if any. */
  private propertyOf(
    object: ts.ObjectLiteralExpression,
    name: string,
    sourceFile: ts.SourceFile
  ): ts.PropertyAssignment | undefined {
    return object.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && p.name.getText(sourceFile) === name
    );
  }

  private stringProperty(
    prop: ts.PropertyAssignment | undefined
  ): string | undefined {
    if (!prop) return undefined;
    return this.constantString(prop.initializer);
  }

  /** A string built from literals, `+` and parentheses. */
  private constantString(expr: ts.Expression): string | undefined {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
      return expr.text;
    if (ts.isParenthesizedExpression(expr))
      return this.constantString(expr.expression);
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = this.constantString(expr.left);
      const right = this.constantString(expr.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
    return undefined;
  }

  private stringArrayProperty(
    prop: ts.PropertyAssignment | undefined
  ): string[] {
    if (!prop || !ts.isArrayLiteralExpression(prop.initializer)) return [];
    return prop.initializer.elements
      .map(element => this.constantString(element))
      .filter((value): value is string => Boolean(value));
  }

  /** The parameters a `params` or `query` schema declares. */
  private async parametersOf(
    prop: ts.PropertyAssignment | undefined,
    sourceFile: ts.SourceFile,
    where: 'path' | 'query'
  ): Promise<NonNullable<OpenAPIRoute['parameters']>> {
    const schema = await this.schemaOf(prop, sourceFile);
    if (!schema) return [];
    const object = schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    if (!object.properties) return [];
    const required = new Set(object.required ?? []);
    return Object.entries(object.properties).map(([name, value]) => ({
      name,
      in: where,
      required: where === 'path' ? true : required.has(name),
      schema: value as Record<string, unknown>,
      description:
        (value as { description?: string }).description ?? `${name} parameter`,
    }));
  }

  /** The declared path parameters that the path actually carries. */
  private async pathParametersOf(
    prop: ts.PropertyAssignment | undefined,
    routePath: string,
    sourceFile: ts.SourceFile
  ): Promise<NonNullable<OpenAPIRoute['parameters']>> {
    const names = new Set(
      [...routePath.matchAll(/\{(\w+)\}/g)].map(match => match[1])
    );
    const declared = await this.parametersOf(prop, sourceFile, 'path');
    for (const parameter of declared)
      if (!names.has(parameter.name)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          prop?.getStart() ?? 0
        );
        console.warn(
          `⚠️  \`params.${parameter.name}\` is not in the path ${routePath} ` +
            `(${path.relative(this.rootDir, sourceFile.fileName)}:${line + 1})`
        );
      }
    return declared.filter(parameter => names.has(parameter.name));
  }

  /** Declared parameters win over the ones read from the path, by name. */
  private mergeParameters(
    base: OpenAPIRoute['parameters'],
    declared: OpenAPIRoute['parameters']
  ): OpenAPIRoute['parameters'] {
    const merged = new Map(
      (base ?? []).map(p => [`${p.in}:${p.name}`, p] as const)
    );
    for (const parameter of declared ?? [])
      merged.set(`${parameter.in}:${parameter.name}`, parameter);
    return merged.size ? [...merged.values()] : undefined;
  }

  private async schemaOf(
    prop: ts.PropertyAssignment | undefined,
    sourceFile: ts.SourceFile
  ): Promise<unknown | undefined> {
    if (!prop) return undefined;
    return this.resolveSchema(prop.initializer, sourceFile);
  }

  /**
   * Read the value of a schema expression.
   *
   * A declared schema is an exported constant — `export const Group =
   * Type.Object(…)` — possibly imported from another module: the generator
   * imports that module and reads the export, rather than running the
   * plugin. The TypeBox value is JSON Schema already; stringifying it drops
   * the TypeBox symbols.
   */
  private async resolveSchema(
    expr: ts.Expression,
    sourceFile: ts.SourceFile
  ): Promise<unknown | undefined> {
    const symbol = this.checker.getSymbolAtLocation(expr);
    const target =
      symbol && symbol.flags & ts.SymbolFlags.Alias
        ? this.checker.getAliasedSymbol(symbol)
        : symbol;
    const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name)
    ) {
      this.warnSchema(expr, sourceFile);
      return undefined;
    }
    const file = declaration.getSourceFile().fileName;
    const module = await this.importModule(file);
    const value = (module as Record<string, unknown>)[declaration.name.text];
    if (value === undefined) {
      this.warnSchema(expr, sourceFile);
      return undefined;
    }
    return JSON.parse(JSON.stringify(value)) as unknown;
  }

  private importModule(file: string): Promise<object> {
    let pending = this.schemaModules.get(file);
    if (!pending) {
      pending = this.loadModule(file);
      this.schemaModules.set(file, pending);
    }
    return pending;
  }

  /**
   * Import a TypeScript module from either kind of caller: the script run by
   * `tsx` loads it itself, where a CJS caller (`tsx/cjs`, as the tests run)
   * needs `tsx`'s importer.
   */
  private loadModule(file: string): Promise<object> {
    const url = pathToFileURL(file).href;
    if (typeof require === 'function') {
      const { tsImport } = require('tsx/esm/api') as {
        tsImport: (specifier: string, parent: string) => Promise<object>;
      };
      return tsImport(url, pathToFileURL(__filename).href);
    }
    return import(url) as Promise<object>;
  }

  private warnSchema(expr: ts.Expression, sourceFile: ts.SourceFile): void {
    const { line } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
    console.warn(
      `⚠️  Cannot read schema \`${expr.getText(sourceFile)}\` ` +
        `(${path.relative(this.rootDir, sourceFile.fileName)}:${line + 1}): ` +
        'declare it as an exported constant'
    );
  }

  private warnUnreadable(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    reason: string
  ): void {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    console.warn(
      `⚠️  Skipping defineRoute ${path.relative(
        this.rootDir,
        sourceFile.fileName
      )}:${line + 1}: ${reason}`
    );
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

    // Only keep JSDoc-style block comments (`/** ... *\/`). Plain `//`
    // line comments above a route are author notes — never directives —
    // and folding them in would let lines like `// Rename group` leak
    // into the YAML body of an `@openapi` block above them.
    const jsdocs = ranges
      .filter(
        range =>
          range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
          fullText.startsWith('/**', range.pos)
      )
      .map(range => fullText.substring(range.pos, range.end));

    // The closest JSDoc block (the last one) is the one annotating this
    // node; older blocks belong to whatever appeared before.
    return jsdocs.length > 0 ? jsdocs[jsdocs.length - 1] : '';
  }

  /**
   * Strip JSDoc comment delimiters and the leading `*` from each line so
   * the remaining text is plain YAML/markdown. Handles both `/** ... *\/`
   * blocks and `// ...` line comments.
   */
  private stripCommentDelimiters(comment: string): string {
    return comment
      .replace(/^\s*\/\*\*?/, '')
      .replace(/\*\/\s*$/, '')
      .split('\n')
      .map(line => line.replace(/^\s*\*\s?/, '').replace(/^\s*\/\/\s?/, ''))
      .join('\n');
  }

  /**
   * Extract every `@openapi`-style block (including `@openapi-component`)
   * from a JSDoc comment. Each match returns the directive name and the
   * YAML body that follows it, up to the next `@`-directive on a fresh
   * line or the end of the comment.
   */
  private extractDirectiveBlocks(comment: string, directive: string): string[] {
    const stripped = this.stripCommentDelimiters(comment);
    const lines = stripped.split('\n');
    const blocks: string[] = [];
    const startRe = new RegExp(`^\\s*@${directive}\\s*$`);
    const anyDirective = /^\s*@[\w-]+(\s|$)/;

    for (let i = 0; i < lines.length; i++) {
      if (!startRe.test(lines[i])) continue;
      const buf: string[] = [];
      let j = i + 1;
      // Drop a single uniform leading indent so YAML alignment survives
      // the JSDoc star prefix being stripped.
      while (j < lines.length && !anyDirective.test(lines[j])) {
        buf.push(lines[j]);
        j++;
      }
      blocks.push(this.dedent(buf.join('\n')));
      i = j - 1;
    }
    return blocks;
  }

  private dedent(text: string): string {
    const lines = text.replace(/\s+$/, '').split('\n');
    let indent = Infinity;
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = line.match(/^( *)/);
      if (m) indent = Math.min(indent, m[1].length);
    }
    if (!isFinite(indent) || indent === 0) return lines.join('\n');
    return lines.map(l => l.slice(indent)).join('\n');
  }

  private parseYamlBlock(block: string, where: string): unknown | undefined {
    if (!block.trim()) return undefined;
    try {
      return yaml.load(block);
    } catch (err) {
      console.warn(
        `⚠️  Failed to parse YAML in ${where}: ${(err as Error).message}`
      );
      return undefined;
    }
  }

  /**
   * Read every `@openapi` block above a route call: returns a partial
   * Operation Object (summary, description, parameters, requestBody,
   * responses, tags, ...) that the generator can deep-merge over its
   * defaults.
   */
  private extractRouteOverrides(
    callExpr: ts.CallExpression,
    sourceFile: ts.SourceFile
  ): Record<string, unknown> {
    const comments = this.getLeadingComments(callExpr, sourceFile);
    if (!comments) return {};
    const blocks = this.extractDirectiveBlocks(comments, 'openapi');
    let merged: Record<string, unknown> = {};
    for (const block of blocks) {
      const parsed = this.parseYamlBlock(
        block,
        `route at ${path.relative(this.rootDir, sourceFile.fileName)}:${
          sourceFile.getLineAndCharacterOfPosition(callExpr.getStart()).line + 1
        }`
      );
      if (parsed && typeof parsed === 'object') {
        merged = this.deepMerge(merged, parsed as Record<string, unknown>);
      }
    }
    return merged;
  }

  /**
   * Walk a source file for `@openapi-component` blocks. Each block is a
   * YAML map of `<SchemaName>: <SchemaDef>` pairs that get merged into
   * `components.schemas`. Looking at the whole file (not just the class)
   * lets contributors group related schemas in a single block at the top.
   */
  private collectComponentsFromFile(sourceFile: ts.SourceFile): void {
    const fullText = sourceFile.getFullText();
    const commentRe = /\/\*\*[\s\S]*?\*\//g;
    let match: RegExpExecArray | null;
    while ((match = commentRe.exec(fullText)) !== null) {
      const blocks = this.extractDirectiveBlocks(match[0], 'openapi-component');
      for (const block of blocks) {
        const parsed = this.parseYamlBlock(
          block,
          `@openapi-component in ${path.relative(this.rootDir, sourceFile.fileName)}`
        );
        if (parsed && typeof parsed === 'object') {
          Object.assign(this.components, parsed as Record<string, unknown>);
        }
      }
    }
  }

  /**
   * Recursively merge `override` over `base`. Arrays are replaced (not
   * concatenated) so route authors retain full control of e.g. the list
   * of `parameters`.
   */
  private deepMerge<T extends Record<string, unknown>>(
    base: T,
    override: Record<string, unknown>
  ): T {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) {
      const existing = out[k];
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        out[k] = this.deepMerge(
          existing as Record<string, unknown>,
          v as Record<string, unknown>
        );
      } else {
        out[k] = v;
      }
    }
    return out as T;
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

    // Build paths. We carry every route property over (via spread) so any
    // OpenAPI Operation Object field provided through `@openapi` (e.g.
    // `security`, `deprecated`, `operationId`) flows through unchanged.
    for (const [, routes] of this.routes) {
      for (const route of routes) {
        if (!spec.paths[route.path]) {
          spec.paths[route.path] = {};
        }
        const {
          method,
          path: _p,
          ...op
        } = route as unknown as Record<string, unknown>;
        spec.paths[route.path][method as string] = op;
      }
    }

    if (Object.keys(this.components).length > 0) {
      spec.components = { schemas: this.components };
    }

    return spec;
  }

  /**
   * Write spec to file
   */
  public writeSpec(outputPath: string): void {
    const spec = this.generateSpec();
    fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2) + '\n', 'utf-8');
    console.log(`✅ OpenAPI spec generated: ${outputPath}`);
    console.log(`   Found ${this.routes.size} plugins`);
    console.log(`   Generated ${Object.keys(spec.paths).length} paths`);
    if (spec.components?.schemas) {
      console.log(
        `   Collected ${Object.keys(spec.components.schemas).length} components`
      );
    }
  }
}

// Main
const main = async (): Promise<void> => {
  console.log('🔍 Analyzing LDAP-Rest plugins...');
  const generator = new OpenAPIGenerator(path.join(__dirname, '..'));
  await generator.analyze();
  generator.writeSpec(path.join(__dirname, '..', 'openapi.json'));
  console.log('✨ Done!');
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
