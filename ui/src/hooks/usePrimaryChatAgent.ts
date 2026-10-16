import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Dixie: URL key of the company's main chat agent (`primaryChatAgent` in
 * health, from PAPERCLIP_PRIMARY_CHAT_AGENT), or null when unset. The Chat
 * landing opens this agent's conversation. CloudAccessGate owns the fetch.
 */
export function usePrimaryChatAgent(): string | null {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: false,
  });
  return healthQuery.data?.primaryChatAgent ?? null;
}
