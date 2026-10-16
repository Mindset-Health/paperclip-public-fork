/**
 * Google Cloud Identity-Aware Proxy (IAP) trusted-identity authentication.
 *
 * Enabled with `PAPERCLIP_AUTH_PROVIDER=gcp-iap`. Every browser request that
 * reaches the server through IAP carries a signed `x-goog-iap-jwt-assertion`
 * header. This module verifies that assertion and keeps a normal Better Auth
 * session in step with it, so the rest of the app (actor middleware, realtime,
 * `/api/auth/get-session`) works unchanged:
 *
 * - no session, or a session for a different email -> provision the user and
 *   mint a fresh Better Auth session (cookie is set on the same response);
 * - session for the same email -> reuse it;
 * - missing / invalid assertion -> no browser session at all.
 *
 * Bearer credentials (agent JWTs, agent keys, board API keys, CLI tokens) never
 * reach the session resolver, so they are unaffected.
 *
 * Session creation and cookie signing go through Better Auth's own plugin path
 * (`internalAdapter.createSession` + `setSessionCookie`), mirroring
 * `workspace-login-handoff-plugin.ts`.
 */

import type { Request } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { Session, User } from "better-auth/types";
import type { Db } from "@paperclipai/db";
import { PERMISSION_KEYS, type PermissionKey } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import type { BetterAuthSessionResult } from "./better-auth.js";
import { provisionGcpIapUser } from "./gcp-iap-provisioning.js";

export const GCP_IAP_AUTH_PROVIDER = "gcp-iap";
export const GCP_IAP_JWT_HEADER = "x-goog-iap-jwt-assertion";
export const GCP_IAP_ISSUER = "https://cloud.google.com/iap";
export const GCP_IAP_DEFAULT_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
export const GCP_IAP_SESSION_PATH = "/gcp-iap/session";
export const GCP_IAP_RESUME_PATH = "/gcp-iap/resume";
/** Cookie (suffix) marking an explicit sign-out; suppresses silent re-auth. */
export const GCP_IAP_SIGNED_OUT_COOKIE = "iap_signed_out";
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;
const SESSION_SINGLE_FLIGHT_TTL_MS = 15_000;

export type AuthProviderName = "better-auth" | typeof GCP_IAP_AUTH_PROVIDER;

export function resolveAuthProviderName(env: NodeJS.ProcessEnv = process.env): AuthProviderName {
  return env.PAPERCLIP_AUTH_PROVIDER?.trim().toLowerCase() === GCP_IAP_AUTH_PROVIDER
    ? GCP_IAP_AUTH_PROVIDER
    : "better-auth";
}

export type GcpIapConfig = {
  audience: string;
  allowedDomain: string;
  adminEmails: ReadonlySet<string>;
  /** Explicit grants for non-admin members (PAPERCLIP_IAP_MEMBER_GRANTS). */
  memberGrants: readonly PermissionKey[];
  jwksUrl: string;
  clockToleranceSeconds: number;
};

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Reads IAP settings. Returns null when IAP mode is off; throws when IAP mode is
 * on but misconfigured, so the server refuses to start instead of failing open.
 */
