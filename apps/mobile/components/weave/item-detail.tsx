import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import type { ApprovalItem, EscalationItem, FindingItem, InboxItem, ItemAction, ProposalItem, QuestionItem } from "@fabric/contracts";

import { Card, Pill, Row } from "@/components/ui";
import { theme } from "@/lib/theme";
import { ago, fmtTime, waited } from "./format";
import { hrefTarget, KIND_META } from "./group";
import { personLabel, personName, usePeople, type PersonMap } from "./people";
import { Face } from "./face";
import { resolve, useWeaveLocal, type Resolution } from "./store";

/**
 * The open item (web counterpart: components/weave/item-detail.tsx), M0 scope: why, the
 * kind-specific body (approval preview/gated, escalation budget/history, question/context,
 * proposal, finding), then the actions. Actions resolve locally (no server decision endpoint
 * yet); a report href opens the native Report screen, any other href stays on the desktop.
 */

export function ItemDetail({ item }: { item: InboxItem }) {
  const local = useWeaveLocal();
  const people = usePeople();
  const resolution = local.resolved[item.id];
  return (
    <View style={styles.root}>
      <Header item={item} people={people} />
      {item.blocking && !resolution && (
        <View style={styles.blockingBox}>
          <Text style={styles.blockingText}>
            Blocks {item.blocking.step}. {personName(item.blocking.agentId, people)} has been waiting{" "}
            {waited(item.blocking.since)}.
          </Text>
        </View>
      )}
      <Body item={item} people={people} />
      <Text style={styles.why}>
        <Text style={styles.whyLead}>Why you&apos;re seeing this. </Text>
        {item.why}
      </Text>
      <View style={styles.divider} />
      {resolution ? <ResolvedBanner resolution={resolution} /> : <Actions item={item} />}
    </View>
  );
}

function Header({ item, people }: { item: InboxItem; people: PersonMap }) {
  const meta = KIND_META[item.kind];
  return (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Face agentId={item.agentId} size={44} />
        <View style={styles.headerMain}>
          <Text numberOfLines={1} style={styles.agent}>
            {personLabel(item.agentId, people)}
          </Text>
          <Text style={styles.when}>
            {fmtTime(item.at)} · {ago(item.at)}
          </Text>
        </View>
        <Pill variant={meta.variant}>{meta.label}</Pill>
      </View>
      <View style={styles.chips}>
        <View style={styles.chip}>
          <Text numberOfLines={1} style={styles.chipText}>
            {item.project}
          </Text>
        </View>
        {item.run && (
          <View style={styles.chip}>
            <Text numberOfLines={1} style={styles.chipText}>
              {item.run.label}
            </Text>
          </View>
        )}
      </View>
      <Text style={styles.title}>{item.title}</Text>
    </View>
  );
}

function Body({ item, people }: { item: InboxItem; people: PersonMap }) {
  switch (item.kind) {
    case "approval":
      return <ApprovalBody item={item} />;
    case "question":
      return <QuestionBody item={item} />;
    case "escalation":
      return <EscalationBody item={item} people={people} />;
    case "proposal":
      return <ProposalBody item={item} people={people} />;
    case "finding":
      return <FindingBody item={item} />;
    case "result":
      return null; // The result opens its report — that screen is the payload (MOB-C).
  }
}

function ApprovalBody({ item }: { item: ApprovalItem }) {
  return (
    <>
      <Card>
        <View style={styles.toolLine}>
          <Text style={styles.mono}>{item.tool}</Text>
          <PolicyPill policy={item.policy} />
        </View>
        <Text style={styles.policyNote}>{item.policyNote}</Text>
        {item.preview.map((entry) => (
          <Row key={entry.label} label={entry.label}>
            <Text style={styles.valueText}>{entry.value}</Text>
          </Row>
        ))}
        {item.excerpt && <Text style={styles.excerpt}>{item.excerpt}</Text>}
      </Card>
      {item.gated && (
        <View style={styles.gatedBox}>
          <Text style={styles.gatedText}>{item.gated}</Text>
        </View>
      )}
    </>
  );
}

function QuestionBody({ item }: { item: QuestionItem }) {
  return (
    <>
      <Text style={styles.lede}>{item.question}</Text>
      {item.context.map((line) => (
        <Text key={line} style={styles.contextLine}>
          •  {line}
        </Text>
      ))}
    </>
  );
}

