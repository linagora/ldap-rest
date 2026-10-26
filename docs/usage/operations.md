# Operations

## Health and readiness

Two routes answer outside the API prefix, without authentication, and are
never cached:

| Route          | Answers                                                       |
| -------------- | ------------------------------------------------------------- |
| `GET /healthz` | `200 {"status":"ok"}` as long as the process serves           |
| `GET /readyz`  | `200` when the server can serve, `503` when it cannot (below) |

`/readyz` answers a JSON body:

| `status`      | Code | Meaning                                                                        |
| ------------- | ---- | ------------------------------------------------------------------------------ |
| `starting`    | 503  | The plugins are still loading                                                  |
| `unavailable` | 503  | The directory does not answer a base search of the root entry (`ldap: failed`) |
| `ok`          | 200  | Everything answers                                                             |
| `degraded`    | 200  | The directory answers, a plugin reports a resource of its own down             |

```json
{ "status": "degraded", "ldap": "ok", "plugins": { "rabbitmq": "degraded" } }
```

`plugins` lists the plugins that report their health; `failed` means the
report itself threw. Only the directory takes a replica out of rotation: a
broken outbound service is visible in the body, and the server keeps serving
what does not need it.

The directory is probed at most once every 5 seconds, whatever the number
of probes.

The Helm chart probes both routes over HTTP (`livenessProbe` and
`readinessProbe` in `values.yaml`).

### For plugin authors

A plugin reports its own resources with an optional `health()` method
returning `ok` or `degraded`; it is called on every readiness probe, so it
must answer quickly and never throw for an ordinary outage.
