/**
 * Refuse a cast on a configuration value in a plugin: declare the option and
 * read it through `this.options()` instead. See
 * docs/plugin-development/options.md.
 *
 * Catches `this.config.<name> as …`, `server.config.<name> as …`, the same
 * through `const configuration = this.config`, and a type assertion on either
 * side of the member access.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Read plugin options through this.options() rather than casting this.config',
    },
    schema: [],
    messages: {
      configCast:
        'Declare the option and read it through this.options() (docs/plugin-development/options.md): this.config.{{name}} as … hides a misspelt key.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    const isConfigAccess = node =>
      node &&
      node.type === 'MemberExpression' &&
      !node.computed &&
      node.property.type === 'Identifier' &&
      node.property.name === 'config' &&
      (node.object.type === 'ThisExpression' ||
        (node.object.type === 'Identifier' && node.object.name === 'server'));

    const aliases = new Set();
    const collect = node => {
      if (
        node.type === 'VariableDeclarator' &&
        node.id.type === 'Identifier' &&
        node.init &&
        isConfigAccess(node.init)
      )
        aliases.add(node.id.name);
      for (const [key, value] of Object.entries(node)) {
        if (key === 'parent') continue;
        if (Array.isArray(value))
          value.forEach(child => child?.type && collect(child));
        else if (value?.type) collect(value);
      }
    };
    collect(sourceCode.ast);

    const isConfigHolder = node =>
      node.type === 'ThisExpression' ||
      (node.type === 'MemberExpression' &&
        !node.computed &&
        node.property.type === 'Identifier' &&
        node.property.name === 'server' &&
        node.object.type === 'ThisExpression') ||
      (node.type === 'Identifier' &&
        (node.name === 'server' || aliases.has(node.name)));

    const configName = node => {
      if (node.type !== 'MemberExpression') return undefined;
      // A computed key (`this.config[key]`) is outside the rule: the key is
      // not a misspelt literal at the access.
      if (node.computed) return undefined;
      const holder = node.object;
      // this.config.<name> / server.config.<name> / alias.<name>
      if (
        holder.type === 'MemberExpression' &&
        !holder.computed &&
        holder.property.type === 'Identifier' &&
        holder.property.name === 'config' &&
        isConfigHolder(holder.object) &&
        node.property.type === 'Identifier'
      )
        return node.property.name;
      // A variable holding this.config
      if (
        holder.type === 'Identifier' &&
        aliases.has(holder.name) &&
        node.property.type === 'Identifier'
      )
        return node.property.name;
      // (this.config as X).<name> / (<number>this.config).<name>
      if (
        (holder.type === 'TSAsExpression' ||
          holder.type === 'TSTypeAssertion') &&
        isConfigAccess(holder.expression) &&
        node.property.type === 'Identifier'
      )
        return node.property.name;
      // this.config as X, or (this.config as X).<name>
      if (isConfigAccess(node)) {
        const parent = node.parent;
        if (
          parent?.type === 'MemberExpression' &&
          parent.object === node &&
          !parent.computed &&
          parent.property.type === 'Identifier'
        )
          return parent.property.name;
        return 'config';
      }
      return undefined;
    };

    const check = node => {
      const expression = node.expression;
      // `(this.config as X).name as Y` was already reported on the inner cast
      if (
        expression.type === 'MemberExpression' &&
        !expression.computed &&
        (expression.object.type === 'TSAsExpression' ||
          expression.object.type === 'TSTypeAssertion') &&
        isConfigAccess(expression.object.expression)
      )
        return;
      const parent = node.parent;
      const name =
        isConfigAccess(expression) &&
        parent?.type === 'MemberExpression' &&
        parent.object === node &&
        !parent.computed &&
        parent.property.type === 'Identifier'
          ? parent.property.name
          : configName(expression);
      if (name === undefined) return;
      context.report({
        node,
        messageId: 'configCast',
        data: { name },
      });
    };

    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};
