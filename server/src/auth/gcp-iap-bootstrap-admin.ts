/**
 * Headless admin bootstrap for GCP IAP deployments.
 *
 * In `PAPERCLIP_AUTH_PROVIDER=gcp-iap` mode there is no password sign-in and
 * no browser on the server, so release automation uses this command (run
 * inside the production container, talking to DATABASE_URL directly) to obtain
 * a board API key for an IAP admin:
 *
 *   node --import ./server/node_modules/tsx/dist/loader.mjs \
 *     server/dist/auth/gcp-iap-bootstrap-admin.js \
 *     --email admin@example.com --key-name dixie-release --json
 *
 * It find-or-creates the Better Auth user (same provisioning as an IAP login),
 * makes them instance admin, and mints a board API key through the board-auth
 * service (same hashing, expiry and activity audit as the REST endpoint). The
 * token is printed once, on stdout only. Re-running is idempotent apart from
 * minting a new key.
 */

import { parseArgs } from "node:util";

const USAGE =
  "Usage: gcp-iap-bootstrap-admin --email <email> [--key-name <name>] [--expires-days <n>|--no-expiry] [--json]";

async function main(): Promise<number> {
  // Keep stdout reserved for the result: server modules log through pino on fd 1.
  process.env.PAPERCLIP_LOG_LEVEL ??= "silent";

  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      "key-name": { type: "string", default: "gcp-iap-bootstrap" },
      "expires-days": { type: "string" },
      "no-expiry": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }

  const { normalizeEmail, readGcpIapConfig, isEmailInAllowedDomain } = await import("./gcp-iap.js");
  const fail = (message: string) => {
    process.stderr.write(`gcp-iap-bootstrap-admin: ${message}\n`);
    return 1;
  };

  const email = values.email ? normalizeEmail(values.email) : "";
  if (!email) return fail(`--email is required\n${USAGE}`);
  const keyName = values["key-name"]?.trim() ?? "";
  if (!keyName) return fail("--key-name must not be empty");

  let config;
  try {
    config = readGcpIapConfig();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!config) return fail("PAPERCLIP_AUTH_PROVIDER=gcp-iap is not set");
  if (!isEmailInAllowedDomain(email, config.allowedDomain)) {
    return fail(`${email} is not in PAPERCLIP_IAP_ALLOWED_DOMAIN (${config.allowedDomain})`);
  }
  if (!config.adminEmails.has(email)) return fail(`${email} is not listed in PAPERCLIP_IAP_ADMIN_EMAILS`);

  let expiresAt: Date | null | undefined;
  if (values["no-expiry"]) {
    expiresAt = null;
  } else if (values["expires-days"] !== undefined) {
    const days = Number(values["expires-days"]);
    if (!Number.isFinite(days) || days <= 0) return fail("--expires-days must be a positive number");
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return fail("DATABASE_URL must be set");

  const { createDb, closeRegisteredClients } = await import("@paperclipai/db");
  const { provisionGcpIapUser } = await import("./gcp-iap-provisioning.js");
  const { boardAuthService } = await import("../services/board-auth.js");
  const { logActivity } = await import("../services/activity-log.js");

  const db = createDb(databaseUrl);
  try {
    const provisioned = await provisionGcpIapUser(db, { email, isAdmin: true });
    const boardAuth = boardAuthService(db);
    const key = await boardAuth.createNamedBoardApiKey({ userId: provisioned.userId, name: keyName, expiresAt });
    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: provisioned.userId,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: provisioned.userId,
        action: "board_api_key.created",
        entityType: "user",
        entityId: provisioned.userId,
        details: {
          boardApiKeyId: key.id,
          name: key.name,
          requestedCompanyId: null,
          expiresAt: key.expiresAt?.toISOString() ?? null,
          source: "gcp_iap_bootstrap_admin",
        },
      });
    }

    const result = {
      userId: provisioned.userId,
      email,
      userCreated: provisioned.created,
      isInstanceAdmin: provisioned.isInstanceAdmin,
      membershipsCreated: provisioned.membershipsCreated,
      key: {
        id: key.id,
        name: key.name,
        token: key.token,
        expiresAt: key.expiresAt?.toISOString() ?? null,
      },
    };
    process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${key.token}\n`);
    return 0;
  } finally {
    await closeRegisteredClients(databaseUrl).catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`gcp-iap-bootstrap-admin: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
