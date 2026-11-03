/**
 * Load the core without the umbrella's options, as a core-only embedder does.
 * Prints the defaults the host is expected to inject.
 */
import {
  shippedSchemasPath,
  resolveSchemaBase,
} from '@ldap-rest/core/lib/schemaFile';

let schemaError = '';
try {
  resolveSchemaBase('/tmp/plugin.json', 'ldap-rest:twake/users.json');
} catch (error) {
  schemaError = (error as Error).message;
}

console.log(
  JSON.stringify({
    shippedSchemasPath,
    schemaError,
  })
);