export function readGcpIapConfig(env: NodeJS.ProcessEnv = process.env): GcpIapConfig | null {
  if (resolveAuthProviderName(env) !== GCP_IAP_AUTH_PROVIDER) return null;
  const audience = env.PAPERCLIP_IAP_AUDIENCE?.trim();
  const allowedDomain = env.PAPERCLIP_IAP_ALLOWED_DOMAIN?.trim().toLowerCase().replace(/^@/, "");
  const missing = [
    !audience ? "PAPERCLIP_IAP_AUDIENCE" : null,
    !allowedDomain ? "PAPERCLIP_IAP_ALLOWED_DOMAIN" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`PAPERCLIP_AUTH_PROVIDER=gcp-iap requires ${missing.join(" and ")}`);
  }
  const adminEmails = new Set(
    (env.PAPERCLIP_IAP_ADMIN_EMAILS ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value) => value.length > 0),
  );
  const memberGrants = [
    ...new Set(
      (env.PAPERCLIP_IAP_MEMBER_GRANTS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
  const unknownGrants = memberGrants.filter((key) => !(PERMISSION_KEYS as readonly string[]).includes(key));
  if (unknownGrants.length > 0) {
    throw new Error(`PAPERCLIP_IAP_MEMBER_GRANTS has unknown permission keys: ${unknownGrants.join(", ")}`);
  }
  const tolerance = Number.parseInt(env.PAPERCLIP_IAP_CLOCK_TOLERANCE_SECONDS ?? "", 10);
  return {
    audience: audience!,
    allowedDomain: allowedDomain!,
    adminEmails,
    memberGrants: memberGrants as PermissionKey[],
    jwksUrl: env.PAPERCLIP_IAP_JWKS_URL?.trim() || GCP_IAP_DEFAULT_JWKS_URL,
    clockToleranceSeconds: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_CLOCK_TOLERANCE_SECONDS,
  };
}

export type GcpIapIdentity = {
  email: string;
  subject: string;
  hostedDomain: string | null;
};

export type GcpIapVerificationFailure = "missing" | "invalid" | "no_email" | "domain";

export type GcpIapVerification =
  | { ok: true; identity: GcpIapIdentity }
  | { ok: false; reason: GcpIapVerificationFailure; detail?: string };

export type GcpIapVerifier = (assertion: string | null | undefined) => Promise<GcpIapVerification>;

export function isEmailInAllowedDomain(
  email: string,
  allowedDomain: string,
  hostedDomain?: string | null,
): boolean {
  const domain = allowedDomain.toLowerCase();
  if (hostedDomain && hostedDomain.toLowerCase() === domain) return true;
  const at = email.lastIndexOf("@");
  return at > 0 && email.slice(at + 1).toLowerCase() === domain;
}

export function createGcpIapVerifier(
  config: GcpIapConfig,
  opts: { keySet?: JWTVerifyGetKey; now?: () => Date } = {},
): GcpIapVerifier {
  const keySet = opts.keySet ?? createRemoteJWKSet(new URL(config.jwksUrl), {
    cacheMaxAge: 6 * 60 * 60 * 1000,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  return async (assertion) => {
    const token = assertion?.trim();
    if (!token) return { ok: false, reason: "missing" };
    const now = opts.now?.() ?? new Date();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        algorithms: ["ES256"],
        issuer: GCP_IAP_ISSUER,
        audience: config.audience,
        clockTolerance: config.clockToleranceSeconds,
        currentDate: now,
        requiredClaims: ["exp", "iat", "sub"],
      }));
    } catch (err) {
      return { ok: false, reason: "invalid", detail: err instanceof Error ? err.message : String(err) };
    }
    if (typeof payload.iat !== "number" || payload.iat > now.getTime() / 1000 + config.clockToleranceSeconds) {
      return { ok: false, reason: "invalid", detail: "iat is in the future" };
    }
    const rawEmail = typeof payload.email === "string" ? payload.email : "";
    const email = normalizeEmail(rawEmail.replace(/^accounts\.google\.com:/, ""));
    if (!email || !email.includes("@")) return { ok: false, reason: "no_email" };
    const hostedDomain = typeof payload.hd === "string" ? payload.hd.toLowerCase() : null;
    if (!isEmailInAllowedDomain(email, config.allowedDomain, hostedDomain)) {
      return { ok: false, reason: "domain", detail: email };
    }
    return { ok: true, identity: { email, subject: String(payload.sub), hostedDomain } };
  };
}

function headerValue(headers: Headers | IncomingHttpHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const raw = headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function hasGcpIapSignedOutCookie(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => {
    const [name, value] = part.trim().split("=", 2);
    return Boolean(name?.endsWith(`.${GCP_IAP_SIGNED_OUT_COOKIE}`) && value);
  });
}

