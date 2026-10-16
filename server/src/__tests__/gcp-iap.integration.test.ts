/**
 * End-to-end coverage for GCP IAP mode through the real Better Auth mount,
 * the real Drizzle schema and a migrated Postgres: session minting from an
 * IAP assertion, provisioning (admin role, company membership), identity
 * changes, sign-out without re-auth loops, and disabled password endpoints.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { and, eq } from "drizzle-orm";
import {
  authSessions,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSessionFromHeaders,
} from "../auth/better-auth.js";
import {
  GCP_IAP_ISSUER,
  GCP_IAP_JWT_HEADER,
  createGcpIapSessionEstablisher,
  createGcpIapSessionResolvers,
  createGcpIapVerifier,
  type GcpIapConfig,
} from "../auth/gcp-iap.js";
import { provisionGcpIapUser } from "../auth/gcp-iap-provisioning.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const AUDIENCE = "/projects/1/locations/us-central1/services/dixie-console";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

function cookiePairs(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

describeEmbeddedPostgres("GCP IAP mode against the real schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let sign!: (email: string) => Promise<string>;
  let companyId!: string;
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-gcp-iap-tests";
    database = await startEmbeddedPostgresTestDatabase("paperclip-gcp-iap-");
    db = createDb(database.connectionString);
    const [company] = await db
      .insert(companies)
      .values({ name: "Mindset", issuePrefix: `M${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    companyId = company!.id;
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });

    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
    const iapConfig: GcpIapConfig = {
      audience: AUDIENCE,
      allowedDomain: "mindsethealth.com",
      adminEmails: new Set(["admin@mindsethealth.com"]),
      memberGrants: ["agents:create"],
      jwksUrl: "https://example.invalid/jwk",
      clockToleranceSeconds: 30,
    };
    const verify = createGcpIapVerifier(iapConfig, { keySet: createLocalJWKSet({ keys: [jwk] }) });
    sign = (email) =>
      new SignJWT({ email, hd: "mindsethealth.com" })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(GCP_IAP_ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(`accounts.google.com:${email}`)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(privateKey);

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN], { gcpIap: { config: iapConfig, verify } });
    const resolvers = createGcpIapSessionResolvers({
      verify,
      resolveExisting: (headers) => resolveBetterAuthSessionFromHeaders(auth, headers),
      establish: createGcpIapSessionEstablisher(auth),
      revokeSession: async (id) => {
        await db.delete(authSessions).where(eq(authSessions.id, id));
      },
    });
    app = express();
    app.get("/api/whoami", async (req, res) => {
      res.json(await resolvers.fromRequest(req));
    });
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  it("mints a session from IAP, provisions the admin, and reuses the session", async () => {
    const assertion = await sign("admin@mindsethealth.com");
    const first = await request(app).get("/api/whoami").set(GCP_IAP_JWT_HEADER, assertion);
    expect(first.status).toBe(200);
    expect(first.body?.user?.email).toBe("admin@mindsethealth.com");
    expect(first.body?.user?.name).toBe("Admin");
    const cookie = cookiePairs(first);
    expect(cookie).toContain("session_token");

    const userId = first.body.user.id as string;
    const roles = await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
    expect(roles.map((row) => row.userId)).toEqual([userId]);
    const membership = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    expect(membership[0]).toMatchObject({ status: "active", membershipRole: "owner" });

    const second = await request(app)
      .get("/api/whoami")
      .set(GCP_IAP_JWT_HEADER, assertion)
      .set("cookie", cookie);
    expect(second.body?.session?.id).toBe(first.body.session.id);
    expect(second.headers["set-cookie"]).toBeUndefined();
  });

  it("follows IAP when the email changes and revokes the old session", async () => {
    const adminLogin = await request(app)
      .get("/api/whoami")
      .set(GCP_IAP_JWT_HEADER, await sign("admin@mindsethealth.com"));
    const oldSessionId = adminLogin.body.session.id as string;

    const switched = await request(app)
      .get("/api/whoami")
      .set(GCP_IAP_JWT_HEADER, await sign("member@mindsethealth.com"))
      .set("cookie", cookiePairs(adminLogin));
    expect(switched.body?.user?.email).toBe("member@mindsethealth.com");
    expect(switched.body.session.id).not.toBe(oldSessionId);
    await expect.poll(async () =>
      (await db.select().from(authSessions).where(eq(authSessions.id, oldSessionId))).length,
    ).toBe(0);

    const member = await db.select().from(authUsers).where(eq(authUsers.email, "member@mindsethealth.com"));
    const membership = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, member[0]!.id)));
    expect(membership[0]).toMatchObject({ status: "active", membershipRole: "operator" });
    const memberAdmin = await db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.userId, member[0]!.id));
    expect(memberAdmin).toHaveLength(0);
  });

  it("returns no session without an IAP assertion", async () => {
    const login = await request(app)
      .get("/api/whoami")
      .set(GCP_IAP_JWT_HEADER, await sign("admin@mindsethealth.com"));
    const bare = await request(app).get("/api/whoami").set("cookie", cookiePairs(login));
    expect(bare.body).toBeNull();
  });

  it("stays signed out after sign-out until the user resumes", async () => {
    const assertion = await sign("admin@mindsethealth.com");
    const login = await request(app).get("/api/whoami").set(GCP_IAP_JWT_HEADER, assertion);
    const signOut = await request(app)
      .post("/api/auth/sign-out")
      .set("origin", ORIGIN)
      .set("cookie", cookiePairs(login))
      .send({});
    expect(signOut.status).toBe(200);
    const signedOutCookie = cookiePairs(signOut)
      .split("; ")
      .filter((pair) => pair.includes("iap_signed_out"))
      .join("; ");
    expect(signedOutCookie).toMatch(/iap_signed_out=1/);

    const afterSignOut = await request(app)
      .get("/api/whoami")
      .set(GCP_IAP_JWT_HEADER, assertion)
      .set("cookie", signedOutCookie);
    expect(afterSignOut.body).toBeNull();

    const resume = await request(app)
      .get("/api/auth/gcp-iap/resume?next=%2Fdashboard")
      .set("cookie", signedOutCookie);
    expect(resume.status).toBe(302);
    expect(resume.headers.location).toBe("/dashboard");
    expect(cookiePairs(resume)).toMatch(/iap_signed_out=(;|$)/);

    const evil = await request(app).get("/api/auth/gcp-iap/resume?next=%2F%2Fevil.example");
    expect(evil.headers.location).toBe("/");
  });

  it("applies PAPERCLIP_IAP_MEMBER_GRANTS to operators and backfills on the next session", async () => {
    const grantKeys = async (userId: string, inCompany: string) =>
      (
        await db
          .select({ key: principalPermissionGrants.permissionKey })
          .from(principalPermissionGrants)
          .where(and(eq(principalPermissionGrants.companyId, inCompany), eq(principalPermissionGrants.principalId, userId)))
      )
        .map((row) => row.key)
        .sort();

    const first = await request(app).get("/api/whoami").set(GCP_IAP_JWT_HEADER, await sign("grants.member@mindsethealth.com"));
    const memberId = first.body.user.id as string;
    expect(await grantKeys(memberId, companyId)).toEqual(["agents:create", "tasks:assign"]);

    // A membership that predates the setting (or a company added later) is
    // backfilled at the next session; a viewer stays without the grant.
    const [later] = await db
      .insert(companies)
      .values({ name: "Later", issuePrefix: `L${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    const [viewerCompany] = await db
      .insert(companies)
      .values({ name: "Viewer", issuePrefix: `V${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    await db.insert(companyMemberships).values({
      companyId: viewerCompany!.id,
      principalType: "user",
      principalId: memberId,
      status: "active",
      membershipRole: "viewer",
    });
    // The next session runs the same provisioning (called directly here to
    // sidestep the resolver's single-flight window).
    const again = await provisionGcpIapUser(db, {
      email: "grants.member@mindsethealth.com",
      isAdmin: false,
      memberGrants: ["agents:create"],
    });
    expect(again).toMatchObject({ userId: memberId, created: false, membershipsCreated: 1, memberGrantsInserted: 1 });
    expect(await grantKeys(memberId, later!.id)).toEqual(["agents:create", "tasks:assign"]);
    expect(await grantKeys(memberId, viewerCompany!.id)).toEqual([]);

    // Admins keep their owner defaults; the member grant list adds nothing for them.
    const admin = await provisionGcpIapUser(db, {
      email: "admin@mindsethealth.com",
      isAdmin: true,
      memberGrants: ["agents:create"],
    });
    expect(admin.memberGrantsInserted).toBe(0);
    expect(await grantKeys(admin.userId, later!.id)).toContain("agents:configure");
  });

  it("rejects direct calls to the session endpoint without IAP", async () => {
    const response = await request(app).get("/api/auth/gcp-iap/session");
    expect(response.status).toBe(401);
  });

  it("disables password sign-in and sign-up", async () => {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "x@mindsethealth.com", password: "correct-horse-battery-staple", name: "X" });
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: "admin@mindsethealth.com", password: "whatever-password" });
    expect(signIn.status).toBeGreaterThanOrEqual(400);
  });
});
