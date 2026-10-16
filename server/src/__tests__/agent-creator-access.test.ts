import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { AGENT_CREATOR_METADATA_KEY } from "../services/agent-creator-access.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("agent creator configuration (PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE)", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  let companyId!: string;
  let agentId!: string;
  const creatorId = `creator-${randomUUID()}`;
  const peerId = `peer-${randomUUID()}`;
  const previous = process.env.PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-creator-access");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Creators", issuePrefix: `AC${companyId.slice(0, 6).toUpperCase()}` });
    for (const principalId of [creatorId, peerId]) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId,
        status: "active",
        membershipRole: "operator",
      });
    }
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Mine",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        metadata: { [AGENT_CREATOR_METADATA_KEY]: creatorId },
      })
      .returning();
    agentId = agent!.id;
  }, 30_000);

  afterEach(() => {
    if (previous === undefined) delete process.env.PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE;
    else process.env.PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE = previous;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  function decide(userId: string, action: "agent_config:update" | "agent_instructions:update" | "agent_config:read" | "agents:configure") {
    return accessService(db).decide({
      actor: {
        type: "board",
        userId,
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      },
      action,
      resource: action === "agents:configure" ? { type: "company", companyId } : { type: "agent", companyId, agentId },
    });
  }

  it("keeps upstream behaviour when unset", async () => {
    delete process.env.PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE;
    expect((await decide(creatorId, "agent_config:update")).allowed).toBe(false);
  });

  it("lets the creator configure their own agent only", async () => {
    process.env.PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE = "true";
    const own = await decide(creatorId, "agent_config:update");
    expect(own).toMatchObject({ allowed: true, reason: "allow_agent_creator" });
    expect((await decide(creatorId, "agent_instructions:update")).allowed).toBe(true);
    // Creating an agent never becomes company-wide configure rights.
    expect((await decide(creatorId, "agents:configure")).allowed).toBe(false);
    // Another member cannot configure it.
    expect((await decide(peerId, "agent_config:update")).allowed).toBe(false);
  });

  it("stops once the creator is a viewer or suspended", async () => {
    process.env.PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE = "true";
    const where = and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, creatorId));
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(where);
    expect((await decide(creatorId, "agent_config:update")).allowed).toBe(false);
    await db.update(companyMemberships).set({ membershipRole: "operator", status: "suspended" }).where(where);
    expect((await decide(creatorId, "agent_config:update")).allowed).toBe(false);
    await db.update(companyMemberships).set({ status: "active" }).where(where);
    expect((await decide(creatorId, "agent_config:update")).allowed).toBe(true);
  });
});
