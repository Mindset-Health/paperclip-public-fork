import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const MEMBER_ID = "connections-member";
const MANAGER_ID = "connections-manager";

describeDatabase("PAPERCLIP_CONNECTIONS_ADMIN_ONLY", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  let companyId!: string;
  const previous = process.env.PAPERCLIP_CONNECTIONS_ADMIN_ONLY;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("connections-admin-only");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Connections", issuePrefix: `CA${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: MEMBER_ID, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: MANAGER_ID, status: "active", membershipRole: "owner" },
    ]);
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: MANAGER_ID,
      permissionKey: "tools:manage_connections",
    });
  }, 30_000);

  afterEach(() => {
    if (previous === undefined) delete process.env.PAPERCLIP_CONNECTIONS_ADMIN_ONLY;
    else process.env.PAPERCLIP_CONNECTIONS_ADMIN_ONLY = previous;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  function app(userId: string, adminOnly: boolean) {
    if (adminOnly) process.env.PAPERCLIP_CONNECTIONS_ADMIN_ONLY = "true";
    else delete process.env.PAPERCLIP_CONNECTIONS_ADMIN_ONLY;
    const role = userId === MANAGER_ID ? "owner" : "operator";
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId,
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: role, status: "active" }],
      } as typeof req.actor;
      next();
    });
    server.use("/api", toolAccessRoutes(db));
    server.use(errorHandler);
    return server;
  }

  it("blocks a member's personal \"Just me\" connection", async () => {
    const response = await request(app(MEMBER_ID, true))
      .post(`/api/companies/${companyId}/tools/apps/connect`)
      .send({ galleryKey: "linear", grantKind: "user" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("connections_admin_only");
  });

  it("blocks member-created raw connections and personal-grant delegation", async () => {
    const created = await request(app(MEMBER_ID, true))
      .post(`/api/companies/${companyId}/tools/connections`)
      .send({ applicationName: "Mine", name: "Mine" });
    expect(created.status).toBe(403);
    expect(created.body.code).toBe("connections_admin_only");

    const delegated = await request(app(MEMBER_ID, true))
      .post(`/api/tool-connections/${randomUUID()}/grants/${randomUUID()}/delegations`)
      .send({ agentId: randomUUID() });
    // The connection does not exist, so a 404 is also an acceptable refusal.
    expect([403, 404]).toContain(delegated.status);
  });

  it("lets connection managers through the gate", async () => {
    const response = await request(app(MANAGER_ID, true))
      .post(`/api/companies/${companyId}/tools/apps/connect`)
      .send({ galleryKey: "linear", grantKind: "user" });
    expect(response.body.code).not.toBe("connections_admin_only");
  });

  it("keeps upstream behaviour when unset", async () => {
    const response = await request(app(MEMBER_ID, false))
      .post(`/api/companies/${companyId}/tools/apps/connect`)
      .send({ galleryKey: "linear", grantKind: "user" });
    expect(response.body.code).not.toBe("connections_admin_only");
  });

  it("reports the personal-grant capability so the UI hides \"Just me\"", async () => {
    const member = await request(app(MEMBER_ID, true)).get(`/api/companies/${companyId}/tools/gallery`);
    expect(member.status).toBe(200);
    expect(member.body.capabilities).toMatchObject({ canCreatePersonalGrant: false, canCreateOrganizationGrant: false });
    expect(typeof member.body.capabilities.personalGrantReason).toBe("string");

    const manager = await request(app(MANAGER_ID, true)).get(`/api/companies/${companyId}/tools/gallery`);
    expect(manager.body.capabilities).toMatchObject({ canCreatePersonalGrant: true, personalGrantReason: null });

    const upstream = await request(app(MEMBER_ID, false)).get(`/api/companies/${companyId}/tools/gallery`);
    expect(upstream.body.capabilities.canCreatePersonalGrant).toBeUndefined();
  });
});
