/**
 * Refuse `loadedPlugins` and `requirePlugin` in a plugin: see
 * docs/plugin-development/services.md.
 */
const named = node => {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked;
  return undefined;
};

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reach another plugin through its service instead of server.loadedPlugins',
    },
    schema: [],
    messages: {
      loadedPlugins:
        'Reach another plugin through its service (docs/plugin-development/services.md): server.loadedPlugins is a string-keyed registry.',
      requirePlugin:
        'Reach another plugin through its service (docs/plugin-development/services.md): requirePlugin is for third-party plugins, not core ones.',
    },
  },

  create(context) {
    return {
      MemberExpression(node) {
        if (named(node.property) !== 'loadedPlugins') return;
        context.report({ node, messageId: 'loadedPlugins' });
      },
      Property(node) {
        if (node.parent?.type !== 'ObjectPattern') return;
        if (named(node.key) !== 'loadedPlugins') return;
        context.report({ node: node.key, messageId: 'loadedPlugins' });
      },
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return;
        if (named(node.callee.property) !== 'requirePlugin') return;
        context.report({ node, messageId: 'requirePlugin' });
      },
    };
  },
};
