/**
 * Member agent policy (Dixie Flatline deployment patch).
 *
 * Lets an instance give ordinary company members (people without a
 * company-wide `agents:configure` grant) the ability to create agents while an
 * administrator keeps control of runtimes, models, credentials and execution
 * environments. Everything here is env-gated; with none of the variables set
 * the server behaves exactly like upstream.
 *
 * - PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE=true records the creating board user
 *   on new agents (`metadata.createdByUserId`) and lets that user configure,
 *   pause, resume, terminate and delete the agents they created. The
 *   agent-scoped management routes then also require agent-level configure
 *   rights, so `agents:create` alone no longer manages other people's agents.
 * - PAPERCLIP_MEMBER_ADAPTER_ALLOWLIST, PAPERCLIP_MEMBER_DEFAULT_ENVIRONMENT_NAME,
 *   PAPERCLIP_MEMBER_ADAPTER_DEFAULTS, PAPERCLIP_MEMBER_MODEL_ALLOWLIST and
 *   PAPERCLIP_MEMBER_ADAPTER_CONFIG_KEYS restrict what a member can choose when
 *   creating, updating or testing an agent.
 */

import { eq } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { environments } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";
import { AGENT_CREATOR_METADATA_KEY, agentCreatorUserId } from "./agent-creator-access.js";

export { AGENT_CREATOR_METADATA_KEY, agentCreatorUserId, userCreatedAgentAndMayConfigure } from "./agent-creator-access.js";


/** adapterConfig keys a member may set by default. Everything else comes from admin defaults. */
export const DEFAULT_MEMBER_ADAPTER_CONFIG_KEYS = [
  "model",
  "effort",
  "thinkingEffort",
  "modelReasoningEffort",
  "reasoningEffort",
  "variant",
  "fastMode",
  "search",
  "toolsets",
  "capabilities",
  "description",
  "instructions",
  "systemPrompt",
  "appendSystemPrompt",
] as const;

/** Instruction-bundle bookkeeping keys the server maintains; preserved on a member's full replace. */
const INSTRUCTIONS_BUNDLE_KEYS = [
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
] as const;

/**
 * Agent metadata key the Dixie plugin reads Slack behaviour from. Any actor
 * that may write the agent's metadata (including members on agents they
 * create) may set it; the shape and guardrails are enforced here so a member
 * cannot bypass the wizard's client-side checks.
 */
export const DIXIE_SLACK_METADATA_KEY = "dixieSlack";
const DIXIE_SLACK_MODES = new Set(["off", "mention", "keywords", "invite"]);
const DIXIE_SLACK_MAX_KEYWORDS = 10;
const DIXIE_SLACK_MIN_KEYWORD_LENGTH = 4;
const DIXIE_SLACK_MAX_CHANNELS = 100;

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value as string[];
}

/** Rejects a malformed `metadata.dixieSlack`; leaves other metadata alone. */
export function assertValidDixieSlackMetadata(metadata: unknown): void {
  if (!isPlainRecord(metadata) || !hasOwn(metadata, DIXIE_SLACK_METADATA_KEY)) return;
  const value = metadata[DIXIE_SLACK_METADATA_KEY];
  if (value === null) return;
  const invalid = (detail: string) =>
    unprocessable(`metadata.${DIXIE_SLACK_METADATA_KEY} ${detail}`, { code: "invalid_dixie_slack" });
  if (!isPlainRecord(value)) throw invalid("must be an object");
  const unknownKeys = Object.keys(value).filter((key) => !["mode", "channels", "keywords"].includes(key));
  if (unknownKeys.length > 0) throw invalid(`has unknown keys: ${unknownKeys.join(", ")}`);
  if (typeof value.mode !== "string" || !DIXIE_SLACK_MODES.has(value.mode)) {
    throw invalid("mode must be one of off, mention, keywords, invite");
  }
  const channels = value.channels === undefined ? [] : stringList(value.channels);
  if (!channels || channels.length > DIXIE_SLACK_MAX_CHANNELS || channels.some((id) => !id.trim())) {
    throw invalid(`channels must be a list of at most ${DIXIE_SLACK_MAX_CHANNELS} channel IDs`);
  }
  const keywords = value.keywords === undefined ? [] : stringList(value.keywords);
  if (!keywords) throw invalid("keywords must be a list of strings");
  if ((value.mode === "mention" || value.mode === "keywords") && channels.length === 0) {
    throw invalid(`needs at least one channel in ${value.mode} mode`);
  }
  if (value.mode === "keywords" && keywords.length === 0) throw invalid("needs at least one keyword in keywords mode");
  if (keywords.length > DIXIE_SLACK_MAX_KEYWORDS) throw invalid(`allows at most ${DIXIE_SLACK_MAX_KEYWORDS} keywords`);
  if (keywords.some((keyword) => keyword.trim().length < DIXIE_SLACK_MIN_KEYWORD_LENGTH)) {
    throw invalid(`keywords need at least ${DIXIE_SLACK_MIN_KEYWORD_LENGTH} characters each`);
  }
}

