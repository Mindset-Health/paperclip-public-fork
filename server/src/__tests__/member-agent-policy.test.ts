import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companySecrets, createDb, environments } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  AGENT_CREATOR_METADATA_KEY,
  assertValidDixieSlackMetadata,
  memberAgentPolicy,
  memberRestrictionsEnabled,
  readMemberAgentPolicyConfig,
} from "../services/member-agent-policy.js";
import { HttpError } from "../errors.js";
import { redactEventPayload } from "../redaction.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const MEMBER_ID = "member-user";
const ADMIN_ID = "admin-user";

function boardRequest(userId: string): Request {
  return {
    actor: { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [] },
  } as unknown as Request;
}

/** Members lack company-wide agents:configure; admins have it. */
const access = {
  decide: async (input: { actor: Request["actor"] }) => ({
    allowed: input.actor.type === "board" && input.actor.userId === ADMIN_ID,
  }),
};

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("expected a rejection");
}

describe("readMemberAgentPolicyConfig", () => {
  it("is off by default", () => {
    const config = readMemberAgentPolicyConfig({});
    expect(memberRestrictionsEnabled(config)).toBe(false);
    expect(config.creatorCanConfigure).toBe(false);
  });

  it("refuses malformed JSON so the server fails closed", () => {
    expect(() => readMemberAgentPolicyConfig({ PAPERCLIP_MEMBER_ADAPTER_DEFAULTS: "{nope" })).toThrow(
      /PAPERCLIP_MEMBER_ADAPTER_DEFAULTS/,
    );
    expect(() => readMemberAgentPolicyConfig({ PAPERCLIP_MEMBER_MODEL_ALLOWLIST: '{"claude_local":"x"}' })).toThrow(
      /must be an array/,
    );
  });

  it("parses string and object model entries", () => {
    const config = readMemberAgentPolicyConfig({
      PAPERCLIP_MEMBER_MODEL_ALLOWLIST: JSON.stringify({
        dixie_hermes: ["claude-sonnet-4-6", { id: "google/gemini-2.5-pro", adapterConfig: { provider: "vertex" } }],
      }),
    });
    expect(config.modelAllowlist.dixie_hermes).toEqual([
      { id: "claude-sonnet-4-6" },
      { id: "google/gemini-2.5-pro", adapterConfig: { provider: "vertex" } },
    ]);
  });
});

describe("metadata.dixieSlack", () => {
  const valid = { mode: "keywords", channels: ["C0123ABCD"], keywords: ["deploy", "incident"] };

  it("accepts every mode with valid fields and ignores other metadata", () => {
    expect(() => assertValidDixieSlackMetadata({ dixieSlack: valid, team: "x" })).not.toThrow();
    expect(() => assertValidDixieSlackMetadata({ dixieSlack: { mode: "off", channels: [], keywords: [] } })).not.toThrow();
    expect(() => assertValidDixieSlackMetadata({ dixieSlack: { mode: "invite", channels: [], keywords: [] } })).not.toThrow();
    expect(() => assertValidDixieSlackMetadata({ dixieSlack: { mode: "mention", channels: ["C1"] } })).not.toThrow();
    expect(() => assertValidDixieSlackMetadata({ team: "x" })).not.toThrow();
    expect(() => assertValidDixieSlackMetadata(null)).not.toThrow();
  });

  it("rejects bad modes, missing channels and keyword guardrail violations", () => {
    for (const bad of [
      "keywords",
      { mode: "all", channels: ["C1"] },
      { mode: "mention", channels: [] },
      { mode: "keywords", channels: ["C1"], keywords: [] },
      { mode: "keywords", channels: ["C1"], keywords: ["ops"] },
      { mode: "keywords", channels: ["C1"], keywords: Array.from({ length: 11 }, (_, i) => `word${i}`) },
      { mode: "invite", channels: [1] },
      { mode: "invite", channels: [], everyMessage: true },
    ]) {
      expect(() => assertValidDixieSlackMetadata({ dixieSlack: bad }), JSON.stringify(bad)).toThrow(HttpError);
    }
  });

  it("survives the redaction applied to hire approval payloads", () => {
    const metadata = { dixieSlack: valid, [AGENT_CREATOR_METADATA_KEY]: MEMBER_ID };
    expect(redactEventPayload(metadata)).toEqual(metadata);
  });
});

