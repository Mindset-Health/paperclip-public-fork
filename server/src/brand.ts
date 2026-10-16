/**
 * Dixie Flatline product branding for server-generated, user-visible text
 * (HTML pages, chat notifications, API error messages).
 *
 * Upstream Paperclip strings stay in the source so rebases remain cheap; the
 * few user-facing surfaces route their text through `rebrandText`, which
 * replaces the standalone product name only. Lowercase `paperclip` (API paths,
 * env vars, CLI and package names), identifiers such as `PaperclipCloud`, and
 * the names of upstream's hosted services ("Paperclip Cloud", "Paperclip ID")
 * are left alone.
 */
export const DEFAULT_BRAND_NAME = "Dixie Flatline";
/**
 * `DIXIE_BRAND_NAME` overrides the name. The server's Vitest config sets it to
 * the upstream "Paperclip" so upstream tests that assert copy run unchanged.
 */
export const BRAND_NAME = process.env.DIXIE_BRAND_NAME?.trim() || DEFAULT_BRAND_NAME;

const BRAND_WORD = /(^|[^A-Za-z0-9_$@./\\-])Paperclip(?![A-Za-z0-9_$/\\]| Cloud\b| ID\b)/g;

export function rebrandText(text: string): string {
  if (BRAND_NAME === "Paperclip" || !text.includes("Paperclip")) return text;
  return text.replace(BRAND_WORD, (_match, prefix: string) => `${prefix}${BRAND_NAME}`);
}
