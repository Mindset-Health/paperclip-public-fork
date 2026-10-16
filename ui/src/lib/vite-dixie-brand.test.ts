import { describe, expect, it } from "vitest";
import { rebrandJsonSource, rebrandModuleSource, rebrandText } from "./vite-dixie-brand";

describe("Dixie Flatline build-time rebrand", () => {
  it("rewrites standalone product names only", () => {
    expect(rebrandText("Sign in to Paperclip")).toBe("Sign in to Dixie Flatline");
    expect(rebrandText("Paperclip's agents")).toBe("Dixie Flatline's agents");
    expect(rebrandText("Paperclip-managed")).toBe("Dixie Flatline-managed");
    expect(rebrandText("PaperclipCloud")).toBe("PaperclipCloud");
    expect(rebrandText("X-Paperclip-Run-Id")).toBe("X-Paperclip-Run-Id");
    expect(rebrandText("@paperclipai/ui and /api/paperclip")).toBe("@paperclipai/ui and /api/paperclip");
    expect(rebrandText("ui/Paperclip/x")).toBe("ui/Paperclip/x");
    expect(rebrandText("Connect Paperclip Cloud to Paperclip")).toBe("Connect Paperclip Cloud to Dixie Flatline");
    expect(rebrandText("Sign in with Paperclip ID")).toBe("Sign in with Paperclip ID");
  });

  it("rewrites strings, templates and JSX text but not code", () => {
    const source = [
      'import { PaperclipLockup } from "./Paperclip";',
      'import type { X } from "./types";',
      'type Name = "Paperclip";',
      'const labels = { Paperclip: "Paperclip", "Paperclip": 1 };',
      'const tpl = `Welcome to Paperclip, ${user}`;',
      'export function A() { return <PaperclipLockup title="Paperclip">Hello Paperclip</PaperclipLockup>; }',
      'const lazy = import("./Paperclip");',
    ].join("\n");
    const output = rebrandModuleSource(source, "/repo/ui/src/A.tsx");
    expect(output).toContain('import { PaperclipLockup } from "./Paperclip";');
    expect(output).toContain('type Name = "Paperclip";');
    expect(output).toContain('const labels = { Paperclip: "Dixie Flatline", "Paperclip": 1 };');
    expect(output).toContain("`Welcome to Dixie Flatline, ${user}`");
    expect(output).toContain('<PaperclipLockup title="Dixie Flatline">Hello Dixie Flatline</PaperclipLockup>');
    expect(output).toContain('import("./Paperclip")');
  });

  it("leaves modules without the product name untouched", () => {
    expect(rebrandModuleSource("const a = 1;", "/repo/ui/src/a.ts")).toBeNull();
  });

  it("rewrites JSON string values but not keys", () => {
    expect(rebrandJsonSource('{"Paperclip":"Connect with Paperclip","n":1}')).toBe(
      '{"Paperclip":"Connect with Dixie Flatline","n":1}',
    );
    expect(rebrandJsonSource('{"a":"b"}')).toBeNull();
  });
});
