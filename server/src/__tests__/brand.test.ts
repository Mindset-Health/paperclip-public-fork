import { afterEach, describe, expect, it, vi } from "vitest";

async function loadBrand(name: string | undefined) {
  vi.resetModules();
  vi.stubEnv("DIXIE_BRAND_NAME", name ?? "");
  return import("../brand.js");
}

describe("Dixie Flatline server branding", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to Dixie Flatline and rewrites standalone product names only", async () => {
    const { BRAND_NAME, rebrandText } = await loadBrand(undefined);
    expect(BRAND_NAME).toBe("Dixie Flatline");
    expect(rebrandText("Open the task in Paperclip for details.")).toBe("Open the task in Dixie Flatline for details.");
    expect(rebrandText("This Paperclip needs HTTPS")).toBe("This Dixie Flatline needs HTTPS");
    expect(rebrandText("Connect Paperclip Cloud")).toBe("Connect Paperclip Cloud");
    expect(rebrandText("Use Paperclip ID")).toBe("Use Paperclip ID");
    expect(rebrandText("X-Paperclip-Run-Id and PaperclipCloud and /paperclip")).toBe(
      "X-Paperclip-Run-Id and PaperclipCloud and /paperclip",
    );
  });

  it("can run with the upstream name (used by the upstream test suites)", async () => {
    const { BRAND_NAME, rebrandText } = await loadBrand("Paperclip");
    expect(BRAND_NAME).toBe("Paperclip");
    expect(rebrandText("Open the task in Paperclip")).toBe("Open the task in Paperclip");
  });
});
