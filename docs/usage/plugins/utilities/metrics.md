# Metrics Plugin

Prometheus metrics of the server, on a port of their own.

## Configuration

```bash
--plugin core/metrics --metrics-port 9464
```

| CLI              | Env               | Default | Description                      |
| ---------------- | ----------------- | ------- | -------------------------------- |
| `--metrics-port` | `DM_METRICS_PORT` | `9464`  | Port `GET /metrics` is served on |

The port is separate from the API's: nothing on it goes through the
authentication, the rate limiting or the request id, so it must not be
reachable from outside the cluster or the host. The Helm chart exposes it
on the Service and to a Prometheus operator with `metrics.enabled` and
`metrics.serviceMonitor.enabled`.

What is measured, and how to read it, is in
[operations](../../operations.md#metrics).
