# Operations

## Health and readiness

Two routes answer outside the API prefix, without authentication, and are
never cached:

| Route          | Answers                                                       |
| -------------- | ------------------------------------------------------------- |
| `GET /healthz` | `200 {"status":"ok"}` as long as the process serves           |
| `GET /readyz`  | `200` when the server can serve, `503` when it cannot (below) |

`/readyz` answers a JSON body:

| `status`      | Code | Meaning                                                                                                |
| ------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `starting`    | 503  | The plugins are still loading (a host serving before `ready`; the shipped binary opens the port after) |
| `unavailable` | 503  | The directory does not answer a read of its root DSE in 2 s (`ldap: failed`)                           |
| `ok`          | 200  | Everything answers                                                                                     |
| `degraded`    | 200  | The directory answers, a plugin reports a resource of its own down                                     |

```json
{ "status": "degraded", "ldap": "ok", "plugins": { "rabbitmq": "degraded" } }
```

`plugins` lists the plugins that report their health; `failed` means the
report threw or did not answer in time. Only the directory takes a replica
out of rotation: a broken outbound service is visible in the body, and the
server keeps serving what does not need it.

The directory and the plugins are asked at once, so the answer takes 2 s at
most. The directory is probed on a connection of its own, bound as the
server, outside the connection pool and the search cache. One answer serves
5 seconds whatever the number of probes; the probes arriving meanwhile
share it.

Both routes are served before the authentication and the rate limiting,
and `/readyz` names the loaded plugins that report: on an ingress exposing
the server to the internet, keep the two paths to the cluster.

The Helm chart probes both routes over HTTP (`livenessProbe` and
`readinessProbe` in `values.yaml`).

### For plugin authors

A plugin reports its own resources with an optional `health()` method
returning `ok` or `degraded`, called at most once every 5 seconds; it must
answer within 2 s and never throw for an ordinary outage.
