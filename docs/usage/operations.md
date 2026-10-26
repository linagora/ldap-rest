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
most. The probe reads the root DSE, which any bound account may: a wrong
`--ldap-base` is not what it reports. The directory is probed on a connection of its own, bound as the
server, outside the connection pool and the search cache. One answer serves
5 seconds whatever the number of probes; the probes arriving meanwhile
share it.

Both routes are served before the authentication and the rate limiting,
and `/readyz` names the loaded plugins that report: on an ingress exposing
the server to the internet, keep the two paths to the cluster.

The Helm chart probes both routes over HTTP (`livenessProbe` and
`readinessProbe` in `values.yaml`).

### What the shipped plugins report

| Plugin     | `degraded` when                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`  | the backend refuses a `SELECT 1` or a `PING`, or the `file` backend's directory is not a directory this user may write in; the `ldap` backend has no answer of its own, the directory check above covers it |
| `rabbitmq` | a broker is configured and no connection to it stands: until the first publish or subscription opens one, and while the client reconnects                                                                   |
| `james`    | James answers its `GET /healthcheck` with 503, one of its own checks unhealthy, or not within 1.5 s; a James whose checks are only degraded answers 200, so `ok` here                                       |

A check that leaves the probe to time out reads as `failed`.

### For plugin authors

A plugin reports its own resources with an optional `health()` method
returning `ok` or `degraded`, called at most once every 5 seconds; it must
answer within 2 s and never throw for an ordinary outage. The probe stops
waiting at 2 s but cancels nothing: a plugin bounds its own call, as
`james` does with its 1.5 s.

## Request id

Every answer the server serves carries an `X-Request-Id` header: an
identifier the server generates for the request, the same one its writes
hand to the plugins and its log lines carry. An `X-Request-Id` the client sends is not taken: a
caller could otherwise make the writes of two requests look like one.

A proxy or an ingress generating an identifier of its own does not pass
it on either: log the answer's `X-Request-Id` there to match its lines with
the server's.

Every line logged while a request is served carries `requestId`, the lines
of the hooks it ran included, as a field of the JSON console output and as
`[<id>]` after the level in the log file. The line of `core/weblogs` carries
it too. A line without one was written outside any request: at startup, by
a scheduled task, by a message consumer, by a connection the server keeps.
Work shared between requests, a schema load or a readiness answer, logs
under the request that started it.
