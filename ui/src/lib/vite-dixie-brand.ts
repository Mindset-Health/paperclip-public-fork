/**
 * Build-time product rebrand for the Dixie Flatline fork.
 *
 * Rewrites the user-visible product name "Paperclip" to "Dixie Flatline" in
 * string literals, template text and JSX text of first-party UI modules, and
 * in `index.html`. Code identifiers, import specifiers, object keys, type-only
 * literals and lowercase `paperclip` (API paths, env vars, CLI names, package
 * names) are never touched, and a match must stand alone as a word, so values
 * like `PaperclipCloud` or `/paperclip/` survive.
 *
 * Doing this at build time instead of editing hundreds of upstream source
 * strings keeps the fork's diff small and rebases conflict-free. Vitest does
 * not load this plugin, so upstream test expectations stay valid.
 */
import { parseSync } from "vite";
import type { Plugin } from "vite";

export const DIXIE_BRAND_NAME = "Dixie Flatline";

/** Files whose text is addressed to agents, not people; keep upstream wording. */
const EXCLUDED_MODULE_SUFFIXES = ["/src/lib/agent-onboarding-prompt.ts"];

// "Paperclip Cloud" and "Paperclip ID" name upstream's hosted services, not this product.
const BRAND_WORD = /(^|[^A-Za-z0-9_$@./\\-])Paperclip(?![A-Za-z0-9_$/\\]| Cloud\b| ID\b)/g;

export function rebrandText(text: string, brandName = DIXIE_BRAND_NAME): string {
  return text.replace(BRAND_WORD, (_match, prefix: string) => `${prefix}${brandName}`);
}

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

const SKIPPED_SUBTREES = new Set([
  "ImportDeclaration",
  "ExportAllDeclaration",
  "TSTypeAnnotation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSLiteralType",
  "TSModuleDeclaration",
  "TSImportType",
]);

function isNode(value: unknown): value is AstNode {
  return Boolean(value) && typeof value === "object" && typeof (value as AstNode).type === "string";
}

/** Collects [start, end] spans of user-visible text in a parsed module. */
function collectTextSpans(root: AstNode): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const visit = (node: AstNode, parent: AstNode | null, key: string | null) => {
    if (SKIPPED_SUBTREES.has(node.type)) return;
    if (node.type === "ImportExpression" || (node.type === "ExportNamedDeclaration" && node.source)) {
      // Visit everything except the module specifier.
      for (const [childKey, child] of Object.entries(node)) {
        if (childKey === "source") continue;
        visitChild(child, node, childKey);
      }
      return;
    }
    const isPropertyKey =
      parent !== null &&
      key === "key" &&
      (parent.type === "Property" || parent.type === "PropertyDefinition" || parent.type === "MethodDefinition") &&
      !parent.computed;
    if (node.type === "Literal" && typeof node.value === "string" && !isPropertyKey) {
      spans.push([node.start, node.end]);
    } else if (node.type === "TemplateElement" || node.type === "JSXText") {
      spans.push([node.start, node.end]);
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (childKey === "type" || childKey === "start" || childKey === "end") continue;
      visitChild(child, node, childKey);
    }
  };
  const visitChild = (child: unknown, parent: AstNode, key: string) => {
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) visit(item, parent, key);
    } else if (isNode(child)) {
      visit(child, parent, key);
    }
  };
  visit(root, null, null);
  return spans;
}

export function rebrandModuleSource(code: string, id: string, brandName = DIXIE_BRAND_NAME): string | null {
  if (!code.includes("Paperclip")) return null;
  const lang = id.endsWith(".tsx") ? "tsx" : id.endsWith(".ts") ? "ts" : id.endsWith(".jsx") ? "jsx" : "js";
  const parsed = parseSync(id, code, { lang, sourceType: "module" });
  if (parsed.errors.length > 0) return null;
  const spans = collectTextSpans(parsed.program as unknown as AstNode).sort((a, b) => a[0] - b[0]);
  let output = "";
  let cursor = 0;
  let changed = false;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    const original = code.slice(start, end);
    const replaced = rebrandText(original, brandName);
    if (replaced === original) continue;
    output += code.slice(cursor, start) + replaced;
    cursor = end;
    changed = true;
  }
  if (!changed) return null;
  return output + code.slice(cursor);
}

/** Rewrites string values (never keys) of a JSON module, e.g. the app catalog. */
export function rebrandJsonSource(code: string, brandName = DIXIE_BRAND_NAME): string | null {
  if (!code.includes("Paperclip")) return null;
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch {
    return null;
  }
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return rebrandText(node, brandName);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  const output = JSON.stringify(walk(value));
  return output === JSON.stringify(value) ? null : output;
}

export function dixieBrandPlugin(brandName = DIXIE_BRAND_NAME): Plugin {
  return {
    name: "dixie-brand",
    enforce: "pre",
    transform(code, id) {
      const path = id.split("?")[0] ?? id;
      if (path.includes("/node_modules/")) return null;
      if (EXCLUDED_MODULE_SUFFIXES.some((suffix) => path.endsWith(suffix))) return null;
      if (path.endsWith(".json")) {
        const rebranded = rebrandJsonSource(code, brandName);
        return rebranded === null ? null : { code: rebranded, map: null };
      }
      if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return null;
      const rebranded = rebrandModuleSource(code, path, brandName);
      return rebranded === null ? null : { code: rebranded, map: null };
    },
    transformIndexHtml(html) {
      return rebrandText(html, brandName);
    },
  };
}
