/**
 * Find-or-create provisioning for users authenticated by Google Cloud IAP.
 *
 * Shared by the IAP session endpoint and the headless bootstrap command so a
 * user created either way ends up with identical rows.
 *
 * - The Better Auth user is matched by (case-insensitive) email.
 * - Emails listed in PAPERCLIP_IAP_ADMIN_EMAILS become instance admins; this
 *   replaces the board-claim flow, so the implicit `local-board` admin is
 *   removed exactly as a successful board claim would remove it.
 * - Every user is ensured an active membership in every existing company
 *   (admins as `owner`, everyone else as `operator`). Existing memberships are
 *   left untouched, so a role change or suspension made in the UI sticks.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const LOCAL_BOARD_USER_ID = "local-board";

export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local
    .split(/[._+]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.replace(/(^|-)([a-z])/g, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`));
  return words.join(" ") || email;
}

export type GcpIapProvisionResult = {
  userId: string;
  created: boolean;
  isInstanceAdmin: boolean;
  membershipsCreated: number;
};

export async function provisionGcpIapUser(
  db: Db,
  input: { email: string; isAdmin: boolean; now?: Date },
): Promise<GcpIapProvisionResult> {
  const email = input.email.trim().toLowerCase();
  const now = input.now ?? new Date();

  let created = false;
  let user = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`)
    .orderBy(authUsers.createdAt)
    .then((rows) => rows[0] ?? null);
  if (!user) {
    const id = randomUUID();
    await db.insert(authUsers).values({
      id,
      name: displayNameFromEmail(email),
      email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    user = { id };
    created = true;
  }
  const userId = user.id;

  let isInstanceAdmin = false;
  if (input.isAdmin) {
    await db
      .insert(instanceUserRoles)
      .values({ userId, role: "instance_admin" })
      .onConflictDoNothing();
    await db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")));
    isInstanceAdmin = true;
  } else {
    isInstanceAdmin = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows.length > 0);
  }

  const membershipRole = input.isAdmin ? "owner" : "operator";
  const allCompanies = await db.select({ id: companies.id }).from(companies);
  let membershipsCreated = 0;
  for (const company of allCompanies) {
    const inserted = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole,
      })
      .onConflictDoNothing()
      .returning({ id: companyMemberships.id });
    if (inserted.length === 0) continue;
    membershipsCreated += 1;
    await ensureHumanRoleDefaultGrants(db, {
      companyId: company.id,
      principalId: userId,
      membershipRole,
      grantedByUserId: null,
    });
  }

  return { userId, created, isInstanceAdmin, membershipsCreated };
}
