# Fake Authentication

For development only: every request is served as the identity given on the
command line, without asking for anything. Restarting with another
`--auth-fake-user` shows an interface as another administrator sees it.

```bash
npx ldap-rest \
  --plugin core/auth/fake --auth-fake-user alice \
  --plugin core/auth/authzLinid1 \
  ...
```

**Environment Variable:** `DM_AUTH_FAKE_USER=alice`

The identity goes to `req.user` and `req.userName` alike, so the
authorization plugins judge it as they would the same login coming from a
real authenticator.

## Safeguards

- The server refuses to start when `NODE_ENV` is `production`, as it is in
  the Docker image.
- It refuses to start without `--auth-fake-user`.
- A warning naming the identity is logged at every start.

Loaded without an authorization plugin, it grants everything to anyone who
reaches the port. Listen on a local address only.