export type GcpIapEstablishedSession = {
  result: BetterAuthSessionResult;
  setCookies: string[];
};

export type GcpIapSessionResolverDeps = {
  verify: GcpIapVerifier;
  /** Resolves the existing Better Auth session (cookie-based). */
  resolveExisting: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  /** Mints a Better Auth session for the IAP identity carried by `headers`. */
  establish: (headers: Headers, identity: GcpIapIdentity) => Promise<GcpIapEstablishedSession>;
  /** Revokes a session that belongs to a previous IAP identity. */
  revokeSession?: (sessionId: string) => Promise<void>;
  now?: () => number;
};

export type GcpIapSessionResolvers = {
  fromRequest: (req: Request) => Promise<BetterAuthSessionResult | null>;
  fromHeaders: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
};

export function headersFromIncoming(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (!value) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  return headers;
}

/**
 * Builds session resolvers where the IAP assertion is the source of identity.
 * `fromRequest` may mint a session (and sets its cookie on `req.res`);
 * `fromHeaders` (websocket upgrades) only accepts an existing matching session.
 */
export function createGcpIapSessionResolvers(deps: GcpIapSessionResolverDeps): GcpIapSessionResolvers {
  const now = deps.now ?? Date.now;
  const inFlight = new Map<string, { expiresAt: number; promise: Promise<GcpIapEstablishedSession> }>();

  async function resolve(
    headers: Headers,
    opts: { canEstablish: boolean; appendSetCookie?: (value: string) => void },
  ): Promise<BetterAuthSessionResult | null> {
    if (hasGcpIapSignedOutCookie(headerValue(headers, "cookie"))) return null;
    const verification = await deps.verify(headerValue(headers, GCP_IAP_JWT_HEADER));
    if (!verification.ok) {
      if (verification.reason !== "missing") {
        logger.warn({ reason: verification.reason, detail: verification.detail }, "Rejected GCP IAP assertion");
      }
      return null;
    }
    const { identity } = verification;
    const existing = await deps.resolveExisting(headers);
    if (existing?.user?.email && normalizeEmail(existing.user.email) === identity.email) return existing;
    if (!opts.canEstablish) return null;

    const nowMs = now();
    for (const [key, entry] of inFlight) if (entry.expiresAt <= nowMs) inFlight.delete(key);
    let entry = inFlight.get(identity.email);
    if (!entry) {
      const promise = deps.establish(headers, identity);
      entry = { expiresAt: nowMs + SESSION_SINGLE_FLIGHT_TTL_MS, promise };
      inFlight.set(identity.email, entry);
      promise.catch(() => inFlight.delete(identity.email));
      // Never hand out a cached session that is about to be revoked.
      if (existing?.user?.email) inFlight.delete(normalizeEmail(existing.user.email));
      if (existing?.session?.id && deps.revokeSession) {
        // Identity changed under IAP: the old account's session must not linger.
        void deps.revokeSession(existing.session.id).catch((err) =>
          logger.warn({ err }, "Failed to revoke session for previous IAP identity"),
        );
      }
    }
    const established = await entry.promise;
    for (const cookie of established.setCookies) opts.appendSetCookie?.(cookie);
    return established.result;
  }

  return {
    fromRequest: (req) =>
      resolve(headersFromIncoming(req.headers), {
        canEstablish: true,
        appendSetCookie: (value) => {
          if (req.res && !req.res.headersSent) req.res.append("Set-Cookie", value);
        },
      }),
    fromHeaders: (headers) => resolve(headers, { canEstablish: false }),
  };
}

/**
 * Calls the plugin's session endpoint through Better Auth's own handler, so
 * cookie naming, signing and Secure/loopback handling stay Better Auth's.
 */
