# Web Logs Plugin

HTTP request logging middleware for debugging and monitoring.

## Overview

The `weblogs` plugin logs all incoming HTTP requests and responses with timing information, status codes, and authenticated user details.

## Configuration

```bash
--plugin core/weblogs
```

No additional configuration required.

## Log Output

### Request Logging

Each request is logged when it arrives:

```
[debug] Incoming request: GET /api/v1/ldap/users
```

### Response Logging

Each response is logged when completed:

```json
{
  "level": "info",
  "message": "GET /api/v1/ldap/users 200 45ms",
  "user": "admin",
  "method": "GET",
  "url": "/api/v1/ldap/users",
  "status": 200,
  "responseTime": "45ms"
}
```

## Log Fields

| Field          | Description                     | Example                           |
| -------------- | ------------------------------- | --------------------------------- |
| `message`      | Summary line                    | `GET /api/v1/ldap/users 200 45ms` |
| `user`         | Authenticated user (if any)     | `admin`                           |
| `method`       | HTTP method                     | `GET`, `POST`, `PUT`, `DELETE`    |
| `url`          | Full URL including query params | `/api/v1/ldap/users?match=*`      |
| `status`       | HTTP status code                | `200`, `404`, `500`               |
| `responseTime` | Request duration                | `45ms`, `123ms`                   |
| `error`        | Error message (if applicable)   | `Connection timeout`              |

## Use Cases

### 1. Request Monitoring

Track all API usage:

```bash
--plugin core/weblogs \
--log-level info
```

Output:

```
[info] POST /api/v1/ldap/users 201 123ms {"user":"admin"}
[info] GET /api/v1/ldap/users/jdoe 200 23ms {"user":"admin"}
[info] PUT /api/v1/ldap/users/jdoe 200 89ms {"user":"admin"}
[info] DELETE /api/v1/ldap/users/test 200 45ms {"user":"admin"}
```

### 2. Performance Analysis

Identify slow endpoints:

```bash
--plugin core/weblogs \
--log-level info | grep -E '[0-9]{3,}ms'
```

Shows requests taking >100ms:

```
[info] GET /api/v1/ldap/organizations/top 200 345ms
[info] POST /api/v1/ldap/users 201 523ms
```

### 3. Security Auditing

Track who accesses what:

```bash
--plugin core/auth/token \
--plugin core/weblogs
```

Output:

```json
{
  "level": "info",
  "message": "DELETE /api/v1/ldap/users/jdoe 200 45ms",
  "user": "admin",
  "method": "DELETE",
  "url": "/api/v1/ldap/users/jdoe"
}
```

### 4. Error Tracking

Monitor failed requests:

```bash
--plugin core/weblogs | grep -E ' (4|5)[0-9]{2} '
```

Shows 4xx and 5xx responses:

```
[info] GET /api/v1/ldap/users/notfound 404 12ms
[info] POST /api/v1/ldap/users 400 8ms {"error":"Missing required field: cn"}
[info] GET /api/v1/ldap/users 500 234ms {"error":"LDAP connection timeout"}
```

## Integration

### With Authentication Plugins

```bash
--plugin core/auth/token \
--plugin core/weblogs \
--auth-token "secret-token"
```

Logs include authenticated user:

```json
{
  "user": "token number 0",
  "message": "GET /api/v1/ldap/users 200 45ms"
}
```

### With Authorization Plugin

```bash
--plugin core/auth/token \
--plugin core/auth/authzPerBranch \
--plugin core/weblogs
```

Track authorization failures:

```json
{
  "user": "limited_user",
  "message": "GET /api/v1/ldap/users 403 5ms",
  "error": "User does not have read permission"
}
```

## Log Levels

Configure log level to control verbosity:

```bash
--log-level debug  # All requests + debug info
--log-level info   # Completed requests only
--log-level warn   # Only warnings and errors
--log-level error  # Only errors
```

### Debug Level

```bash
--plugin core/weblogs \
--log-level debug
```

Output:

