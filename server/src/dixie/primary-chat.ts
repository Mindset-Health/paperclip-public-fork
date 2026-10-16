/**
 * Dixie: the company's main chat agent.
 *
 * `PAPERCLIP_PRIMARY_CHAT_AGENT` names one agent by URL key (or id). The Chat
 * landing (`/chats`) opens that agent's conversation instead of the agent
 * picker, so employees talk to it first; every other agent stays reachable
 * from the chat rail and agent pages. Health reports the reference so the UI
 * needs no extra request. Unset keeps upstream behaviour.
 */
const AGENT_REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export function resolvePrimaryChatAgent(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.PAPERCLIP_PRIMARY_CHAT_AGENT?.trim() ?? "";
  return AGENT_REF.test(value) ? value : null;
}
