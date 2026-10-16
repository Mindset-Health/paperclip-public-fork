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
| `PAPERCLIP_IAP_MEMBER_GRANTS` | no | `agents:create,tasks:assign` | Comma-separated permission keys granted explicitly to every non-admin `operator` member. Unknown keys stop the server from starting. |
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
- With `PAPERCLIP_IAP_MEMBER_GRANTS`, each new session also gives a non-admin member
  those explicit grants in every company where they are an active `operator`. This
  backfills existing members at their next session. Viewers, suspended members,
  owners and admins are not changed. Removing a key from the variable does not
  revoke grants that were already given. Revoke them in the UI.

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

## Member agents and connections

Use these variables to let every employee create agents while administrators keep
control of runtimes, models, credentials, environments and connections. They work
in any authentication mode, but they are designed for IAP mode. All of them are
off by default, and the server then behaves like upstream Paperclip.

A *member* is a signed-in board user who does not have a company-wide
`agents:configure` grant. Owners, admins, instance admins and the local implicit
board are never restricted. Agent API keys are not changed.

| Variable | Example | Meaning |
| --- | --- | --- |
| `PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE` | `true` | The server records who created each new agent (`metadata.createdByUserId`, always taken from the signed-in user). The creator can then configure, edit instructions for, pause, resume, terminate and delete that agent. The creator cannot change other people's agents: when this is on, the agent-scoped routes (pause, resume, terminate, delete, keys, permissions, runtime state, Claude login) also need configure rights on that agent, not only `agents:create`. |
| `PAPERCLIP_MEMBER_ADAPTER_ALLOWLIST` | `dixie_hermes,claude_local,codex_local,gemini_local,opencode_local` | Runtimes that members can create, update and test. Other runtimes (for example `process`, `http`, `hermes_local`, `openclaw_gateway`) are rejected with `member_adapter_not_allowed`, and the adapter pickers do not show them to members. |
| `PAPERCLIP_MEMBER_DEFAULT_ENVIRONMENT_NAME` | `Runner runner-1` | Members' local CLI agents (`*_local`) always use this environment. Any other environment is rejected. The Local environment is rejected for every runtime. If the environment is missing, inactive or uses the `local` driver, member requests fail with an error instead of falling back. |
| `PAPERCLIP_MEMBER_ADAPTER_DEFAULTS` | see below | JSON map of runtime to an `adapterConfig` fragment. Members can set only the allowed keys (next row). Everything else, including `env`, commands, URLs and providers, comes from this fragment. A binding `{"type":"secret_ref","secretKey":"anthropic_api_key"}` resolves to the company secret with that key. |
| `PAPERCLIP_MEMBER_MODEL_ALLOWLIST` | see below | JSON map of runtime to approved models. An entry is a model id or `{"id": "...", "label": "...", "adapterConfig": {...}}`. The entry's `adapterConfig` is applied when a member chooses that model, so an administrator can set the provider for each model. Other models are rejected with `member_model_not_allowed`, and the model picker lists only these. If a member does not choose a model, the default model or the first entry is used. |
| `PAPERCLIP_MEMBER_ADAPTER_CONFIG_KEYS` | `model,effort,modelReasoningEffort,toolsets` | The `adapterConfig` keys that members can set. The default is `model`, `effort`, `thinkingEffort`, `modelReasoningEffort`, `reasoningEffort`, `variant`, `fastMode`, `search`, `toolsets`, `capabilities`, `description`, `instructions`, `systemPrompt` and `appendSystemPrompt`. The server drops any other key. |
| `PAPERCLIP_CONNECTIONS_ADMIN_ONLY` | `true` | Only connection managers (`tools:manage_connections`, which owners and admins have) can create connections, including personal "Just me" connections, authorize a personal grant, or delegate a personal grant to an agent. The server rejects these requests from members with `connections_admin_only`, and the UI hides "Just me". Members can still view connections and ask for agent access. Existing organization and agent grants do not change. |

The server enforces all of these rules on agent create, hire, update and adapter
test requests. The UI only hides choices that the server would reject. Members
cannot choose an AI connection or send test credentials, and they cannot install
team catalogs or built-in agents, because those bring their own runtimes.
Malformed JSON in these variables stops the server from starting.

Example for Claude Code (which needs the CLI engine and an API key from a company
secret) and Hermes (where each model has its own provider):

```sh
PAPERCLIP_MEMBER_ADAPTER_DEFAULTS='{
  "claude_local": {"engine": "cli", "dangerouslySkipPermissions": true,
                   "env": {"ANTHROPIC_API_KEY": {"type": "secret_ref", "secretKey": "anthropic_api_key"}}},
  "codex_local": {"dangerouslyBypassApprovalsAndSandbox": true,
                  "env": {"OPENAI_API_KEY": {"type": "secret_ref", "secretKey": "openai_api_key"}}}
}'
PAPERCLIP_MEMBER_MODEL_ALLOWLIST='{
  "dixie_hermes": [
    {"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6", "adapterConfig": {"provider": "anthropic"}},
    {"id": "google/gemini-2.5-flash", "label": "Gemini 2.5 Flash", "adapterConfig": {"provider": "vertex"}},
    {"id": "google/gemini-2.5-pro", "label": "Gemini 2.5 Pro", "adapterConfig": {"provider": "vertex"}}
  ]
}'
```

### Default action permissions for connections

Paperclip already has a company-wide default for connection actions: a tool policy.
To allow read-only actions and ask first for every action that makes changes,
create one `require_approval` policy with a write-risk condition (as a company
owner or admin, with a board API key):

```sh
curl -X POST "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/policies" \
  -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Ask first for changes", "policyType": "require_approval", "priority": 1000,
       "selectors": {}, "conditions": {"risk": {"isWrite": true}}}'
```

Policies are checked in ascending `priority` order before each connection's own
permission choices. With priority 1000, an `allow` policy or a remembered "always
allow" trust rule with a lower priority number still takes effect first. Actions
with risk `write`, `destructive`, `medium`, `high` or `critical` then need a person
to approve them, and `read` and `low` actions follow the connection's own
permissions.

This policy is checked before the connection's agent permissions. A write action
from an agent that the connection does not permit therefore asks for approval
instead of being denied, so approvers should check which agent is asking.

