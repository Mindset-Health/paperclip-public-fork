import { Button } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand";

/**
 * Sign-in state for instances behind Google Cloud IAP (`authProvider: "gcp-iap"`).
 *
 * The server mints the session from the IAP identity on the first API request,
 * so a visitor only lands here after an explicit sign-out or when IAP did not
 * vouch for them. Re-authentication is always a deliberate click, never an
 * automatic redirect, so signing out cannot loop.
 */
export function GcpIapSignIn({ returnTo }: { returnTo: string }) {
  const resumeUrl = `/api/auth/gcp-iap/resume?next=${encodeURIComponent(returnTo)}`;
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="mx-auto max-w-md space-y-4 p-6 text-center">
        <h1 className="text-xl font-semibold">You are signed out of {BRAND_NAME}</h1>
        <p className="text-sm text-muted-foreground">
          {BRAND_NAME} signs you in with your Google Workspace account through Identity-Aware Proxy.
          Sign in again to continue, or close this tab.
        </p>
        <div className="flex flex-col items-center gap-2">
          <Button asChild>
            <a href={resumeUrl}>Sign in again</a>
          </Button>
          <a className="text-xs text-muted-foreground underline underline-offset-2" href="/?gcp-iap-mode=CLEAR_LOGIN_COOKIE">
            Use a different Google account
          </a>
        </div>
      </div>
    </div>
  );
}