export function createGcpIapSessionEstablisher(
  auth: { handler: (request: globalThis.Request) => Promise<Response> },
  basePath = "/api/auth",
) {
  return async (headers: Headers): Promise<GcpIapEstablishedSession> => {
    const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host") || "localhost";
    const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
    const forward = new Headers();
    for (const name of [GCP_IAP_JWT_HEADER, "host", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "user-agent"]) {
      const value = headers.get(name);
      if (value) forward.set(name, value);
    }
    const response = await auth.handler(
      new globalThis.Request(`${proto}://${host}${basePath}${GCP_IAP_SESSION_PATH}`, { method: "GET", headers: forward }),
    );
    if (!response.ok) {
      throw new Error(`GCP IAP session endpoint failed with status ${response.status}`);
    }
    const body = await response.json() as BetterAuthSessionResult;
    if (!body?.session?.id || !body.user?.id) throw new Error("GCP IAP session endpoint returned no session");
    return { result: body, setCookies: response.headers.getSetCookie() };
  };
}

type IapEndpointContext = {
  headers?: Headers;
  query?: Record<string, unknown>;
  setCookie: (name: string, value: string, attributes?: Record<string, unknown>) => void;
  redirect: (url: string) => unknown;
  error: (status: string, body?: Record<string, unknown>) => unknown;
  context: {
    createAuthCookie: (name: string, attributes?: Record<string, unknown>) => {
      name: string;
      attributes: Record<string, unknown>;
    };
    internalAdapter: {
      findUserById: (userId: string) => Promise<User | null>;
      createSession: (userId: string) => Promise<Session | null>;
    };
  };
};

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}

/** Better Auth plugin: IAP session minting, sign-out marker and resume. */
export function gcpIapPlugin(deps: { db: Db; config: GcpIapConfig; verify: GcpIapVerifier }) {
  return {
    id: "dixie-gcp-iap",
    endpoints: {
      gcpIapSession: createAuthEndpoint(
        GCP_IAP_SESSION_PATH,
        { method: "GET", requireHeaders: true },
        async (endpointContext) => {
          const ctx = endpointContext as unknown as IapEndpointContext;
          // Re-verified here so the endpoint is safe even when reached directly.
          const verification = await deps.verify(ctx.headers?.get(GCP_IAP_JWT_HEADER));
          if (!verification.ok) {
            throw ctx.error("UNAUTHORIZED", { message: "Valid IAP identity required", code: verification.reason });
          }
          const provisioned = await provisionGcpIapUser(deps.db, {
            email: verification.identity.email,
            isAdmin: deps.config.adminEmails.has(verification.identity.email),
            memberGrants: deps.config.memberGrants,
          });
          const user = await ctx.context.internalAdapter.findUserById(provisioned.userId);
          if (!user) throw new Error("Provisioned IAP user not found");
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new Error("Better Auth did not return a session");
          await setSessionCookie(ctx as never, { session, user });
          logger.info(
            { userId: user.id, created: provisioned.created, isInstanceAdmin: provisioned.isInstanceAdmin },
            "Established session from GCP IAP identity",
          );
          return {
            session: { id: session.id, userId: session.userId },
            user: { id: user.id, email: user.email ?? null, name: user.name ?? null },
          };
        },
      ),
      gcpIapResume: createAuthEndpoint(
        GCP_IAP_RESUME_PATH,
        { method: "GET", requireHeaders: true },
        async (endpointContext) => {
          const ctx = endpointContext as unknown as IapEndpointContext;
          const marker = ctx.context.createAuthCookie(GCP_IAP_SIGNED_OUT_COOKIE);
          ctx.setCookie(marker.name, "", { ...marker.attributes, maxAge: 0 });
          throw ctx.redirect(safeRelativePath(ctx.query?.next));
        },
      ),
    },
    hooks: {
      after: [
        {
          matcher: (context: { path?: string }) => context.path === "/sign-out",
          handler: createAuthMiddleware(async (middlewareContext) => {
            const ctx = middlewareContext as unknown as IapEndpointContext;
            const marker = ctx.context.createAuthCookie(GCP_IAP_SIGNED_OUT_COOKIE, { maxAge: 60 * 60 * 24 });
            ctx.setCookie(marker.name, "1", marker.attributes);
          }),
        },
      ],
    },
  };
}
