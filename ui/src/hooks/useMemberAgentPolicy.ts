import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

/**
 * Server-computed member agent policy (Dixie Flatline deployment patch).
 * `restricted` is true for people without company-wide `agents:configure`
 * when the instance limits the runtimes, models, credentials and environments
 * members may choose. The server enforces every rule; the UI only hides
 * choices that would be rejected.
 */
export type MemberAgentPolicy = {
  restricted: boolean;
  adapterTypes: string[] | null;
  localEnvironmentId: string | null;
  creatorCanConfigure: boolean;
};

const UNRESTRICTED: MemberAgentPolicy = {
  restricted: false,
  adapterTypes: null,
  localEnvironmentId: null,
  creatorCanConfigure: false,
};

export function useMemberAgentPolicy(companyId: string | null | undefined) {
  const query = useQuery({
    queryKey: ["member-agent-policy", companyId ?? null],
    queryFn: () => api.get<MemberAgentPolicy>(`/companies/${companyId}/member-agent-policy`),
    enabled: Boolean(companyId),
    retry: false,
    staleTime: 60_000,
  });
  return {
    policy: query.data ?? UNRESTRICTED,
    isPending: Boolean(companyId) && query.isPending,
  };
}

/** True when a restricted member may pick this adapter type. */
export function memberMayUseAdapter(policy: MemberAgentPolicy, adapterType: string): boolean {
  return !policy.restricted || !policy.adapterTypes || policy.adapterTypes.includes(adapterType);
}
