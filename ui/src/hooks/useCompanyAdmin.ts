import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { useOptionalCompany } from "@/context/CompanyContext";

/**
 * Whether the board administers `companyId`: local implicit boards and
 * instance admins always do; otherwise the active company membership must be
 * owner or admin. Everyone else is a member (an employee) and sees only the
 * work surfaces. Resolves to false while the snapshot is unknown. The server
 * stays authoritative; this only decides which navigation and pages to offer.
 */
export function isCompanyAdmin(
  companyId: string | null | undefined,
  boardAccess: CurrentBoardAccess | undefined,
): boolean {
  if (!boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;
  if (!companyId) return false;
  const membership = boardAccess.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  return membership?.membershipRole === "owner" || membership?.membershipRole === "admin";
}

/**
 * Admin status for the selected company. `loaded` stays false until the board
 * access snapshot resolves, so callers can avoid flashing admin-only UI.
 */
export function useCompanyAdmin(): { isAdmin: boolean; loaded: boolean } {
  const company = useOptionalCompany();
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 30_000,
  });
  return {
    isAdmin: isCompanyAdmin(company?.selectedCompanyId, boardAccess.data),
    loaded: !boardAccess.isLoading,
  };
}
