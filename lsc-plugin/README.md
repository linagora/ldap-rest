# LSC ldap-rest plugin

A LSC `pluginDestinationService` that translates `LscModifications` into HTTP
calls against the [ldap-rest](https://github.com/linagora/ldap-rest) REST API,
instead of binding directly to LDAP. This way LSC sync benefits from
ldap-rest's ACL, schema validation, audit, and downstream provisioning hooks
(Twake James, Cozy, SCIM, RabbitMQ).

## Status

Standalone plugin shipped alongside ldap-rest while a native
`LdapRestDstService` is being upstreamed into `lsc-project/lsc`.

## Build

```sh
mvn package
```

Produces `target/lsc-ldaprest-plugin-<version>-with-deps.jar` (jar + Jackson
shaded). Drop it into `/usr/lib/lsc/` (or wherever LSC reads its classpath
from in your deployment).

## Configuration

In your LSC `lsc.xml`, declare the destination service:

```xml
<pluginDestinationService implementationClass="org.lscproject.ldaprest.LdapRestDstService">
  <name>ldap-rest-users</name>
  <connection reference="ldap-rest"/>
  <baseUrl>https://ldap-rest.example.org</baseUrl>
  <resourceType>users</resourceType>
  <auth>
    <bearer>${LDAP_REST_TOKEN}</bearer>
    <!-- or, for HMAC:
    <hmacServiceId>lsc</hmacServiceId>
    <hmacSecret>${LDAP_REST_HMAC_SECRET}</hmacSecret>
    -->
  </auth>
  <timeoutMs>10000</timeoutMs>
  <retries>3</retries>
</pluginDestinationService>
```

`<resourceType>` is one of: `users` (or any other flat-resource plural name
declared in ldap-rest), `groups`, `organizations`. One destination service
instance maps to one resource type — declare several services if you sync
several resource families.

## Operation mapping

| LSC operation     | ldap-rest call                                                            |
|-------------------|---------------------------------------------------------------------------|
| CREATE flat       | `POST /api/v1/ldap/{resource}` body `{ <attrs> }`                         |
| UPDATE flat       | `PUT /api/v1/ldap/{resource}/{id}` body `{ add?, replace?, delete? }`     |
| DELETE flat       | `DELETE /api/v1/ldap/{resource}/{id}`                                     |
| MODRDN flat       | `POST /api/v1/ldap/{resource}/{id}/move` body `{ targetOrgDn }`           |
| CREATE group      | `POST /api/v1/ldap/groups`                                                |
| UPDATE group      | `PUT /api/v1/ldap/groups/{cn}` + member POST/DELETE                       |
| DELETE group      | `DELETE /api/v1/ldap/groups/{cn}`                                         |
| RENAME group      | `POST /api/v1/ldap/groups/{cn}/rename` body `{ newCn }`                   |
| CREATE org        | `POST /api/v1/ldap/organizations`                                         |
| UPDATE org        | `PUT /api/v1/ldap/organizations/{dn}`                                     |
| DELETE org        | `DELETE /api/v1/ldap/organizations/{dn}`                                  |
| MODRDN org        | `POST /api/v1/ldap/organizations/{dn}/move`                               |

## Limitations

- Binary attributes (`jpegPhoto`, `userCertificate`) are not synced in this
  version: ldap-rest has no formal JSON convention for them yet. The plugin
  fails fast with a clear error if it encounters one.
- No bulk endpoint: large initial syncs do N HTTP calls. If this hurts,
  ldap-rest will need a bulk endpoint first.

## Tests

- `mvn test` runs the WireMock-based unit tests.
- `test/integration/tests/run.sh` spins up a full Docker stack (OpenLDAP
  source + OpenLDAP target + ldap-rest + LSC with the plugin) and asserts
  end-to-end sync. See `test/integration/README.md`.