function EscalationBody({ item, people }: { item: EscalationItem; people: PersonMap }) {
  return (
    <>
      <Text style={styles.lede}>{item.body}</Text>
      <View style={styles.budgetLine}>
        <Text style={styles.muted}>Rework budget</Text>
        <View style={styles.segments}>
          {Array.from({ length: item.budget.total }, (_, i) => (
            <View
              key={i}
              style={[styles.segment, { backgroundColor: i < item.budget.used ? theme.colors.warn : theme.colors.secondary }]}
            />
          ))}
        </View>
        <Text style={[styles.budgetCount, { color: theme.colors.warn }]}>
          {item.budget.used} / {item.budget.total} spent
        </Text>
      </View>
      <Card>
        {item.history.map((entry, index) => (
          <View key={`${entry.at}-${index}`} style={styles.historyLine}>
            <Face agentId={entry.agentId} size={20} />
            <Text style={styles.historyText}>
              <Text style={styles.historyName}>{personName(entry.agentId, people)} </Text>
              <Text style={styles.muted}>{entry.text}</Text>
            </Text>
            <Text style={styles.historyAt}>{fmtTime(entry.at)}</Text>
          </View>
        ))}
      </Card>
    </>
  );
}

function ProposalBody({ item, people }: { item: ProposalItem; people: PersonMap }) {
  const lead = item.roster.find((member) => member.status === "lead");
  return (
    <>
      <Text style={styles.lede}>{item.purpose}</Text>
      <View style={styles.roster}>
        {item.roster.map((member) => (
          <View key={member.agentId} style={styles.rosterChip}>
            <Face agentId={member.agentId} size={24} />
            <Text style={styles.rosterName}>{personName(member.agentId, people)}</Text>
            <Text style={[styles.rosterStatus, { color: member.status === "lead" ? theme.colors.warn : theme.colors.mutedForeground }]}>
              {member.status}
            </Text>
          </View>
        ))}
      </View>
      <Card>
        <Row label={`Goes to ${lead ? personName(lead.agentId, people) : "the team"}`}>
          <Text style={styles.valueText}>{item.crosses}</Text>
        </Row>
        <Row label="Stays with me">
          <Text style={styles.valueText}>{item.stays}</Text>
        </Row>
      </Card>
    </>
  );
}

function FindingBody({ item }: { item: FindingItem }) {
  return (
    <>
      <Card>
        <Text style={styles.sourceTitle}>{item.source.title}</Text>
        <Text style={styles.sourceMeta}>
          {item.source.venue} · <Text style={styles.mono}>{item.source.url}</Text>
        </Text>
      </Card>
      <Text style={styles.lede}>{item.relevance}</Text>
      {item.challenges && (
        <View style={styles.challengeBox}>
          <Text style={styles.challengeText}>
            Challenges {item.challenges.owner}: <Text style={styles.challengeQuote}>“{item.challenges.text}”</Text>
          </Text>
        </View>
      )}
    </>
  );
}

function PolicyPill({ policy }: { policy: string }) {
  if (policy === "blocked") {
    return (
      <Text style={[styles.policyPill, { color: theme.colors.destructive, backgroundColor: theme.colors.secondary }]}>
        {policy}
      </Text>
    );
  }
  return <Pill variant={policy === "allowed" ? "ok" : "warn"}>{policy}</Pill>;
}

function ResolvedBanner({ resolution }: { resolution: Resolution }) {
  return (
    <View style={styles.resolvedBox}>
      <Text style={styles.resolvedOutcome}>✓ {resolution.outcome}</Text>
      <Text style={styles.resolvedAt}>{fmtTime(resolution.at)}</Text>
    </View>
  );
}

