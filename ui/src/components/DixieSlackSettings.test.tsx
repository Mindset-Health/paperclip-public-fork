// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentDixieSlackSection,
  DEFAULT_DIXIE_SLACK,
  DixieSlackFields,
  dixieSlackError,
  dixieSlackKeywordError,
  dixieSlackPayload,
  readDixieSlack,
  type DixieSlackSettings,
} from "./DixieSlackSettings";
import { parseDixieSlackChannels } from "@/hooks/useDixieSlackChannels";

const state = vi.hoisted(() => ({
  channels: null as Array<{ id: string; name: string }> | null,
  update: vi.fn(),
  pushToast: vi.fn(),
}));
vi.mock("@/hooks/useDixieSlackChannels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDixieSlackChannels")>()),
  useDixieSlackChannels: () => state.channels,
}));
vi.mock("@/api/agents", () => ({ agentsApi: { update: state.update } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: state.pushToast }) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const CHANNELS = [
  { id: "C1", name: "eng" },
  { id: "C2", name: "ops" },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  state.channels = null;
  state.update.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
}
function button(text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
}
async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}
async function type(label: string, value: string) {
  const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function radio(mode: string) {
  return container.querySelector(`input[type="radio"][value="${mode}"]`);
}

describe("Dixie Slack settings rules", () => {
  it("only treats a channel array as available", () => {
    expect(parseDixieSlackChannels({ enabled: false })).toBeNull();
    expect(parseDixieSlackChannels(null)).toBeNull();
    expect(parseDixieSlackChannels([{ id: "C1", name: "eng" }, { id: "" }, "x", { id: "C2" }])).toEqual([
      { id: "C1", name: "eng" },
      { id: "C2", name: "C2" },
    ]);
  });

  it("requires channels for mention and keywords, and keywords for keywords mode", () => {
    expect(dixieSlackError(DEFAULT_DIXIE_SLACK)).toMatch(/channel/);
    expect(dixieSlackError({ mode: "off", channels: [], keywords: [] })).toBeNull();
    expect(dixieSlackError({ mode: "invite", channels: [], keywords: [] })).toBeNull();
    expect(dixieSlackError({ mode: "mention", channels: ["C1"], keywords: [] })).toBeNull();
    expect(dixieSlackError({ mode: "keywords", channels: ["C1"], keywords: [] })).toMatch(/keyword/);
    expect(dixieSlackError({ mode: "keywords", channels: ["C1"], keywords: ["ops"] })).toMatch(/4 characters/);
    expect(dixieSlackError({ mode: "keywords", channels: ["C1"], keywords: ["deploy"] })).toBeNull();
  });

  it("limits keywords to 10 unique entries of at least 4 characters", () => {
    expect(dixieSlackKeywordError("ops", [])).toMatch(/4 characters/);
    expect(dixieSlackKeywordError(" Deploy ", ["deploy"])).toMatch(/already/);
    const ten = Array.from({ length: 10 }, (_, i) => `word${i}`);
    expect(dixieSlackKeywordError("another", ten)).toMatch(/at most 10/);
    expect(dixieSlackKeywordError("deploy", ten.slice(1))).toBeNull();
  });

  it("clears fields that don't apply to the mode", () => {
    const value: DixieSlackSettings = { mode: "mention", channels: ["C1", "C1"], keywords: ["deploy"] };
    expect(dixieSlackPayload(value)).toEqual({ mode: "mention", channels: ["C1"], keywords: [] });
    expect(dixieSlackPayload({ ...value, mode: "off" })).toEqual({ mode: "off", channels: [], keywords: [] });
    expect(dixieSlackPayload({ ...value, mode: "keywords", keywords: [" deploy "] })).toEqual({
      mode: "keywords",
      channels: ["C1"],
      keywords: ["deploy"],
    });
  });

  it("reads stored settings and drops channels that are no longer allowed", () => {
    expect(readDixieSlack(null)).toEqual(DEFAULT_DIXIE_SLACK);
    expect(
      readDixieSlack({ dixieSlack: { mode: "keywords", channels: ["C1", "C9"], keywords: ["deploy"] } }, CHANNELS),
    ).toEqual({ mode: "keywords", channels: ["C1"], keywords: ["deploy"] });
    expect(readDixieSlack({ dixieSlack: { mode: "bogus" } })).toEqual(DEFAULT_DIXIE_SLACK);
  });
});

describe("DixieSlackFields", () => {
  function Harness({ onValue }: { onValue: (value: DixieSlackSettings) => void }) {
    const [value, setValue] = useState(DEFAULT_DIXIE_SLACK);
    return (
      <DixieSlackFields
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue(next);
        }}
        channels={CHANNELS}
        handle="atlas"
      />
    );
  }

  it("explains the handle commands and builds the chosen setting", async () => {
    const onValue = vi.fn();
    await render(<Harness onValue={onValue} />);
    expect(container.textContent).toContain("@Dixie atlas");
    expect(container.textContent).toContain("@Dixie invite atlas");
    expect(container.textContent).toContain("@Dixie dismiss atlas");
    expect(container.textContent).toContain("24 h");
    expect((radio("mention") as HTMLInputElement).checked).toBe(true);

    await click(radio("keywords"));
    await click(container.querySelector('[aria-label="#ops"]'));
    await type("Keyword", "ops");
    await click(button("Add keyword"));
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/4 characters/);
    await type("Keyword", "incident");
    await click(button("Add keyword"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onValue).toHaveBeenLastCalledWith({ mode: "keywords", channels: ["C2"], keywords: ["incident"] });

    await click(container.querySelector('[aria-label="Remove incident"]'));
    expect(onValue).toHaveBeenLastCalledWith({ mode: "keywords", channels: ["C2"], keywords: [] });

    await click(radio("off"));
    expect(container.querySelector('[aria-label="#ops"]')).toBeNull();
    expect(container.querySelector('[aria-label="Keyword"]')).toBeNull();
  });
});

describe("AgentDixieSlackSection", () => {
  const agent = {
    id: "agent-1",
    urlKey: "atlas",
    companyId: "company-1",
    metadata: { createdByUserId: "member-1", dixieSlack: { mode: "mention", channels: ["C1"], keywords: [] } },
  };

  it("renders nothing without the plugin's channel list", async () => {
    await render(<AgentDixieSlackSection agent={agent} companyId="company-1" />);
    expect(container.innerHTML).toBe("");
  });

  it("saves the setting merged into the agent's existing metadata", async () => {
    state.channels = CHANNELS;
    await render(<AgentDixieSlackSection agent={agent} companyId="company-1" />);
    expect(container.textContent).toContain("@Dixie atlas");
    expect(button("Save Slack settings")?.disabled).toBe(true);

    await click(container.querySelector('[aria-label="#eng"]'));
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/channel/);
    expect(button("Save Slack settings")?.disabled).toBe(true);

    await click(radio("invite"));
    expect(button("Save Slack settings")?.disabled).toBe(false);
    await click(button("Save Slack settings"));
    expect(state.update).toHaveBeenCalledWith(
      "agent-1",
      {
        metadata: {
          createdByUserId: "member-1",
          dixieSlack: { mode: "invite", channels: [], keywords: [] },
        },
      },
      "company-1",
    );
  });
});
