# Example deployment configuration

These schemas show what a concrete deployment looks like once every
client-specific value has been moved out of the code: national phone and
postal-code formats, the mail domain accounts must belong to, the payroll
number format and the placeholder that exempts a value from its uniqueness
check, the mailbox quota default, and the naming rules the directory already
enforces on its existing data.

They are **not** part of the product. Nothing in `src/` refers to them, and the
`npm run check:no-client-values` guard makes sure nothing ever does. Copy the
directory, replace the patterns and the domains, and the core serves another
directory unchanged.

Each `test` carries the `hint` that explains it, so a client can show the
expected format under the field instead of only rejecting what was typed.

Point a server at them with:

```sh
node bin/index.mjs \
  --ldap-base dc=example,dc=org \
  --ldap-top-organization ou=organization,dc=example,dc=org \
  --ldap-group-base ou=lists,ou=groups,dc=example,dc=org \
  --group-schema static/schemas/example/groups.json \
  --organization-schema static/schemas/example/organizations.json \
  --ldap-flat-schema static/schemas/example/users.json \
  --ldap-flat-schema static/schemas/example/positions.json \
  --ldap-flat-schema static/schemas/example/nomenclature/domains.json \
  --plugin core/ldap/flatGeneric \
  --plugin core/ldap/groups \
  --plugin core/ldap/organizations \
  --plugin core/ldap/enterpriseRules \
  --plugin core/ldap/accountLifecycle \
  --plugin core/auth/authzScope
```
