/**
 * Refuse an import of the LDAP operation internals from a plugin or an
 * abstract base: they use the `ldapActions` façade.
 */
import path from 'node:path';

const INTERNAL = /(?:^|\/)src\/lib\/ldap\//;

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Plugins reach the directory through the ldapActions façade',
    },
    schema: [],
    messages: {
      internal:
        'Use the ldapActions façade (lib/ldapActions): lib/ldap/ is its implementation.',
    },
  },

  create(context) {
    const file = context.physicalFilename;
    if (!/(?:^|\/)src\/(?:plugins|abstract)\//.test(file)) return {};

    const check = (node, source) => {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const target = path.resolve(path.dirname(file), source);
      if (INTERNAL.test(target))
        context.report({ node, messageId: 'internal' });
    };

    return {
      ImportDeclaration: node => check(node, node.source.value),
      ExportNamedDeclaration: node => {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration: node => check(node, node.source.value),
      ImportExpression: node => check(node, node.source?.value),
      TSImportType: node => check(node, node.source?.value),
    };
  },
};