describeDatabase("member agent policy", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  let companyId!: string;
  let runnerEnvironmentId!: string;
  let localEnvironmentId!: string;
  let anthropicSecretId!: string;

  const env = {
    PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE: "true",
    PAPERCLIP_MEMBER_ADAPTER_ALLOWLIST: "dixie_hermes,claude_local",
    PAPERCLIP_MEMBER_DEFAULT_ENVIRONMENT_NAME: "Runner runner-1",
    PAPERCLIP_MEMBER_ADAPTER_DEFAULTS: JSON.stringify({
      claude_local: {
        engine: "cli",
        dangerouslySkipPermissions: true,
        env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretKey: "anthropic_api_key" } },
      },
      dixie_hermes: { toolsets: ["web"] },
    }),
    PAPERCLIP_MEMBER_MODEL_ALLOWLIST: JSON.stringify({
      claude_local: ["claude-sonnet-4-6", "claude-opus-4-1"],
      dixie_hermes: [
        { id: "claude-sonnet-4-6", adapterConfig: { provider: "anthropic" } },
        { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", adapterConfig: { provider: "vertex" } },
      ],
    }),
  };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("member-agent-policy");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Policy", issuePrefix: `MP${companyId.slice(0, 6).toUpperCase()}` });
    const [runner] = await db
      .insert(environments)
      .values({ name: "Runner runner-1", driver: "ssh", status: "active" })
      .returning();
    runnerEnvironmentId = runner!.id;
    // Migrations seed the instance's single Local environment.
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local"));
    localEnvironmentId = local!.id;
    const [secret] = await db
      .insert(companySecrets)
      .values({ companyId, key: "anthropic_api_key", name: "anthropic_api_key" })
      .returning();
    anthropicSecretId = secret!.id;
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  function policy() {
    return memberAgentPolicy(db, access, readMemberAgentPolicyConfig(env));
  }

  it("leaves admins untouched", async () => {
    const body: Record<string, unknown> = { adapterType: "process", adapterConfig: { command: "rm -rf /" } };
    await policy().applyToAgentWrite(boardRequest(ADMIN_ID), { companyId, mode: "create", body });
    expect(body).toEqual({ adapterType: "process", adapterConfig: { command: "rm -rf /" } });
  });

  it("leaves agent actors and the local board untouched", async () => {
    const body: Record<string, unknown> = { adapterType: "process", adapterConfig: {} };
    const agentReq = { actor: { type: "agent", agentId: randomUUID(), companyId } } as unknown as Request;
    await policy().applyToAgentWrite(agentReq, { companyId, mode: "create", body });
    const localReq = { actor: { type: "board", userId: "local-board", source: "local_implicit" } } as unknown as Request;
    await policy().applyToAgentWrite(localReq, { companyId, mode: "create", body });
    expect(body.adapterType).toBe("process");
  });

  it("rejects runtimes outside the member allowlist", async () => {
    for (const adapterType of ["process", "http", "hermes_local", "codex_local"]) {
      const error = await rejection(
        policy().applyToAgentWrite(boardRequest(MEMBER_ID), {
          companyId,
          mode: "create",
          body: { adapterType, adapterConfig: {} },
        }),
      );
      expect(error.status).toBe(403);
      expect(error.details).toMatchObject({ code: "member_adapter_not_allowed" });
    }
  });

  it("drops member credentials and host settings, merges admin defaults, and pins the runner", async () => {
    const body: Record<string, unknown> = {
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-opus-4-1",
        effort: "high",
        command: "/bin/sh",
        cwd: "/",
        engine: "sdk",
        env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-member" } },
        dangerouslySkipPermissions: false,
      },
    };
    await policy().applyToAgentWrite(boardRequest(MEMBER_ID), { companyId, mode: "create", body });
    expect(body.adapterConfig).toEqual({
      engine: "cli",
      dangerouslySkipPermissions: true,
      env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: anthropicSecretId, version: "latest" } },
      model: "claude-opus-4-1",
      effort: "high",
    });
    expect(body.defaultEnvironmentId).toBe(runnerEnvironmentId);
  });

  it("rejects the Local environment and any other environment for local CLI runtimes", async () => {
    for (const environmentId of [localEnvironmentId, randomUUID()]) {
      const error = await rejection(
        policy().applyToAgentWrite(boardRequest(MEMBER_ID), {
          companyId,
          mode: "create",
          body: { adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" }, defaultEnvironmentId: environmentId },
        }),
      );
      expect(error.status).toBe(403);
    }
  });

  it("rejects the Local environment for other runtimes", async () => {
    const error = await rejection(
      policy().applyToAgentWrite(boardRequest(MEMBER_ID), {
        companyId,
        mode: "create",
        body: { adapterType: "dixie_hermes", adapterConfig: {}, defaultEnvironmentId: localEnvironmentId },
      }),
    );
    expect(error.status).toBe(403);
  });

  it("enforces the model allowlist and applies per-model admin config", async () => {
    const rejected = await rejection(
      policy().applyToAgentWrite(boardRequest(MEMBER_ID), {
        companyId,
        mode: "create",
        body: { adapterType: "dixie_hermes", adapterConfig: { model: "gpt-5" } },
      }),
    );
    expect(rejected.status).toBe(403);
    expect(rejected.details).toMatchObject({ code: "member_model_not_allowed" });

    const body: Record<string, unknown> = {
      adapterType: "dixie_hermes",
      adapterConfig: { model: "google/gemini-2.5-flash", provider: "openai", toolsets: ["web", "code"] },
    };
    await policy().applyToAgentWrite(boardRequest(MEMBER_ID), { companyId, mode: "create", body });
    expect(body.adapterConfig).toEqual({ toolsets: ["web", "code"], model: "google/gemini-2.5-flash", provider: "vertex" });
    // dixie_hermes is not a local CLI runtime, so no environment is pinned.
    expect(body.defaultEnvironmentId).toBeUndefined();

    const defaulted: Record<string, unknown> = { adapterType: "dixie_hermes", adapterConfig: {} };
    await policy().applyToAgentWrite(boardRequest(MEMBER_ID), { companyId, mode: "create", body: defaulted });
    expect(defaulted.adapterConfig).toMatchObject({ model: "claude-sonnet-4-6", provider: "anthropic" });
  });

  it("refuses member-chosen AI connections and test credentials", async () => {
    const error = await rejection(
      policy().applyToAgentWrite(boardRequest(MEMBER_ID), {
        companyId,
        mode: "create",
        body: {
          adapterType: "claude_local",
          adapterConfig: { model: "claude-sonnet-4-6" },
          runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } },
        },
      }),
    );
    expect(error.status).toBe(403);

    const testBody: Record<string, unknown> = {
      adapterConfig: { model: "claude-sonnet-4-6" },
      testCredentials: { ANTHROPIC_API_KEY: "sk-member" },
      environmentId: localEnvironmentId,
    };
    const testError = await rejection(
      policy().applyToAgentWrite(boardRequest(MEMBER_ID), { companyId, mode: "test", adapterType: "claude_local", body: testBody }),
    );
    expect(testError.status).toBe(403);
    const allowedTest: Record<string, unknown> = {
      adapterConfig: { model: "claude-sonnet-4-6" },
      testCredentials: { ANTHROPIC_API_KEY: "sk-member" },
    };
    await policy().applyToAgentWrite(boardRequest(MEMBER_ID), { companyId, mode: "test", adapterType: "claude_local", body: allowedTest });
    expect(allowedTest.testCredentials).toBeUndefined();
    expect(allowedTest.environmentId).toBe(runnerEnvironmentId);
  });

  it("filters updates and keeps unrelated edits untouched", async () => {
    const existing = {
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-6", engine: "cli", instructionsFilePath: "/data/AGENTS.md" },
      runtimeConfig: {},
    };
    const nameOnly: Record<string, unknown> = { name: "Renamed" };
    await policy().applyToAgentWrite(boardRequest(MEMBER_ID), { companyId, mode: "update", body: nameOnly, existing });
    expect(nameOnly).toEqual({ name: "Renamed" });

    const replace: Record<string, unknown> = {
      adapterConfig: { model: "claude-opus-4-1", extraArgs: ["--dangerous"] },
      replaceAdapterConfig: true,
    };
    await policy().applyToAgentWrite(boardRequest(MEMBER_ID), { companyId, mode: "update", body: replace, existing });
    expect(replace.adapterConfig).toEqual({
      instructionsFilePath: "/data/AGENTS.md",
      engine: "cli",
      dangerouslySkipPermissions: true,
      env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: anthropicSecretId, version: "latest" } },
      model: "claude-opus-4-1",
    });
    expect(replace.defaultEnvironmentId).toBe(runnerEnvironmentId);

    const switchRuntime = await rejection(
      policy().applyToAgentWrite(boardRequest(MEMBER_ID), {
        companyId,
        mode: "update",
        body: { adapterType: "process" },
        existing,
      }),
    );
    expect(switchRuntime.status).toBe(403);
  });

  it("reports an unavailable member environment instead of failing open", async () => {
    const broken = memberAgentPolicy(
      db,
      access,
      readMemberAgentPolicyConfig({ ...env, PAPERCLIP_MEMBER_DEFAULT_ENVIRONMENT_NAME: "Missing runner" }),
    );
    const error = await rejection(
      broken.applyToAgentWrite(boardRequest(MEMBER_ID), {
        companyId,
        mode: "create",
        body: { adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" } },
      }),
    );
    expect(error.status).toBe(422);
  });

  it("returns only approved models to restricted members", async () => {
    expect(await policy().allowedModelsFor(boardRequest(MEMBER_ID), companyId, "dixie_hermes")).toEqual([
      { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ]);
    expect(await policy().allowedModelsFor(boardRequest(ADMIN_ID), companyId, "dixie_hermes")).toBeNull();
    expect(await policy().allowedModelsFor(boardRequest(MEMBER_ID), companyId, "gemini_local")).toBeNull();
  });

  it("describes the policy for the UI", async () => {
    expect(await policy().describe(boardRequest(MEMBER_ID), companyId)).toEqual({
      restricted: true,
      adapterTypes: ["claude_local", "dixie_hermes"],
      localEnvironmentId: runnerEnvironmentId,
      creatorCanConfigure: true,
    });
    expect(await policy().describe(boardRequest(ADMIN_ID), companyId)).toMatchObject({ restricted: false, adapterTypes: null });
  });

  it("records the creator from the actor, never from the payload", () => {
    const body: Record<string, unknown> = { metadata: { [AGENT_CREATOR_METADATA_KEY]: "someone-else", team: "x" } };
    policy().recordCreator(boardRequest(MEMBER_ID), body);
    expect(body.metadata).toEqual({ team: "x", [AGENT_CREATOR_METADATA_KEY]: MEMBER_ID });

    const agentBody: Record<string, unknown> = { metadata: { [AGENT_CREATOR_METADATA_KEY]: MEMBER_ID } };
    policy().recordCreator({ actor: { type: "agent", agentId: randomUUID() } } as unknown as Request, agentBody);
    expect(agentBody.metadata).toEqual({});

    const replaced: Record<string, unknown> = { metadata: { team: "y" } };
    policy().preserveCreator({ [AGENT_CREATOR_METADATA_KEY]: MEMBER_ID }, replaced);
    expect(replaced.metadata).toEqual({ team: "y", [AGENT_CREATOR_METADATA_KEY]: MEMBER_ID });
  });

  it("does nothing when the policy is unset", async () => {
    const upstream = memberAgentPolicy(db, access, readMemberAgentPolicyConfig({}));
    const body: Record<string, unknown> = { adapterType: "process", adapterConfig: { command: "x" }, metadata: { a: 1 } };
    await upstream.applyToAgentWrite(boardRequest(MEMBER_ID), { companyId, mode: "create", body });
    upstream.recordCreator(boardRequest(MEMBER_ID), body);
    expect(body).toEqual({ adapterType: "process", adapterConfig: { command: "x" }, metadata: { a: 1 } });
  });
});
