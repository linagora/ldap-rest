/**
 * Refuse a relative specifier without its extension. A consumer resolves the
 * declarations as Node resolves JavaScript, so a specifier without one is a
 * type it silently loses. See docs/development/contracts.md.
 *
 * `import-x/extensions` is not enough: it reads `.options` in
 * `./totp.options` as an extension.
 */
const PUBLISHED_EXTENSIONS = /\.(js|json|css)$/;

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Relative specifiers carry their published extension',
    },
    schema: [],
    messages: {
      extension:
        'A relative specifier needs its extension ({{specifier}}): a nodenext consumer resolves the declarations as Node does (docs/development/contracts.md).',
    },
  },

  create(context) {
    const check = node => {
      const specifier =
        node && typeof node.value === 'string' ? node.value : '';
      if (!/^\.{1,2}\//.test(specifier)) return;
      if (PUBLISHED_EXTENSIONS.test(specifier)) return;
      context.report({
        node,
        messageId: 'extension',
        data: { specifier },
      });
    };

    return {
      ImportDeclaration: node => check(node.source),
      ExportNamedDeclaration: node => check(node.source),
      ExportAllDeclaration: node => check(node.source),
      ImportExpression: node => check(node.source),
    };
  },
};