function Actions({ item }: { item: InboxItem }) {
  const router = useRouter();
  const options = item.actions.filter((action) => action.detail);
  const buttons = item.actions.filter((action) => !action.detail);
  const desktopNote = buttons.some((action) => action.href !== undefined && hrefTarget(action.href).type === "desktop");

  const press = (action: ItemAction) => {
    if (action.href) {
      const target = hrefTarget(action.href);
      if (target.type === "report") router.push(`/report/${target.reportId}`);
      return;
    }
    resolve(item.id, action);
  };

  return (
    <View style={styles.actions}>
      {options.map((action) => (
        <Pressable
          key={action.id}
          style={({ pressed }) => [styles.option, action.variant === "primary" && styles.optionPrimary, pressed && styles.pressed]}
          onPress={() => press(action)}
          accessibilityRole="button"
          accessibilityLabel={action.label}>
          <Text style={styles.optionLabel}>{action.label}</Text>
          {action.detail && <Text style={styles.optionDetail}>{action.detail}</Text>}
        </Pressable>
      ))}
      <View style={styles.buttonRow}>
        {buttons.map((action) => {
          const disabled = action.href !== undefined && hrefTarget(action.href).type === "desktop";
          return (
            <Pressable
              key={action.id}
              disabled={disabled}
              style={({ pressed }) => [
                styles.button,
                action.variant === "primary" && styles.buttonPrimary,
                action.variant === "ghost" && styles.buttonGhost,
                disabled && styles.buttonDisabled,
                pressed && !disabled && styles.pressed,
              ]}
              onPress={() => press(action)}
              accessibilityRole="button"
              accessibilityLabel={action.label}>
              <Text
                style={[
                  styles.buttonLabel,
                  action.variant === "primary" && styles.buttonLabelPrimary,
                  action.variant === "ghost" && styles.buttonLabelGhost,
                  disabled && styles.buttonLabelDisabled,
                ]}>
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {desktopNote && <Text style={styles.desktopNote}>Open on desktop — this link isn&apos;t part of the mobile app yet.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { rowGap: 14, paddingVertical: 16 },
  header: { rowGap: 10 },
  headerTop: { flexDirection: "row", alignItems: "center", columnGap: 12 },
  headerMain: { flex: 1, rowGap: 2 },
  agent: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" },
  when: { color: theme.colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  chips: { flexDirection: "row", flexWrap: "wrap", columnGap: 6, rowGap: 6 },
  chip: {
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: "100%",
  },
  chipText: { color: theme.colors.mutedForeground, fontSize: 11 },
  title: { color: theme.colors.foreground, fontSize: 19, fontWeight: "600", lineHeight: 25 },
  blockingBox: {
    backgroundColor: theme.colors.warnSoft,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  blockingText: { color: theme.colors.warn, fontSize: 12, lineHeight: 17 },
  why: { color: theme.colors.mutedForeground, fontSize: 12, lineHeight: 17 },
  whyLead: { fontWeight: "600", color: theme.colors.foreground },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border },
  lede: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
  muted: { color: theme.colors.mutedForeground },
  mono: { fontFamily: "monospace", fontSize: 11 },
  contextLine: { color: theme.colors.mutedForeground, fontSize: 12, lineHeight: 18, marginLeft: 8 },
  toolLine: { flexDirection: "row", alignItems: "center", columnGap: 8 },
  policyNote: { color: theme.colors.mutedForeground, fontSize: 11 },
  policyPill: {
    fontSize: 12,
    borderRadius: theme.radius.full,
    paddingVertical: 2,
    paddingHorizontal: 8,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  valueText: { color: theme.colors.foreground, fontSize: 13, textAlign: "right", flexShrink: 1 },
  excerpt: {
    color: theme.colors.mutedForeground,
    fontSize: 12,
    lineHeight: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingTop: 10,
  },
  gatedBox: {
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  gatedText: { color: theme.colors.mutedForeground, fontSize: 12, lineHeight: 17 },
  budgetLine: { flexDirection: "row", alignItems: "center", columnGap: 10 },
  segments: { flexDirection: "row", columnGap: 4 },
  segment: { height: 6, width: 32, borderRadius: 3 },
  budgetCount: { fontSize: 12, fontVariant: ["tabular-nums"] },
  historyLine: { flexDirection: "row", alignItems: "flex-start", columnGap: 8 },
  historyText: { flex: 1, color: theme.colors.foreground, fontSize: 12, lineHeight: 17 },
  historyName: { fontWeight: "600" },
  historyAt: { color: theme.colors.mutedForeground, fontSize: 11, fontVariant: ["tabular-nums"] },
  roster: { flexDirection: "row", flexWrap: "wrap", columnGap: 6, rowGap: 6 },
  rosterChip: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 6,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingLeft: 4,
    paddingRight: 10,
    paddingVertical: 4,
  },
  rosterName: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
  rosterStatus: { fontSize: 11 },
  sourceTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
  sourceMeta: { color: theme.colors.mutedForeground, fontSize: 11 },
  challengeBox: {
    backgroundColor: theme.colors.warnSoft,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  challengeText: { color: theme.colors.warn, fontSize: 12, lineHeight: 17 },
  challengeQuote: { fontStyle: "italic" },
  resolvedBox: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 8,
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  resolvedOutcome: { color: theme.colors.ok, fontSize: 13, fontWeight: "600" },
  resolvedAt: { marginLeft: "auto", color: theme.colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  actions: { rowGap: 10 },
  option: {
    borderRadius: theme.radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    rowGap: 2,
  },
  optionPrimary: { borderColor: theme.colors.ring },
  optionLabel: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
  optionDetail: { color: theme.colors.mutedForeground, fontSize: 12, lineHeight: 16 },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", columnGap: 8, rowGap: 8 },
  button: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.input,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignSelf: "flex-start",
  },
  buttonPrimary: { backgroundColor: theme.colors.foreground, borderColor: theme.colors.foreground },
  buttonGhost: { borderColor: "transparent" },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { color: theme.colors.foreground, fontSize: 13, fontWeight: "500" },
  buttonLabelPrimary: { color: theme.colors.primaryForeground, fontWeight: "600" },
  buttonLabelGhost: { color: theme.colors.mutedForeground },
  buttonLabelDisabled: { color: theme.colors.mutedForeground },
  desktopNote: { color: theme.colors.mutedForeground, fontSize: 11 },
  pressed: { opacity: 0.7 },
});
