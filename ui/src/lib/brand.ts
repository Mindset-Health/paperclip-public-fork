/**
 * Dixie Flatline product branding for the board UI.
 *
 * This fork (Mindset Health's "Dixie Flatline") keeps upstream Paperclip
 * source strings intact so rebases stay cheap. User-visible "Paperclip" copy
 * is rewritten at build time by `vite-dixie-brand.ts`; components that need
 * the name programmatically import it from here.
 */
export const BRAND_NAME = "Dixie Flatline";
export const BRAND_SHORT_NAME = "Dixie";
/** Upstream product name that the build-time rewrite replaces. */
export const UPSTREAM_BRAND_NAME = "Paperclip";
