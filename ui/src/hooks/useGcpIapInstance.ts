import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/**
 * True when the instance sits behind Google Cloud IAP (`authProvider: "gcp-iap"`).
 * Every allowed user is provisioned into the single company automatically, so
 * company switching, creation and invitations do not apply there.
 * CloudAccessGate owns the fetch; this observer never issues its own request.
 */
export function useGcpIapInstance() {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: false,
  });

  return healthQuery.data?.authProvider === "gcp-iap";
}
