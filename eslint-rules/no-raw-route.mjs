/**
 * Refuse `app.<verb>(` in a plugin or an abstract base: a route is declared
 * with `defineRoute`, which validates its inputs and feeds the OpenAPI
 * document (docs/plugin-development/routes.md).
 *
 * The files still to migrate are listed in `route-allowlist.json`; remove a
 * file from it as its routes move.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const routeAllowlist = JSON.parse(
  readFileSync(path.join(here, 'route-allowlist.json'), 'utf8')
);

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Declare routes with defineRoute instead of app.<verb>(path, handler)',
    },
    schema: [],
    messages: {
      rawRoute:
        'Declare the route with defineRoute (docs/plugin-development/routes.md): app.{{method}}(…) is not in the OpenAPI document and checks no input.',
    },
  },

  create(context) {
    const file = path
      .relative(process.cwd(), context.physicalFilename)
      .split(path.sep)
      .join('/');
    if (routeAllowlist.includes(file)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'app' ||
          callee.property.type !== 'Identifier' ||
          !VERBS.has(callee.property.name)
        )
          return;
        context.report({
          node,
          messageId: 'rawRoute',
          data: { method: callee.property.name },
        });
      },
    };
  },
};
