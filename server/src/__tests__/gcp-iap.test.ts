import { describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import {
  GCP_IAP_ISSUER,
  GCP_IAP_JWT_HEADER,
  createGcpIapSessionResolvers,
  createGcpIapVerifier,
  hasGcpIapSignedOutCookie,
  readGcpIapConfig,
  resolveAuthProviderName,
  type GcpIapConfig,
} from "../auth/gcp-iap.js";
import { displayNameFromEmail } from "../auth/gcp-iap-provisioning.js";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";

const AUDIENCE = "/projects/123456/locations/us-central1/services/dixie-console";
const NOW = new Date("2026-10-16T00:00:00Z");

const config: GcpIapConfig = {
  audience: AUDIENCE,
  allowedDomain: "mindsethealth.com",
  adminEmails: new Set(["admin@mindsethealth.com"]),
  jwksUrl: "https://example.invalid/jwk",
  clockToleranceSeconds: 30,
};

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256" };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const verify = createGcpIapVerifier(config, { keySet, now: () => NOW });
  const sign = async (
    claims: Record<string, unknown> = {},
    opts: { audience?: string; issuer?: string; iat?: number; exp?: number } = {},
  ) => {
    const iat = opts.iat ?? Math.floor(NOW.getTime() / 1000) - 5;
    return new SignJWT({ email: "user@mindsethealth.com", hd: "mindsethealth.com", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(opts.issuer ?? GCP_IAP_ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setSubject("accounts.google.com:1234")
      .setIssuedAt(iat)
      .setExpirationTime(opts.exp ?? iat + 600)
      .sign(privateKey);
  };
  return { verify, sign };
}

function session(email: string, id = "session-1"): BetterAuthSessionResult {
  return { session: { id, userId: `user-${email}` }, user: { id: `user-${email}`, email, name: email } };
}

describe("GCP IAP config", () => {
  it("is off unless PAPERCLIP_AUTH_PROVIDER=gcp-iap", () => {
    expect(readGcpIapConfig({})).toBeNull();
    expect(resolveAuthProviderName({})).toBe("better-auth");
    expect(resolveAuthProviderName({ PAPERCLIP_AUTH_PROVIDER: "gcp-iap" })).toBe("gcp-iap");
  });

  it("requires audience and allowed domain when enabled", () => {
    expect(() => readGcpIapConfig({ PAPERCLIP_AUTH_PROVIDER: "gcp-iap" })).toThrow(/PAPERCLIP_IAP_AUDIENCE/);
  });

  it("parses admin emails case-insensitively", () => {
    const parsed = readGcpIapConfig({
      PAPERCLIP_AUTH_PROVIDER: "gcp-iap",
      PAPERCLIP_IAP_AUDIENCE: AUDIENCE,
      PAPERCLIP_IAP_ALLOWED_DOMAIN: "MindsetHealth.com",
      PAPERCLIP_IAP_ADMIN_EMAILS: " Admin@MindsetHealth.com, ,other@mindsethealth.com",
    });
    expect(parsed?.allowedDomain).toBe("mindsethealth.com");
    expect([...parsed!.adminEmails]).toEqual(["admin@mindsethealth.com", "other@mindsethealth.com"]);
  });
});

describe("GCP IAP assertion verification", () => {
  it("accepts a valid assertion", async () => {
    const { verify, sign } = await setup();
    const result = await verify(await sign({ email: "User@MindsetHealth.com" }));
    expect(result).toEqual({
      ok: true,
      identity: { email: "user@mindsethealth.com", subject: "accounts.google.com:1234", hostedDomain: "mindsethealth.com" },
    });
  });

  it("rejects a missing assertion", async () => {
    const { verify } = await setup();
    expect(await verify(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(await verify("  ")).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects the wrong audience", async () => {
    const { verify, sign } = await setup();
    const result = await verify(await sign({}, { audience: "/projects/999/global/backendServices/1" }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects the wrong issuer", async () => {
    const { verify, sign } = await setup();
    const result = await verify(await sign({}, { issuer: "https://accounts.google.com" }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects an expired assertion beyond the clock skew", async () => {
    const { verify, sign } = await setup();
    const iat = Math.floor(NOW.getTime() / 1000) - 3600;
    const result = await verify(await sign({}, { iat, exp: iat + 600 }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("tolerates small clock skew on exp", async () => {
    const { verify, sign } = await setup();
    const exp = Math.floor(NOW.getTime() / 1000) - 10;
    const result = await verify(await sign({}, { iat: exp - 600, exp }));
    expect(result.ok).toBe(true);
  });

  it("rejects an assertion issued in the future", async () => {
    const { verify, sign } = await setup();
    const iat = Math.floor(NOW.getTime() / 1000) + 600;
    const result = await verify(await sign({}, { iat, exp: iat + 600 }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects a token signed by a different key", async () => {
    const { verify } = await setup();
    const other = await setup();
    const result = await verify(await other.sign());
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects an email outside the allowed domain", async () => {
    const { verify, sign } = await setup();
    const result = await verify(await sign({ email: "mallory@example.com", hd: undefined }));
    expect(result).toMatchObject({ ok: false, reason: "domain" });
  });

  it("rejects a lookalike domain suffix", async () => {
    const { verify, sign } = await setup();
    const result = await verify(await sign({ email: "mallory@evilmindsethealth.com", hd: "evilmindsethealth.com" }));
    expect(result).toMatchObject({ ok: false, reason: "domain" });
  });

  it("rejects an assertion without an email", async () => {
    const { verify, sign } = await setup();
    const result = await verify(await sign({ email: undefined }));
    expect(result).toMatchObject({ ok: false, reason: "no_email" });
  });
});

describe("GCP IAP session resolution", () => {
  function headers(assertion?: string, cookie?: string) {
    const h = new Headers();
    if (assertion) h.set(GCP_IAP_JWT_HEADER, assertion);
    if (cookie) h.set("cookie", cookie);
    return h;
  }

  it("returns no session when the IAP header is missing, even with a session cookie", async () => {
    const { verify } = await setup();
    const resolveExisting = vi.fn(async () => session("user@mindsethealth.com"));
    const establish = vi.fn();
    const resolvers = createGcpIapSessionResolvers({ verify, resolveExisting, establish });
    expect(await resolvers.fromHeaders(headers(undefined, "x=1"))).toBeNull();
    expect(resolveExisting).not.toHaveBeenCalled();
    expect(establish).not.toHaveBeenCalled();
  });

  it("reuses an existing session for the same IAP email", async () => {
    const { verify, sign } = await setup();
    const existing = session("user@mindsethealth.com");
    const establish = vi.fn();
    const resolvers = createGcpIapSessionResolvers({ verify, resolveExisting: async () => existing, establish });
    expect(await resolvers.fromHeaders(headers(await sign()))).toBe(existing);
    expect(establish).not.toHaveBeenCalled();
  });

  it("creates a session when none exists and sets its cookie on the response", async () => {
    const { verify, sign } = await setup();
    const created = session("user@mindsethealth.com", "new-session");
    const establish = vi.fn(async () => ({ result: created, setCookies: ["paperclip-default.session_token=abc; Path=/"] }));
    const resolvers = createGcpIapSessionResolvers({ verify, resolveExisting: async () => null, establish });
    const append = vi.fn();
    const req = { headers: { [GCP_IAP_JWT_HEADER]: await sign() }, res: { headersSent: false, append } };
    expect(await resolvers.fromRequest(req as never)).toBe(created);
    expect(establish).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith("Set-Cookie", "paperclip-default.session_token=abc; Path=/");
  });

  it("replaces the session when the IAP email changes", async () => {
    const { verify, sign } = await setup();
    const stale = session("old@mindsethealth.com", "old-session");
    const created = session("user@mindsethealth.com", "new-session");
    const establish = vi.fn(async () => ({ result: created, setCookies: [] }));
    const revokeSession = vi.fn(async () => undefined);
    const resolvers = createGcpIapSessionResolvers({
      verify,
      resolveExisting: async () => stale,
      establish,
      revokeSession,
    });
    const req = { headers: { [GCP_IAP_JWT_HEADER]: await sign() }, res: { headersSent: false, append: vi.fn() } };
    expect(await resolvers.fromRequest(req as never)).toBe(created);
    expect(establish).toHaveBeenCalledWith(expect.any(Headers), expect.objectContaining({ email: "user@mindsethealth.com" }));
    expect(revokeSession).toHaveBeenCalledWith("old-session");
  });

  it("does not mint sessions on header-only (websocket) resolution", async () => {
    const { verify, sign } = await setup();
    const establish = vi.fn();
    const resolvers = createGcpIapSessionResolvers({
      verify,
      resolveExisting: async () => session("old@mindsethealth.com"),
      establish,
    });
    expect(await resolvers.fromHeaders(headers(await sign()))).toBeNull();
    expect(establish).not.toHaveBeenCalled();
  });

  it("collapses concurrent first requests into one session", async () => {
    const { verify, sign } = await setup();
    const created = session("user@mindsethealth.com", "new-session");
    const establish = vi.fn(async () => ({ result: created, setCookies: [] }));
    const resolvers = createGcpIapSessionResolvers({ verify, resolveExisting: async () => null, establish });
    const token = await sign();
    const make = () => ({ headers: { [GCP_IAP_JWT_HEADER]: token }, res: { headersSent: false, append: vi.fn() } });
    await Promise.all([resolvers.fromRequest(make() as never), resolvers.fromRequest(make() as never)]);
    expect(establish).toHaveBeenCalledTimes(1);
  });

  it("stays signed out after an explicit sign-out", async () => {
    const { verify, sign } = await setup();
    const establish = vi.fn();
    const resolvers = createGcpIapSessionResolvers({ verify, resolveExisting: async () => null, establish });
    const cookie = "__Secure-paperclip-default.iap_signed_out=1";
    expect(hasGcpIapSignedOutCookie(cookie)).toBe(true);
    const req = { headers: { [GCP_IAP_JWT_HEADER]: await sign(), cookie }, res: { headersSent: false, append: vi.fn() } };
    expect(await resolvers.fromRequest(req as never)).toBeNull();
    expect(establish).not.toHaveBeenCalled();
  });

  it("rejects users outside the allowed domain without creating a session", async () => {
    const { verify, sign } = await setup();
    const establish = vi.fn();
    const resolvers = createGcpIapSessionResolvers({ verify, resolveExisting: async () => null, establish });
    const req = {
      headers: { [GCP_IAP_JWT_HEADER]: await sign({ email: "x@example.com", hd: undefined }) },
      res: { headersSent: false, append: vi.fn() },
    };
    expect(await resolvers.fromRequest(req as never)).toBeNull();
    expect(establish).not.toHaveBeenCalled();
  });
});

describe("displayNameFromEmail", () => {
  it("derives a readable name", () => {
    expect(displayNameFromEmail("simon.raik-allen@mindsethealth.com")).toBe("Simon Raik-Allen");
    expect(displayNameFromEmail("ops@mindsethealth.com")).toBe("Ops");
  });
});