```
[debug] Incoming request: POST /api/v1/ldap/users
[debug] Request body: {"uid":"newuser","cn":"New User",...}
[info] POST /api/v1/ldap/users 201 123ms
```

### Info Level

```bash
--plugin core/weblogs \
--log-level info
```

Output:

```
[info] POST /api/v1/ldap/users 201 123ms {"user":"admin"}
[info] GET /api/v1/ldap/users 200 45ms {"user":"admin"}
```

## Event Handling

The plugin logs three types of events:

### 1. Normal Completion

Request completes successfully:

```javascript
res.on('finish', () => {
  // Log: "GET /api/v1/ldap/users 200 45ms"
});
```

### 2. Response Error

Error occurs during response:

```javascript
res.on('error', err => {
  // Log: "GET /api/v1/ldap/users 500 234ms" {"error":"Connection timeout"}
});
```

### 3. Connection Closed

Client closes connection before response:

```javascript
res.on('close', () => {
  // Log: "GET /api/v1/ldap/users - - {"error":"Connection closed before response was sent"}
});
```

## Log Parsing

### JSON Format

Logs are in JSON format for easy parsing:

```bash
cat app.log | jq 'select(.status >= 400)'
```

Filters 4xx and 5xx responses:

```json
{
  "level": "info",
  "message": "GET /api/v1/ldap/users/notfound 404 12ms",
  "status": 404,
  "method": "GET",
  "url": "/api/v1/ldap/users/notfound"
}
```

### Statistics

Generate request statistics:

```bash
cat app.log | jq -r '.message' | awk '{print $1}' | sort | uniq -c
```

Output:

```
  45 DELETE
 123 GET
  67 POST
  34 PUT
```

### Response Time Analysis

Average response time per endpoint:

```bash
cat app.log | jq -r 'select(.responseTime) | "\(.url) \(.responseTime)"' | \
  sed 's/ms$//' | \
  awk '{sum[$1]+=$2; count[$1]++} END {for (url in sum) print url, sum[url]/count[url] "ms"}'
```

## Performance Impact

The weblogs plugin adds minimal overhead:

- **Request logging**: ~0.1ms
- **Response logging**: ~0.5ms
- **Total overhead**: <1ms per request

For high-traffic deployments:

1. Use `--log-level warn` to reduce logging
2. Log to file instead of console
3. Use log aggregation service

## Log Rotation

Configure log rotation using environment or external tools:

### Using Winston File Transport

```bash
--log-file ./logs/mini-dm.log \
--log-max-size 10485760 \    # 10MB
--log-max-files 5
```

### Using logrotate (Linux)

```
/var/log/mini-dm/*.log {
    daily
    rotate 7
    compress
    delaycompress
    notifempty
    create 0640 mini-dm mini-dm
    sharedscripts
    postrotate
        systemctl reload mini-dm
    endscript
}
```

## Troubleshooting

### Problem: No Logs Appearing

**Solutions:**

1. Ensure plugin is loaded:

   ```bash
   --plugin core/weblogs
   ```

2. Check log level:

   ```bash
   --log-level info  # or debug
   ```

3. Verify logs go to stdout/stderr:
   ```bash
   mini-dm --plugin core/weblogs 2>&1 | tee app.log
   ```

### Problem: Too Many Logs

**Solutions:**

1. Increase log level:

   ```bash
   --log-level warn  # Only warnings and errors
   ```

2. Filter specific endpoints:

   ```bash
   mini-dm --plugin core/weblogs 2>&1 | grep -v '/health'
   ```

3. Use log aggregation with filtering

### Problem: User Field Empty

**Symptoms:**

```json
{ "message": "GET /api/v1/ldap/users 200 45ms" }
```

No `user` field in logs.

**Solutions:**

1. Enable authentication plugin:

   ```bash
   --plugin core/auth/token \
   --plugin core/weblogs
   ```

2. Verify authentication is working:
   ```bash
   curl -H "Authorization: Bearer token" http://localhost:8081/api/v1/ldap/users
   ```

## See Also

- [Authentication Plugins](authentication.md) - User authentication
- [Winston Logger](https://github.com/winstonjs/winston) - Logging library used
