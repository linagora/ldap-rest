# ldap-rest Helm chart

Deploys [ldap-rest](https://github.com/linagora/ldap-rest), a REST/SCIM API
server that sits in front of an LDAP directory.

The chart is published as an OCI artifact on each release tag.

## Install

```bash
# Latest release
helm install ldap-rest oci://ghcr.io/linagora/charts/ldap-rest

# A specific version
helm install ldap-rest oci://ghcr.io/linagora/charts/ldap-rest --version 0.4.5

# With your own values
helm install ldap-rest oci://ghcr.io/linagora/charts/ldap-rest -f my-values.yaml
```

## Configuration

ldap-rest is configured entirely through `DM_*` environment variables. Pass
non-secret ones via `env` and sensitive ones via `secrets` (both are plain
Kubernetes env lists):

```yaml
image:
  # ghcr.io/linagora/ldap-rest (default) or docker.io/yadd/ldap-rest
  repository: ghcr.io/linagora/ldap-rest
  tag: ""            # defaults to the chart appVersion

service:
  port: 8081         # keep in sync with DM_PORT if you override it

env:
  - name: DM_LDAP_URL
    value: "ldap://openldap"
  - name: DM_LDAP_BASE
    value: "dc=example,dc=com"
  - name: DM_PLUGINS
    value: "core/static,core/ldap/flatGeneric"

secrets:
  - name: DM_LDAP_PWD
    valueFrom:
      secretKeyRef:
        name: ldap-rest-secrets
        key: DM_LDAP_PWD
```

### Key values

| Key | Default | Description |
|-----|---------|-------------|
| `replicaCount` | `1` | Number of pods (stateless, scalable). |
| `image.repository` | `ghcr.io/linagora/ldap-rest` | Image repository. |
| `image.tag` | `""` | Image tag; defaults to chart `appVersion`. |
| `service.type` / `service.port` | `ClusterIP` / `8081` | Service exposure. `port` is also the container port. |
| `ingress.enabled` | `false` | Enable an Ingress. |
| `env` | `[]` | Plain `DM_*` env vars (list of `{name, value}`). |
| `secrets` | `[]` | Sensitive env vars (list, prefer `valueFrom.secretKeyRef`). |
| `externalFileConfig` | `""` | Inline JS plugin mounted at `/app/external/cnb-plugin.js`. |
| `resources` | see `values.yaml` | CPU/memory requests and limits. |
| `livenessProbe` / `readinessProbe` | TCP on `http` | Probes (no HTTP health route exists; `{}` disables). |

See [`values.yaml`](./values.yaml) for the full list.

> No dedicated HTTP health endpoint exists, so the probes use a TCP check on the
> listen port.
