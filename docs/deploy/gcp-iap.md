---
title: Google Cloud IAP
summary: Use Google Cloud Identity-Aware Proxy as the only browser sign-in for an authenticated deployment
---

Use this mode when the server runs behind [Google Cloud Identity-Aware Proxy (IAP)](https://cloud.google.com/iap/docs/concepts-overview),
for example a Cloud Run reverse proxy that IAP protects and that forwards requests,
including the `x-goog-iap-jwt-assertion` header, to the server.

In this mode IAP is the source of browser identity:

- Every browser request is checked for a valid IAP assertion. The assertion is an
  ES256 JWT that is verified against Google's public keys
  (`https://www.gstatic.com/iap/verify/public_key-jwk`, cached), with issuer
  `https://cloud.google.com/iap`, an exact audience match, and `exp`/`iat` checked
  with a 30 second clock skew.
- The email in the assertion must belong to the allowed domain (the `hd` claim or the
  email suffix).
- The server finds or creates the user by email (the display name comes from the
  email), then creates a normal session cookie, so the rest of the app works as usual.
- If the browser already has a session for a different email, the server revokes it
  and creates a session for the IAP identity. The identity always follows IAP.
- A request without a valid assertion gets no browser session, even if it has a
  session cookie.
- Password sign-up and sign-in are turned off (the `/api/auth/sign-in/email` and
  `/api/auth/sign-up/email` endpoints are not registered), and the sign-in page shows
  a "signed out" state instead of a form.

Agent and API authentication does not change. Agent JWTs, agent API keys, board API
keys (`Authorization: Bearer ...`), and CLI tokens never use the IAP path.

## Configure

IAP mode requires `PAPERCLIP_DEPLOYMENT_MODE=authenticated` (the production image default).

| Variable | Required | Example | Meaning |
| --- | --- | --- | --- |
| `PAPERCLIP_AUTH_PROVIDER` | yes | `gcp-iap` | Turns IAP mode on. Any other value keeps password sign-in. |
| `PAPERCLIP_IAP_AUDIENCE` | yes | `/projects/123456789/locations/us-central1/services/dixie-console` | The expected `aud` claim. For Cloud Run IAP use `/projects/<PROJECT_NUMBER>/locations/<REGION>/services/<SERVICE>`; for a load balancer backend use `/projects/<PROJECT_NUMBER>/global/backendServices/<ID>`. |
| `PAPERCLIP_IAP_ALLOWED_DOMAIN` | yes | `mindsethealth.com` | Only emails in this Google Workspace domain can sign in. |
| `PAPERCLIP_IAP_ADMIN_EMAILS` | no | `simon.raik-allen@mindsethealth.com,ops@mindsethealth.com` | Comma-separated emails that become instance admins when they sign in. |
| `PAPERCLIP_IAP_JWKS_URL` | no | | Overrides the key URL, for tests only. |
| `PAPERCLIP_IAP_CLOCK_TOLERANCE_SECONDS` | no | `30` | Clock skew allowed for `exp` and `iat`. |

The server refuses to start when `PAPERCLIP_AUTH_PROVIDER=gcp-iap` is set without
`PAPERCLIP_IAP_AUDIENCE` and `PAPERCLIP_IAP_ALLOWED_DOMAIN`.

Put the server where only IAP can reach it (for example Cloud Run ingress `internal`
behind the IAP-protected proxy). The assertion is signed, so a forged header is
rejected, but direct access would still expose the API to bearer-token clients.

## Admins and company membership

IAP mode replaces the board-claim flow. No claim URL is printed at startup.

- A user listed in `PAPERCLIP_IAP_ADMIN_EMAILS` becomes an instance admin when they
  sign in. The implicit `local-board` admin is then removed, the same way a
  successful board claim removes it. Removing an email from the list does not revoke
  the admin role. Revoke it in the UI.
- Each new session makes sure that the user is an active member of every existing
  company: admins join as `owner`, everyone else as `operator`, with the default
  permission grants for that role. Existing memberships are not changed, so a role
  change or a suspension made in the UI stays in place. Companies that are created
  later are added at the user's next session (sessions last 7 days, or sign out and
  sign in again).

## Sign-out

Sign-out deletes the session and sets a short-lived `iap_signed_out` cookie. While
that cookie is present, the server does not create a session from IAP, so the
browser does not loop back in. The sign-in page shows **Sign in again**, which goes
to `/api/auth/gcp-iap/resume` (this clears the cookie and returns to the app), and
**Use a different Google account**, which asks IAP to clear its own login cookie
(`?gcp-iap-mode=CLEAR_LOGIN_COOKIE`).

## Headless admin bootstrap (release automation)

With IAP mode there is no browser on the server and no password sign-in. Release
automation can get a board API key for an admin with a command that runs inside the
production image and connects to `DATABASE_URL` directly:

```sh
docker run --rm \
  -e DATABASE_URL \
  -e PAPERCLIP_AUTH_PROVIDER=gcp-iap \
  -e PAPERCLIP_IAP_AUDIENCE \
  -e PAPERCLIP_IAP_ALLOWED_DOMAIN=mindsethealth.com \
  -e PAPERCLIP_IAP_ADMIN_EMAILS=simon.raik-allen@mindsethealth.com \
  <image> \
  node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/auth/gcp-iap-bootstrap-admin.js \
    --email simon.raik-allen@mindsethealth.com --key-name dixie-release --json
```

As a Cloud Run job, use the same image with the command
`node` and the arguments
`--import ./server/node_modules/tsx/dist/loader.mjs server/dist/auth/gcp-iap-bootstrap-admin.js --email ... --key-name dixie-release --json`.
Note that Cloud Run job logs capture stdout, so read the token there only if that
log is protected as a secret, or prefer `docker run` from a trusted runner.

The command:

1. Checks that the email is in `PAPERCLIP_IAP_ALLOWED_DOMAIN` and in `PAPERCLIP_IAP_ADMIN_EMAILS`.
2. Finds or creates the user (the same provisioning as an IAP sign-in), makes them
   an instance admin, and adds missing company memberships.
3. Creates a board API key through the normal board API key service (same hashing,
   30-day default expiry, and `board_api_key.created` activity entry as
   `POST /api/board-api-keys`).
4. Prints the result once on stdout. Logging is silenced so stdout holds only the
   result; errors go to stderr with a non-zero exit code.

Output with `--json`:

```json
{"userId":"...","email":"simon.raik-allen@mindsethealth.com","userCreated":false,"isInstanceAdmin":true,"membershipsCreated":0,"key":{"id":"...","name":"dixie-release","token":"pcp_board_...","expiresAt":"2026-11-15T00:00:00.000Z"}}
```

Without `--json` it prints only the token. Options: `--expires-days <n>` sets the key
lifetime, and `--no-expiry` creates a key that does not expire. Running the command again is
safe. Each run creates a new key. Revoke old keys with
`DELETE /api/board-api-keys/<id>` or in the UI.

Use the key as `Authorization: Bearer <token>` against the REST API. Bearer requests
skip IAP session handling. They still must reach the server, so call it from inside
the network or through a path that IAP allows for service accounts.
