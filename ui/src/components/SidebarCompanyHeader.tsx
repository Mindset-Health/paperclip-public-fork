import { useCompany } from "@/context/CompanyContext";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

/**
 * Static company header for single-company instances (Google Cloud IAP), where
 * the organization switcher has nothing to switch, create or invite.
 * Its inset matches the switcher trigger so the avatar lines up with nav icons.
 */
export function SidebarCompanyHeader() {
  const { selectedCompany } = useCompany();
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const name = selectedCompany?.name ?? null;

  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-2 px-4" title={name ?? undefined}>
      {selectedCompany ? (
        <CompanyPatternIcon
          companyName={selectedCompany.name}
          logoUrl={selectedCompany.logoUrl}
          className="size-5 shrink-0 rounded-md text-(length:--text-micro)"
        />
      ) : null}
      <span
        className={cn("min-w-0 truncate text-sm font-bold text-foreground", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}
      >
        {name}
      </span>
    </div>
  );
}
