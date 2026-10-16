/**
 * Admin-only connections (Dixie Flatline deployment patch).
 *
 * With PAPERCLIP_CONNECTIONS_ADMIN_ONLY=true, creating a connection credential
 * (including a personal "Just me" connection), authorizing a personal grant and
 * delegating a personal grant to an agent require connection-manager rights
 * (`tools:manage_connections`, which company owners and admins hold). Members
 * can still view connections and request agent access. Unset, upstream
 * behaviour is unchanged.
 */

export const PERSONAL_CONNECTION_DENIAL_REASON =
  "Connections are managed by administrators on this instance. Ask a company owner, administrator, or connection manager to connect this app.";

export function connectionsAdminOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.PAPERCLIP_CONNECTIONS_ADMIN_ONLY ?? "").trim().toLowerCase());
}
