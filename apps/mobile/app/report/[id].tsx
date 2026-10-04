import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { Image, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Report, Run } from "@fabric/contracts";

import { Card, EmptyState, ErrorState, Pill, Row, Screen } from "@/components/ui";
import { httpApi } from "@/lib/api";
import { avatar } from "@/lib/avatar";
import { theme } from "@/lib/theme";
import { ResultTable } from "@/components/work/result-table";

/**
 * Read-only report (MOBILE-PLAN §2): the numbers and caveats, provenance, who made it, artifact
 * names, and the email note — the same content as the web's ReportView, minus the links that only
 * make sense at a desk. A recorded source is badged (DEMO-SCRIPT §4: replay is always badged);
 * reports are immutable, so this fetches once instead of polling.
 */
interface Loaded {
  report: Report;
  run: Run | undefined;
}

export default function ReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const reportId = id ?? "";
  const [data, setData] = useState<Loaded | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const report = await httpApi.getReport(reportId);
      if (!report) {
        setMissing(true);
        setData(undefined);
      } else {
        setMissing(false);
        setData({ report, run: await httpApi.getRun(report.runId) });
        setError(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = data?.report;
  const recorded = data?.run?.recorded === true || report?.kind === "real";

  return (
    <Screen>
      <Stack.Screen options={{ title: report?.title ?? "Report" }} />
      {loading && !report && !error && (
        <EmptyState title="Loading…" />
      )}
      {missing && (
        <EmptyState title="Report not found" hint="It may not be finalized yet — check on desktop." />
      )}
      {error && !report && <ErrorState message={error.message} onRetry={load} />}
      {report && (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.colors.run} />}>
          <View style={styles.head}>
            <Text style={styles.title}>{report.title}</Text>
            {report.kind === "illustrative" ? (
              <Pill variant="replay">Illustrative</Pill>
            ) : (
              recorded && <Pill variant="replay">Replay of a recorded run</Pill>
            )}
            <Text style={styles.intro}>{report.intro}</Text>
          </View>

          {report.setup && report.setup.length > 0 && (
            <Section label="Setup">
              <Card>
                {report.setup.map((row) => (
                  <Row key={row.label} label={row.label}>
                    <Text style={styles.value}>{row.value}</Text>
                  </Row>
                ))}
              </Card>
            </Section>
          )}

          <Section label="Summary">
            <Text style={styles.paragraph}>{report.summary}</Text>
          </Section>

          {report.results.length > 0 && (
            <Section label="Held-out perplexity">
              <ResultTable results={report.results} />
            </Section>
          )}

          {report.caveats.length > 0 && (
            <Section label="Caveats">
              {report.caveats.map((caveat) => (
                <Text key={caveat} style={styles.caveat}>
                  •  {caveat}
                </Text>
              ))}
            </Section>
          )}

          <Section label="Provenance">
            <Card>
              {report.provenance.map((entry) => (
                <Row key={entry.label} label={entry.label}>
                  <Text style={styles.value}>{entry.value}</Text>
                </Row>
              ))}
            </Card>
          </Section>

          {report.madeBy.length > 0 && (
            <Section label="Made by">
              <View style={styles.faces}>
                {report.madeBy.map((agentId) => {
                  const portrait = avatar(agentId);
                  return portrait ? (
                    <Image key={agentId} source={portrait} style={styles.face} accessibilityLabel={agentId} />
                  ) : (
                    <Text key={agentId} style={styles.faceName}>
                      {agentId}
                    </Text>
                  );
                })}
              </View>
            </Section>
          )}

          {report.artifacts.length > 0 && (
            <Section label="Artifacts">
              <Card>
                {report.artifacts.map((artifact) => (
                  <Text key={artifact.name} style={styles.artifact} numberOfLines={1}>
                    {artifact.name}
                  </Text>
                ))}
              </Card>
            </Section>
          )}

          {report.emailed && <Text style={styles.emailed}>Also emailed to you via AgentMail</Text>}
          {error && <ErrorState message={error.message} onRetry={load} />}
        </ScrollView>
      )}
    </Screen>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingVertical: 16, rowGap: 20 },
  head: { rowGap: 8 },
  title: { color: theme.colors.foreground, fontSize: 20, fontWeight: "600", lineHeight: 26 },
  intro: { color: theme.colors.mutedForeground, fontSize: 13, lineHeight: 19 },
  section: { rowGap: 8 },
  sectionLabel: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
  paragraph: { color: theme.colors.foreground, fontSize: 13.5, lineHeight: 20 },
  caveat: { color: theme.colors.foreground, fontSize: 13, lineHeight: 19 },
  value: { color: theme.colors.foreground, fontSize: 13, textAlign: "right" },
  faces: { flexDirection: "row", columnGap: 6, rowGap: 4, flexWrap: "wrap", alignItems: "center" },
  face: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.secondary },
  faceName: { color: theme.colors.mutedForeground, fontSize: 12 },
  artifact: { color: theme.colors.foreground, fontSize: 12.5, fontFamily: "monospace" },
  emailed: { color: theme.colors.mutedForeground, fontSize: 12 },
});
