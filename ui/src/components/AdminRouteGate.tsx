import { ShieldAlert } from "lucide-react";
import { Link, Outlet } from "@/lib/router";
import { useCompanyAdmin } from "@/hooks/useCompanyAdmin";

/**
 * Route gate for admin pages (audit, costs, company and instance settings,
 * skill sources). Company owners/admins and instance admins pass; members see
 * a short explanation instead of a page whose actions would all fail. Nothing
 * renders until board access resolves, so admin pages never flash. The server
 * stays authoritative.
 */
export function AdminRouteGate() {
  const { isAdmin, loaded } = useCompanyAdmin();

  if (!loaded) return null;
  if (isAdmin) return <Outlet />;

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2 text-foreground">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">This page is for administrators</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Ask a company admin if you need something changed here, or head back to{" "}
          <Link to="/dashboard" className="font-medium text-primary hover:underline">
            your dashboard
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
