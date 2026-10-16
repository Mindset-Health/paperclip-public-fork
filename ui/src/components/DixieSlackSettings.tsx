/**
 * Slack behaviour for an agent (Dixie Flatline deployment patch).
 *
 * Stored on the agent as `metadata.dixieSlack = { mode, channels, keywords }`;
 * the Dixie plugin reconciles its Slack settings from that field. Everything
 * here renders only when the plugin's allowed-channels route returns a channel
 * list, so without the plugin the UI is unchanged from upstream.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { useToastActions } from "@/context/ToastContext";
import { useDixieSlackChannels, type DixieSlackChannel } from "@/hooks/useDixieSlackChannels";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export const DIXIE_SLACK_METADATA_KEY = "dixieSlack";
export const DIXIE_SLACK_MAX_KEYWORDS = 10;
export const DIXIE_SLACK_MIN_KEYWORD_LENGTH = 4;

export type DixieSlackMode = "off" | "mention" | "keywords" | "invite";
export type DixieSlackSettings = { mode: DixieSlackMode; channels: string[]; keywords: string[] };

export const DEFAULT_DIXIE_SLACK: DixieSlackSettings = { mode: "mention", channels: [], keywords: [] };

const MODES: Array<{ value: DixieSlackMode; label: string; description: string }> = [
  { value: "off", label: "Off", description: "The agent never responds in Slack." },
  {
    value: "mention",
    label: "When @-mentioned",
    description: "Wakes on @Dixie <handle> in a chosen channel, or a DM to Dixie naming the agent.",
  },
  {
    value: "keywords",
    label: "Listen for keywords",
    description: "Also wakes on a new message in a chosen channel that contains one of your keywords.",
  },
  {
    value: "invite",
    label: "Only when invited",
    description: "Joins a thread only after @Dixie invite <handle> in that thread.",
  },
];

function isMode(value: unknown): value is DixieSlackMode {
  return value === "off" || value === "mention" || value === "keywords" || value === "invite";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Reads the stored setting, dropping channels that are no longer allowed. */
export function readDixieSlack(
  metadata: Record<string, unknown> | null | undefined,
  channels?: DixieSlackChannel[] | null,
): DixieSlackSettings {
  const raw = metadata?.[DIXIE_SLACK_METADATA_KEY];
  if (typeof raw !== "object" || raw === null) return DEFAULT_DIXIE_SLACK;
  const record = raw as Record<string, unknown>;
  const allowed = channels ? new Set(channels.map((channel) => channel.id)) : null;
  return {
    mode: isMode(record.mode) ? record.mode : DEFAULT_DIXIE_SLACK.mode,
    channels: strings(record.channels).filter((id) => !allowed || allowed.has(id)),
    keywords: strings(record.keywords),
  };
}

/** Why a keyword cannot be added, or null when it can. */
export function dixieSlackKeywordError(keyword: string, existing: string[]): string | null {
  const trimmed = keyword.trim();
  if (trimmed.length < DIXIE_SLACK_MIN_KEYWORD_LENGTH) {
    return `Keywords need at least ${DIXIE_SLACK_MIN_KEYWORD_LENGTH} characters.`;
  }
  if (existing.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) return "That keyword is already listed.";
  if (existing.length >= DIXIE_SLACK_MAX_KEYWORDS) return `Use at most ${DIXIE_SLACK_MAX_KEYWORDS} keywords.`;
  return null;
}

/** Why the setting cannot be saved, or null when it is valid. */
export function dixieSlackError(value: DixieSlackSettings): string | null {
  if (value.mode === "off") return null;
  if ((value.mode === "mention" || value.mode === "keywords") && value.channels.length === 0) {
    return "Choose at least one channel.";
  }
  if (value.mode === "keywords") {
    if (value.keywords.length === 0) return "Add at least one keyword.";
    if (value.keywords.length > DIXIE_SLACK_MAX_KEYWORDS) return `Use at most ${DIXIE_SLACK_MAX_KEYWORDS} keywords.`;
    if (value.keywords.some((keyword) => keyword.trim().length < DIXIE_SLACK_MIN_KEYWORD_LENGTH)) {
      return `Keywords need at least ${DIXIE_SLACK_MIN_KEYWORD_LENGTH} characters.`;
    }
  }
  return null;
}

/** The value persisted as `metadata.dixieSlack`: fields that don't apply to the mode are cleared. */
export function dixieSlackPayload(value: DixieSlackSettings): DixieSlackSettings {
  return {
    mode: value.mode,
    channels: value.mode === "off" ? [] : [...new Set(value.channels)],
    keywords: value.mode === "keywords" ? value.keywords.map((keyword) => keyword.trim()) : [],
  };
}