export type MemberModelEntry = {
  id: string;
  label?: string;
  /** Admin-controlled adapterConfig merged when this model is selected (for example a provider). */
  adapterConfig?: Record<string, unknown>;
};

export type MemberAgentPolicyConfig = {
  creatorCanConfigure: boolean;
  adapterAllowlist: ReadonlySet<string> | null;
  defaultEnvironmentName: string | null;
  adapterDefaults: Readonly<Record<string, Record<string, unknown>>>;
  modelAllowlist: Readonly<Record<string, MemberModelEntry[]>>;
  memberConfigKeys: ReadonlySet<string>;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseJsonObject(name: string, raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON object: ${(error as Error).message}`);
  }
  if (!isPlainRecord(parsed)) throw new Error(`${name} must be a JSON object`);
  return parsed;
}

/**
 * Reads the policy from the environment. Throws on malformed JSON so the server
 * refuses to start instead of silently failing open.
 */
export function readMemberAgentPolicyConfig(env: NodeJS.ProcessEnv = process.env): MemberAgentPolicyConfig {
  const allowlist = csv(env.PAPERCLIP_MEMBER_ADAPTER_ALLOWLIST);

  const defaultsRaw = parseJsonObject("PAPERCLIP_MEMBER_ADAPTER_DEFAULTS", env.PAPERCLIP_MEMBER_ADAPTER_DEFAULTS);
  const adapterDefaults: Record<string, Record<string, unknown>> = {};
  for (const [adapterType, fragment] of Object.entries(defaultsRaw)) {
    if (!isPlainRecord(fragment)) {
      throw new Error(`PAPERCLIP_MEMBER_ADAPTER_DEFAULTS.${adapterType} must be an object`);
    }
    adapterDefaults[adapterType] = fragment;
  }

  const modelsRaw = parseJsonObject("PAPERCLIP_MEMBER_MODEL_ALLOWLIST", env.PAPERCLIP_MEMBER_MODEL_ALLOWLIST);
  const modelAllowlist: Record<string, MemberModelEntry[]> = {};
  for (const [adapterType, list] of Object.entries(modelsRaw)) {
    if (!Array.isArray(list)) {
      throw new Error(`PAPERCLIP_MEMBER_MODEL_ALLOWLIST.${adapterType} must be an array`);
    }
    modelAllowlist[adapterType] = list.map((entry, index) => {
      if (typeof entry === "string" && entry.trim()) return { id: entry.trim() };
      if (isPlainRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
        if (entry.adapterConfig !== undefined && !isPlainRecord(entry.adapterConfig)) {
          throw new Error(`PAPERCLIP_MEMBER_MODEL_ALLOWLIST.${adapterType}[${index}].adapterConfig must be an object`);
        }
        return {
          id: entry.id.trim(),
          ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim() } : {}),
          ...(isPlainRecord(entry.adapterConfig) ? { adapterConfig: entry.adapterConfig } : {}),
        };
      }
      throw new Error(`PAPERCLIP_MEMBER_MODEL_ALLOWLIST.${adapterType}[${index}] must be a model id or {"id": ...}`);
    });
  }

  const configKeys = csv(env.PAPERCLIP_MEMBER_ADAPTER_CONFIG_KEYS);
  return {
    creatorCanConfigure: truthy(env.PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE),
    adapterAllowlist: allowlist.length > 0 ? new Set(allowlist) : null,
    defaultEnvironmentName: env.PAPERCLIP_MEMBER_DEFAULT_ENVIRONMENT_NAME?.trim() || null,
    adapterDefaults,
    modelAllowlist,
    memberConfigKeys: new Set(configKeys.length > 0 ? configKeys : DEFAULT_MEMBER_ADAPTER_CONFIG_KEYS),
  };
}

export function memberRestrictionsEnabled(config: MemberAgentPolicyConfig): boolean {
  return Boolean(
    config.adapterAllowlist ||
      config.defaultEnvironmentName ||
      Object.keys(config.adapterDefaults).length > 0 ||
      Object.keys(config.modelAllowlist).length > 0,
  );
}

/** Local CLI adapters run on an execution environment host. */
export function isLocalCliAdapter(adapterType: string): boolean {
  return adapterType.endsWith("_local");
}

type AccessDecider = {
  decide: (input: {
    actor: Request["actor"];
    action: "agents:configure";
    resource: { type: "company"; companyId: string };
  }) => Promise<{ allowed: boolean }>;
};

export type MemberAgentWriteMode = "create" | "update" | "test";

export type MemberAgentPolicyDescription = {
  restricted: boolean;
  adapterTypes: string[] | null;
  /** Environment that local CLI agents created by this user are pinned to. */
  localEnvironmentId: string | null;
  creatorCanConfigure: boolean;
};

function pick(record: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) out[key] = value;
  }
  return out;
}

function hasOwn(record: object, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function memberAgentPolicy(
  db: Db,
  access: AccessDecider,
  config: MemberAgentPolicyConfig = readMemberAgentPolicyConfig(),
) {
  const secrets = secretService(db);
  const restrictionsEnabled = memberRestrictionsEnabled(config);

  /**
   * A restricted member is a named board user without company-wide
   * `agents:configure` (instance admins, the local implicit board, owners and
   * admins all have it). Agent actors keep upstream behaviour.
   */
  async function isRestricted(req: Request, companyId: string): Promise<boolean> {
    if (!restrictionsEnabled) return false;
    if (req.actor.type !== "board" || req.actor.source === "local_implicit") return false;
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:configure",
      resource: { type: "company", companyId },
    });
    return !decision.allowed;
  }

  async function memberEnvironment(): Promise<{ id: string; name: string } | null> {
    if (!config.defaultEnvironmentName) return null;
    const row = await db
      .select({ id: environments.id, name: environments.name, status: environments.status, driver: environments.driver })
      .from(environments)
      .where(eq(environments.name, config.defaultEnvironmentName))
      .then((rows) => rows[0] ?? null);
    if (!row || row.status !== "active" || row.driver === "local") {
      throw unprocessable(
        `The administrator-configured agent environment "${config.defaultEnvironmentName}" is not available. Ask an administrator to fix PAPERCLIP_MEMBER_DEFAULT_ENVIRONMENT_NAME.`,
      );
    }
    return { id: row.id, name: row.name };
  }

  async function assertNotLocalEnvironment(environmentId: string) {
    const row = await db
      .select({ driver: environments.driver })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .then((rows) => rows[0] ?? null);
    if (row?.driver === "local") {
      throw forbidden("Agents you create cannot run in the Local environment.");
    }
  }

  /** Resolves `{ "type": "secret_ref", "secretKey": "..." }` placeholders to this company's secret ids. */
  async function resolveSecretKeyRefs(companyId: string, value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => resolveSecretKeyRefs(companyId, entry)));
    }
    if (!isPlainRecord(value)) return value;
    if (value.type === "secret_ref" && typeof value.secretKey === "string" && value.secretId === undefined) {
      const secret = await secrets.getByKey(companyId, value.secretKey);
      if (!secret) {
        throw unprocessable(
          `The administrator default references company secret "${value.secretKey}", which does not exist in this company.`,
        );
      }
      const { secretKey: _secretKey, ...rest } = value;
      return { ...rest, secretId: secret.id, version: rest.version ?? "latest" };
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = await resolveSecretKeyRefs(companyId, entry);
    }
    return out;
  }

  function modelEntriesFor(adapterType: string): MemberModelEntry[] | null {
    const entries = config.modelAllowlist[adapterType];
    return entries && entries.length > 0 ? entries : null;
  }

  function adapterNotAllowed(adapterType: string) {
    const allowed = [...(config.adapterAllowlist ?? [])].sort().join(", ");
    return forbidden(
      `Runtime "${adapterType}" is not available to your role. Approved runtimes: ${allowed || "(none)"}.`,
      { code: "member_adapter_not_allowed" },
    );
  }

  /**
   * Rewrites a member's agent create/update/test request body in place so it
   * only carries choices the member is allowed to make. No-op for unrestricted
   * callers.
   */
  async function applyToAgentWrite(
    req: Request,
    input: {
      companyId: string;
      mode: MemberAgentWriteMode;
      body: Record<string, unknown>;
      /** Adapter type from the URL for test requests. */
      adapterType?: string;
      existing?: {
        adapterType: string;
        adapterConfig: Record<string, unknown> | null | undefined;
        runtimeConfig?: Record<string, unknown> | null;
      } | null;
    },
  ): Promise<void> {
    if (input.mode !== "test") assertValidDixieSlackMetadata(input.body.metadata);
    if (!(await isRestricted(req, input.companyId))) return;
    const { body, mode, existing } = input;

    const adapterType =
      mode === "test"
        ? (input.adapterType ?? "")
        : typeof body.adapterType === "string"
          ? body.adapterType.trim()
          : (existing?.adapterType ?? "");
    const changingAdapterType = Boolean(existing && adapterType !== existing.adapterType);

    const touchesRuntime =
      mode !== "update" ||
      hasOwn(body, "adapterType") ||
      hasOwn(body, "adapterConfig") ||
      hasOwn(body, "defaultEnvironmentId") ||
      hasOwn(body, "runtimeConfig") ||
      body.replaceAdapterConfig === true;
    if (!touchesRuntime) return;

    if (config.adapterAllowlist && !config.adapterAllowlist.has(adapterType)) {
      throw adapterNotAllowed(adapterType);
    }

    // Credentials: members never supply AI connections or test credentials.
    if (mode === "test") {
      if (body.aiConnection !== undefined && body.aiConnection !== null) {
        throw forbidden("AI connections for your agents are chosen by an administrator.");
      }
      delete body.testCredentials;
    } else if (isPlainRecord(body.runtimeConfig) && body.runtimeConfig.aiConnection !== undefined) {
      const existingBinding = existing?.runtimeConfig?.aiConnection;
      if (JSON.stringify(body.runtimeConfig.aiConnection) !== JSON.stringify(existingBinding)) {
        throw forbidden("AI connections for your agents are chosen by an administrator.");
      }
    }

    // Adapter configuration: member keys from the allowlist over admin defaults.
    const rewriteConfig = mode !== "update" || hasOwn(body, "adapterConfig") || changingAdapterType;
    if (rewriteConfig) {
      const memberConfig = pick(isPlainRecord(body.adapterConfig) ? body.adapterConfig : {}, config.memberConfigKeys);
      const defaults = (await resolveSecretKeyRefs(
        input.companyId,
        config.adapterDefaults[adapterType] ?? {},
      )) as Record<string, unknown>;
      const existingConfig = existing && !changingAdapterType && isPlainRecord(existing.adapterConfig)
        ? existing.adapterConfig
        : {};

      let modelFragment: Record<string, unknown> = {};
      const entries = modelEntriesFor(adapterType);
      if (entries) {
        const requested =
          (typeof memberConfig.model === "string" && memberConfig.model.trim()) ||
          (typeof existingConfig.model === "string" && existingConfig.model.trim()) ||
          (typeof defaults.model === "string" && defaults.model.trim()) ||
          entries[0]!.id;
        const entry = entries.find((candidate) => candidate.id === requested);
        if (!entry) {
          throw forbidden(
            `Model "${requested}" is not approved for ${adapterType}. Approved models: ${entries.map((candidate) => candidate.id).join(", ")}.`,
            { code: "member_model_not_allowed" },
          );
        }
        memberConfig.model = entry.id;
        modelFragment = (await resolveSecretKeyRefs(input.companyId, entry.adapterConfig ?? {})) as Record<string, unknown>;
      }

      let next: Record<string, unknown> = { ...defaults, ...memberConfig, ...modelFragment };
      if (mode === "update" && body.replaceAdapterConfig === true) {
        const bundle: Record<string, unknown> = {};
        for (const key of INSTRUCTIONS_BUNDLE_KEYS) {
          if (existingConfig[key] !== undefined) bundle[key] = existingConfig[key];
        }
        next = { ...bundle, ...next };
      }
      body.adapterConfig = next;
    }

    // Execution environment.
    const environmentField = mode === "test" ? "environmentId" : "defaultEnvironmentId";
    const requestedEnvironment = typeof body[environmentField] === "string" && body[environmentField]
      ? (body[environmentField] as string)
      : null;
    if (config.defaultEnvironmentName && isLocalCliAdapter(adapterType)) {
      const pinned = await memberEnvironment();
      if (requestedEnvironment && requestedEnvironment !== pinned!.id) {
        throw forbidden(`Agents you create on ${adapterType} run in the "${pinned!.name}" environment.`, {
          code: "member_environment_not_allowed",
        });
      }
      body[environmentField] = pinned!.id;
    } else if (config.defaultEnvironmentName && requestedEnvironment) {
      await assertNotLocalEnvironment(requestedEnvironment);
    }
  }

  /** Model list override for the model picker. Null means "use the adapter's own list". */
  async function allowedModelsFor(req: Request, companyId: string, adapterType: string) {
    const entries = modelEntriesFor(adapterType);
    if (!entries || !(await isRestricted(req, companyId))) return null;
    return entries.map((entry) => ({ id: entry.id, label: entry.label ?? entry.id }));
  }

  /** Stamps the creating board user on a new agent's metadata. */
  function recordCreator(req: Request, body: Record<string, unknown>) {
    if (!config.creatorCanConfigure) return;
    const metadata = isPlainRecord(body.metadata) ? { ...body.metadata } : {};
    // The creator is always derived from the authenticated actor, never the payload.
    delete metadata[AGENT_CREATOR_METADATA_KEY];
    if (req.actor.type === "board" && req.actor.userId) {
      metadata[AGENT_CREATOR_METADATA_KEY] = req.actor.userId;
    }
    if (Object.keys(metadata).length > 0 || isPlainRecord(body.metadata)) body.metadata = metadata;
  }

  /** Keeps the recorded creator when an agent's metadata is replaced. */
  function preserveCreator(existingMetadata: unknown, body: Record<string, unknown>) {
    if (!config.creatorCanConfigure || !hasOwn(body, "metadata")) return;
    const creator = agentCreatorUserId(existingMetadata);
    if (!creator) return;
    const metadata = isPlainRecord(body.metadata) ? body.metadata : {};
    body.metadata = { ...metadata, [AGENT_CREATOR_METADATA_KEY]: creator };
  }

  async function describe(req: Request, companyId: string): Promise<MemberAgentPolicyDescription> {
    const restricted = await isRestricted(req, companyId);
    let localEnvironmentId: string | null = null;
    if (restricted && config.defaultEnvironmentName) {
      try {
        localEnvironmentId = (await memberEnvironment())?.id ?? null;
      } catch {
        localEnvironmentId = null;
      }
    }
    return {
      restricted,
      adapterTypes: restricted && config.adapterAllowlist ? [...config.adapterAllowlist].sort() : null,
      localEnvironmentId,
      creatorCanConfigure: config.creatorCanConfigure,
    };
  }

  return {
    config,
    isRestricted,
    applyToAgentWrite,
    allowedModelsFor,
    recordCreator,
    preserveCreator,
    describe,
  };
}

export type MemberAgentPolicy = ReturnType<typeof memberAgentPolicy>;
