/**
 * Agent creator access (Dixie Flatline deployment patch).
 *
 * With PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE=true the board user who created an
 * agent (recorded as `metadata.createdByUserId`) may read and change that
 * agent's configuration without a company-wide `agents:configure` grant. Kept
 * dependency-light because the authorization service imports it.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships } from "@paperclipai/db";
import { normalizeHumanRole } from "./company-member-roles.js";

export const AGENT_CREATOR_METADATA_KEY = "createdByUserId";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function agentCreatorUserId(metadata: unknown): string | null {
  if (!isPlainRecord(metadata)) return null;
  const value = metadata[AGENT_CREATOR_METADATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Authorization hook: true when creator configuration is enabled and `userId`
 * created the agent and is still an active, non-viewer member of its company.
 */
export async function userCreatedAgentAndMayConfigure(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: { companyId: string; agentId: string; userId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!truthy(env.PAPERCLIP_AGENT_CREATOR_CAN_CONFIGURE)) return false;
  const agent = await db
    .select({ companyId: agents.companyId, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .then((rows) => rows[0] ?? null);
  if (!agent || agent.companyId !== input.companyId) return false;
  if (agentCreatorUserId(agent.metadata) !== input.userId) return false;
  const membership = await db
    .select({ status: companyMemberships.status, membershipRole: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.userId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return Boolean(
    membership &&
      membership.status === "active" &&
      normalizeHumanRole(membership.membershipRole, "viewer") !== "viewer",
  );
}

