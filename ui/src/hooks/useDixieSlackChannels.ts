import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

/**
 * Slack channels the Dixie plugin lets agents listen in (Dixie Flatline
 * deployment patch). The plugin route returns `[{ id, name }]`, or
 * `{ enabled: false }` when Slack is not configured. Anything other than a
 * channel array (404 without the plugin, an error, `{ enabled: false }`) means
 * the Slack controls stay hidden and the UI matches upstream.
 */
export type DixieSlackChannel = { id: string; name: string };

export const DIXIE_SLACK_CHANNELS_PATH = "/plugins/mindset-health.dixie/api/slack/allowed-channels";

export function parseDixieSlackChannels(value: unknown): DixieSlackChannel[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !id.trim()) return [];
    return [{ id, name: typeof name === "string" && name.trim() ? name : id }];
  });
}

export function useDixieSlackChannels(companyId: string | null | undefined): DixieSlackChannel[] | null {
  const query = useQuery({
    queryKey: ["dixie-slack", "allowed-channels", companyId ?? null],
    queryFn: async () =>
      parseDixieSlackChannels(
        await api.get<unknown>(`${DIXIE_SLACK_CHANNELS_PATH}?${new URLSearchParams({ companyId: companyId! })}`),
      ),
    enabled: Boolean(companyId),
    retry: false,
    staleTime: 5 * 60_000,
  });
  return query.data ?? null;
}
