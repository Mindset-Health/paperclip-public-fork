import { describe, expect, it } from "vitest";
import { resolvePrimaryChatAgent } from "../dixie/primary-chat.js";

describe("resolvePrimaryChatAgent", () => {
  it("returns the configured agent reference", () => {
    expect(resolvePrimaryChatAgent({ PAPERCLIP_PRIMARY_CHAT_AGENT: " dixie " })).toBe("dixie");
  });

  it("is null when unset or not a plain agent reference", () => {
    expect(resolvePrimaryChatAgent({})).toBeNull();
    expect(resolvePrimaryChatAgent({ PAPERCLIP_PRIMARY_CHAT_AGENT: "" })).toBeNull();
    expect(resolvePrimaryChatAgent({ PAPERCLIP_PRIMARY_CHAT_AGENT: "../admin" })).toBeNull();
  });
});
