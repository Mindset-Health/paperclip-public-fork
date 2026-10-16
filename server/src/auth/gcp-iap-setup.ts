/**
 * Startup wiring for GCP IAP mode, kept out of `index.ts` so the upstream
 * entrypoint carries only a few lines of Dixie-specific change.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authSessions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { BetterAuthSessionResult } from "./better-auth.js";
import {
  createGcpIapSessionEstablisher,
  createGcpIapSessionResolvers,
  createGcpIapVerifier,
  readGcpIapConfig,
  type GcpIapConfig,
  type GcpIapVerifier,
} from "./gcp-iap.js";

export async function setupGcpIapAuth(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const config = readGcpIapConfig(env);
  if (!config) return null;
  const verify = createGcpIapVerifier(config);
  logger.info(
    {
      audience: config.audience,
      allowedDomain: config.allowedDomain,
      adminEmailCount: config.adminEmails.size,
    },
    "GCP IAP trusted-identity authentication enabled; password sign-in disabled",
  );
  const options: { config: GcpIapConfig; verify: GcpIapVerifier } = { config, verify };
  return {
    options,
    wrap(
      auth: { handler: (request: Request) => Promise<Response> },
      resolveExisting: (headers: Headers) => Promise<BetterAuthSessionResult | null>,
    ) {
      const establish = createGcpIapSessionEstablisher(auth);
      const resolvers = createGcpIapSessionResolvers({
        verify,
        resolveExisting,
        establish: (headers) => establish(headers),
        revokeSession: async (sessionId) => {
          await db.delete(authSessions).where(eq(authSessions.id, sessionId));
        },
      });
      return {
        resolveSession: resolvers.fromRequest,
        resolveSessionFromHeaders: resolvers.fromHeaders,
      };
    },
  };
}
