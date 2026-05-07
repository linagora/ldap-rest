# Integration test for lsc-ldaprest-plugin

End-to-end test: a real LSC binary syncs entries from a source OpenLDAP
instance to ldap-rest (which writes them into a target OpenLDAP), through the
plugin under test. No mocks.

## Stack

| Service       | Image                          | Role                                      |
|---------------|--------------------------------|-------------------------------------------|
| `ldap-source` | `osixia/openldap:1.5.0`        | LDAP source seeded from `ldif/source-seed.ldif` |
| `ldap-target` | `osixia/openldap:1.5.0`        | Empty LDAP target written by ldap-rest    |
| `ldap-rest`   | built from `../../../Dockerfile` | ldap-rest service, Bearer auth, `/api/v1/ldap/...` |
| `lsc`         | built from `Dockerfile.lsc`    | LSC v2.2 + plugin jar in classpath        |

## Run

```sh
cd lsc-plugin/test/integration
./tests/run.sh
```

The first run downloads images and builds three containers, including LSC
from source — count 5–10 minutes. Subsequent runs are much faster.

Container logs are dumped to `logs/` after each run. The compose stack is
torn down (volumes wiped) on exit, success or failure.

## Scenarios

1. **CREATE** — first sync of 5 users from source. Asserts:
   - `GET /api/v1/ldap/users` returns 5 entries
   - `GET /api/v1/ldap/users/alice` matches the source attributes
   - direct `ldapsearch` on `ldap-target` finds alice (proves ldap-rest
     actually wrote LDAP, not just acked)

2. **UPDATE** — modify alice's `mail` in the source, re-sync. Asserts the
   change propagated through the plugin's PUT `replace` translation.

3. **DELETE** — remove eve from the source, re-sync. Asserts
   `GET /users/eve` returns 404.

Future additions: groups CRUD, organizations CRUD, RENAME (modrdn), HMAC
auth variant.

## Notes

- The plugin's `<connection>` reference (`dst-ldap-rest-stub`) points to
  ldap-target only to satisfy LSC schema validation. The plugin ignores this
  binding at runtime and uses `<baseUrl>` + Bearer token instead.
- `DM_AUTHZ_PER_BRANCH_CONFIG` is wide-open in this test env. Production
  setups should scope writes to the LSC sync subtree.
