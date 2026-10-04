import { useCallback, useEffect, useState } from "react";
import { Image, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { RunSchema } from "@fabric/contracts";
import { z } from "zod";

import { Card, Row, Screen } from "@/components/ui";
import { apiBase, httpApi } from "@/lib/api";
import { avatar } from "@/lib/avatar";
import { theme } from "@/lib/theme";
import { useStreamStatus } from "@/lib/app-stream";
import { usePoll } from "@/lib/use-poll";

/**
 * Hidden network + contracts check (MOBILE-PLAN §6 step 3). Reached from the ⌘ button in either
 * tab header. Shows the API base, the GET /api/runs count through the validated client, a raw
 * RunSchema.parse of the same response — proof that @fabric/contracts executes in RN — and the
 * M1 /api/stream connection state (live / reconnecting, with the last AppEvent).
 */

type SchemaCheck = { status: "ok" | "mismatch" | "error"; detail: string };

export default function DebugScreen() {
  const stream = useStreamStatus();
  const { data, error, loading, refresh } = usePoll(() => httpApi.listRuns(), 3000);
  const [check, setCheck] = useState<SchemaCheck | undefined>(undefined);

  const runSchemaCheck = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/runs`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const value: unknown = await response.json();
      const parsed = z.array(RunSchema).safeParse(value);
      setCheck(
        parsed.success
          ? { status: "ok", detail: `${parsed.data.length} runs parse clean` }
          : {
              status: "mismatch",
              detail: parsed.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join(" · "),
            },
      );
    } catch (err) {
      setCheck({ status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void runSchemaCheck();
  }, [runSchemaCheck]);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={theme.colors.run} />
        }>
        <Card>
          <Row label="API base">
            <Text style={styles.mono}>{apiBase}</Text>
          </Row>
          <Row label="GET /api/runs">
            <Text style={styles.value}>
              {error ? "unreachable" : data ? `${data.length} runs` : loading ? "…" : "—"}
            </Text>
          </Row>
          <Row label="RunSchema.parse">
            <Text style={[styles.value, check?.status === "ok" && styles.ok, check && check.status !== "ok" && styles.bad]}>
              {check ? `${check.status} — ${check.detail}` : "…"}
            </Text>
          </Row>
        </Card>
        <Card>
          <Row label="App stream">
            <Text style={[styles.value, stream.state === "live" && styles.ok, stream.state !== "live" && styles.bad]}>
              {stream.state}
              {stream.state !== "live" && stream.attempts > 0 ? ` · retry ${stream.attempts}` : ""}
            </Text>
          </Row>
          <Row label="Last event">
            <Text style={styles.value}>
              {stream.lastEvent
                ? `${stream.lastEvent.type} · ${new Date(stream.lastEventAt ?? 0).toLocaleTimeString()}`
                : "—"}
            </Text>
          </Row>
        </Card>
        {error && (
          <Card>
            <Text style={styles.bad}>{error.message}</Text>
          </Card>
        )}
        <Text style={styles.hint}>
          EXPO_PUBLIC_API_URL is read from apps/mobile/.env (copy .env.example). Metro inlines it when the
          dev server starts — restart `npm start` after changing it. Prefer the laptop hotspot or the
          tailnet IP (MOBILE-PLAN §4); `expo start --tunnel` tunnels Metro only, never the API.
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingVertical: 16, rowGap: 12 },
  mono: { color: theme.colors.foreground, fontSize: 13, fontFamily: "monospace" },
  value: { color: theme.colors.foreground, fontSize: 13, textAlign: "right", flex: 1 },
  ok: { color: theme.colors.ok },
  bad: { color: theme.colors.destructive },
  hint: { color: theme.colors.mutedForeground, fontSize: 12, lineHeight: 17 },
  portrait: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.secondary },
});
