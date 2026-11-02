/**
 * Refuse an import from another plugin family: see
 * docs/development/modularization-plan.md.
 *
 * `TwakeGroups extends LdapGroups` is the one exception, marked at its
 * import.
 */
import path from 'node:path';

const named = node => {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked;
  return undefined;
};

const familyOf = file => {
  const normalized = file.split(path.sep).join('/');
  const directory =
    /(?:^|\/)src\/plugins\/(auth|ldap|scim|twake|storage)(?:\/|$)/.exec(
      normalized
    );
  if (directory) return directory[1];
  // The storage plugin is a top-level file, not a directory.
  if (
    /(?:^|\/)src\/plugins\/storage(?:\.options)?(?:\.(?:ts|js))?$/.test(
      normalized
    )
  )
    return 'storage';
  if (/(?:^|\/)src\/plugins\//.test(normalized)) return 'misc';
  return undefined;
};

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'A plugin family depends on no other plugin family',
    },
    schema: [],
    messages: {
      family:
        'A plugin family depends on no other family (docs/plugin-development/services.md): use a service instead of importing {{to}} from {{from}}.',
    },
  },

  create(context) {
    const file = context.physicalFilename;
    const own = familyOf(file);
    if (!own) return {};

    const check = (node, source) => {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const target = path.resolve(path.dirname(file), source);
      const other = familyOf(target);
      if (!other || other === own) return;
      context.report({
        node,
        messageId: 'family',
        data: { from: own, to: other },
      });
    };

    return {
      ImportDeclaration: node => check(node, node.source.value),
      ExportNamedDeclaration: node => {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration: node => check(node, node.source.value),
      ImportExpression: node => check(node, named(node.source)),
      TSImportType: node => check(node, named(node.source)),
    };
  },
};