export function DixieSlackFields({
  value,
  onChange,
  channels,
  handle,
  disabled,
}: {
  value: DixieSlackSettings;
  onChange: (value: DixieSlackSettings) => void;
  channels: DixieSlackChannel[];
  handle: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const shown = handle || "<handle>";
  const channelsRequired = value.mode === "mention" || value.mode === "keywords";

  function addKeyword() {
    const problem = dixieSlackKeywordError(draft, value.keywords);
    setKeywordError(problem);
    if (problem) return;
    onChange({ ...value, keywords: [...value.keywords, draft.trim()] });
    setDraft("");
  }

  function onKeywordKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addKeyword();
    }
  }

  return (
    <div className="space-y-5">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-2 text-xs text-muted-foreground">Slack mode</legend>
        {MODES.map((mode) => (
          <label
            key={mode.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm",
              value.mode === mode.value ? "border-foreground" : "border-border",
            )}
          >
            <input
              type="radio"
              name={`${id}-mode`}
              value={mode.value}
              checked={value.mode === mode.value}
              onChange={() => onChange({ ...value, mode: mode.value })}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{mode.label}</span>
              <span className="block text-xs text-muted-foreground">
                {mode.description.replace("<handle>", shown)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {value.mode !== "off" && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="mb-2 text-xs text-muted-foreground">
            Channels{channelsRequired ? "" : " (optional)"}
          </legend>
          {channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channels are available yet. Ask an administrator.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {channels.map((channel) => {
                const checked = value.channels.includes(channel.id);
                return (
                  <label
                    key={channel.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                      checked ? "border-foreground" : "border-border",
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label={`#${channel.name}`}
                      checked={checked}
                      onChange={() =>
                        onChange({
                          ...value,
                          channels: checked
                            ? value.channels.filter((entry) => entry !== channel.id)
                            : [...value.channels, channel.id],
                        })
                      }
                    />
                    #{channel.name}
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
      )}

      {value.mode === "keywords" && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="mb-2 text-xs text-muted-foreground">
            Keywords (up to {DIXIE_SLACK_MAX_KEYWORDS}, at least {DIXIE_SLACK_MIN_KEYWORD_LENGTH} characters each)
          </legend>
          {value.keywords.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Keywords">
              {value.keywords.map((keyword) => (
                <li
                  key={keyword}
                  className="flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-sm"
                >
                  {keyword}
                  <button
                    type="button"
                    aria-label={`Remove ${keyword}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => onChange({ ...value, keywords: value.keywords.filter((entry) => entry !== keyword) })}
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Input
              aria-label="Keyword"
              value={draft}
              placeholder="deploy"
              onChange={(event) => {
                setDraft(event.target.value);
                setKeywordError(null);
              }}
              onKeyDown={onKeywordKey}
            />
            <Button type="button" variant="outline" onClick={addKeyword}>
              Add keyword
            </Button>
          </div>
          {keywordError && (
            <p role="alert" className="text-xs text-destructive">
              {keywordError}
            </p>
          )}
        </fieldset>
      )}

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Write <code>@Dixie {shown}</code> in an allowed channel to start a task. Each Slack thread is one task.
        </p>
        <p>Once the agent is in a thread it keeps replying there, until 24 h pass with no new message.</p>
        <p>
          Add it to any thread with <code>@Dixie invite {shown}</code>, and remove it with{" "}
          <code>@Dixie dismiss {shown}</code>.
        </p>
      </div>
    </div>
  );
}

/** Slack card on an agent's configuration page, saved on its own. */
export function AgentDixieSlackSection({
  agent,
  companyId,
}: {
  agent: Pick<Agent, "id" | "urlKey" | "metadata" | "companyId">;
  companyId?: string;
}) {
  const channels = useDixieSlackChannels(companyId ?? agent.companyId);
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const stored = useMemo(() => readDixieSlack(agent.metadata, channels), [agent.metadata, channels]);
  const storedKey = JSON.stringify(stored);
  const [value, setValue] = useState(stored);
  // Re-sync only when the saved value itself changes, not on every refetch.
  useEffect(() => setValue(stored), [storedKey]);
  const save = useMutation({
    mutationFn: (next: DixieSlackSettings) =>
      agentsApi.update(
        agent.id,
        { metadata: { ...(agent.metadata ?? {}), [DIXIE_SLACK_METADATA_KEY]: dixieSlackPayload(next) } },
        companyId,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      pushToast({ title: "Slack settings saved", tone: "success" });
    },
    onError: (error) =>
      pushToast({
        title: "Save failed",
        body: error instanceof Error ? error.message : "Could not save Slack settings",
        tone: "error",
      }),
  });
  if (!channels) return null;
  const problem = dixieSlackError(value);
  const dirty = JSON.stringify(dixieSlackPayload(value)) !== JSON.stringify(dixieSlackPayload(stored));
  return (
    <section className="mt-6 rounded-lg border border-border p-4" aria-labelledby="agent-slack-heading">
      <h3 id="agent-slack-heading" className="mb-4 text-sm font-medium">
        Slack
      </h3>
      <DixieSlackFields
        value={value}
        onChange={setValue}
        channels={channels}
        handle={agent.urlKey}
        disabled={save.isPending}
      />
      {dirty && problem && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {problem}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {dirty && (
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setValue(stored)}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          disabled={!dirty || Boolean(problem) || save.isPending}
          onClick={() => save.mutate(value)}
        >
          {save.isPending ? "Saving…" : "Save Slack settings"}
        </Button>
      </div>
    </section>
  );
}
