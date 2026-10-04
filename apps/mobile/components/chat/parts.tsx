// Chat part rendering (MOBILE-PLAN §2 M1). Mirrors the web's components/chat/cards.tsx mapping,
// read-only: text parts as text, `record_disposition` as the chip, `propose_team` /
// `propose_specialist` / `handoff_to_team` as cards that say "Approve on desktop" — deciding from
// the phone is M2 (the human-tool {decision} flow needs a thread runtime, MOBILE-PLAN §2 M1).
// Args arrive as `unknown` (ChatPartSchema only guarantees the envelope), so every field is read
// defensively and the card renders whatever is present — the web trusts its casts, RN can't crash.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { ChatPart, Disposition, ThreadMessage } from "@fabric/contracts";

import { Card, Pill } from "@/components/ui";
import { theme } from "@/lib/theme";

const DISPOSITION_LABEL: Record<Disposition, string> = {
  handle_directly: "handle directly",
  delegate_agent: "delegate agent",
  delegate_team: "delegate team",
  propose_team: "propose team",
  propose_specialist: "propose specialist",
  clarify: "clarify",
};

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** `propose_team` / `propose_specialist`: a pending proposal (no result) or a decided one. */
function ProposalCard({ part }: { part: Extract<ChatPart, { type: "tool-call" }> }) {
  const args = rec(part.args);
  const persona = rec(args.persona);
  const decision = str(rec(part.result).decision);
  const roster = arr(args.roster)
    .map((r) => {
      const member = rec(r);
      return [str(member.name), str(member.role)].filter(Boolean).join(" · ");
    })
    .filter(Boolean)
    .join(", ");
  const rows = arr(args.rows)
    .map((r) => {
      const row = rec(r);
      return [str(row.label), str(row.value)].filter(Boolean).join(" — ");
    })
    .filter(Boolean);

  return (
    <Card style={styles.card}>
      <Text style={styles.heading}>
        {part.toolName === "propose_specialist" ? "Specialist proposal" : "Team proposal"}
      </Text>
      <Text style={styles.name}>{str(args.name) ?? str(persona.name) ?? "Untitled"}</Text>
      {str(args.purpose) ? <Text style={styles.muted}>{str(args.purpose)}</Text> : null}
      {roster ? (
        <Text style={styles.muted} numberOfLines={2}>
          {roster}
        </Text>
      ) : null}
      {rows.length ? (
        <View>
          {rows.slice(0, 4).map((row) => (
            <Text key={row} style={styles.muted} numberOfLines={1}>
              {row}
            </Text>
          ))}
        </View>
      ) : null}
      {decision ? (
        <View style={styles.footer}>
          <Pill variant={decision === "approved" ? "ok" : "muted"}>
            {decision === "approved" ? "Approved" : decision === "declined" ? "Declined" : "Discussing"}
          </Pill>
          <Text style={styles.note}>Decided on desktop</Text>
        </View>
      ) : (
        <View style={styles.footer}>
          <Pill variant="warn">Approve on desktop</Pill>
          <Text style={styles.note}>Nothing is created until you approve it</Text>
        </View>
      )}
    </Card>
  );
}

/** `handoff_to_team` (D3): no approval of its own — the phone just watches it run. */
function HandoffCard({ part }: { part: Extract<ChatPart, { type: "tool-call" }> }) {
  const args = rec(part.args);
  const result = rec(part.result);
  const members = arr(args.members ?? result.members)
    .map((m) => {
      const member = rec(m);
      return [str(member.name), str(member.role)].filter(Boolean).join(" · ");
    })
    .filter(Boolean)
    .join(", ");
  return (
    <Card style={styles.card}>
      <Text style={styles.heading}>Handoff to team</Text>
      <Text style={styles.name}>{str(args.teamName) ?? str(result.teamName) ?? "The team"}</Text>
      {str(args.title) ?? str(result.title) ? (
        <Text style={styles.muted}>{str(args.title) ?? str(result.title)}</Text>
      ) : null}
      {members ? (
        <Text style={styles.muted} numberOfLines={2}>
          {members}
        </Text>
      ) : null}
      <View style={styles.footer}>
        <Pill variant="run">{part.result !== undefined ? "Working — see Work tab" : "Starting"}</Pill>
      </View>
    </Card>
  );
}

/** `post_results` (CHAT-14): the results message Dana posts when a run finalizes. */
function ResultsCard({ part }: { part: Extract<ChatPart, { type: "tool-call" }> }) {
  const args = rec(part.args);
  const reportId = str(args.reportId);
  const router = useRouter();
  return (
    <Card style={styles.card}>
      <Text style={styles.heading}>Results</Text>
      <Text style={styles.name}>{str(args.title) ?? "Report ready"}</Text>
      {str(args.summary) ? (
        <Text style={styles.muted} numberOfLines={4}>
          {str(args.summary)}
        </Text>
      ) : null}
      {reportId ? (
        <Pressable hitSlop={8} onPress={() => router.push(`/report/${reportId}`)}>
          <Text style={styles.link}>Open report ›</Text>
        </Pressable>
      ) : (
        <Text style={styles.note}>Read the report on the desktop</Text>
      )}
    </Card>
  );
}

/** `record_disposition`: how Dana routed the turn — a chip, not a card (web: DispositionChip). */
function DispositionChip({ part }: { part: Extract<ChatPart, { type: "tool-call" }> }) {
  const args = rec(part.args);
  const label = str(args.disposition);
  const reason = str(args.reason);
  return (
    <View style={styles.chipRow}>
      <View style={styles.chipDot} />
      <Text style={styles.chip}>{label && label in DISPOSITION_LABEL ? DISPOSITION_LABEL[label as Disposition] : "recorded"}</Text>
      {reason ? (
        <Text style={styles.chipReason} numberOfLines={2}>
          {reason}
        </Text>
      ) : null}
    </View>
  );
}

/** Any server-executed tool that isn't one of the known cards (future tools degrade visibly). */
function ToolChip({ part }: { part: Extract<ChatPart, { type: "tool-call" }> }) {
  return (
    <View style={styles.chipRow}>
      <View style={styles.chipDot} />
      <Text style={styles.chip}>{part.toolName}</Text>
      {part.result !== undefined ? <Text style={styles.chipReason}>✓ done</Text> : null}
    </View>
  );
}

function ToolCallPart({ part }: { part: Extract<ChatPart, { type: "tool-call" }> }) {
  switch (part.toolName) {
    case "record_disposition":
      return <DispositionChip part={part} />;
    case "propose_team":
    case "propose_specialist":
      return <ProposalCard part={part} />;
    case "handoff_to_team":
      return <HandoffCard part={part} />;
    case "post_results":
      return <ResultsCard part={part} />;
    default:
      return <ToolChip part={part} />;
  }
}

export function ChatPartView({ part }: { part: ChatPart }) {
  if (part.type === "text") {
    if (!part.text.trim()) return null;
    return <Text style={styles.text}>{part.text}</Text>;
  }
  return <ToolCallPart part={part} />;
}

/** One message: user right-aligned in a bubble, assistant full-width (text + cards). */
export function MessageBubble({ message }: { message: ThreadMessage }) {
  if (message.role === "user") {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          {message.content.map((part, i) =>
            part.type === "text" ? (
              <Text key={i} style={styles.userText}>
                {part.text}
              </Text>
            ) : null,
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.assistantRow}>
      {message.content.map((part, i) => (
        <ChatPartView key={part.type === "tool-call" ? part.toolCallId : `text-${i}`} part={part} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 4 },
  userBubble: {
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.radius.lg,
    borderBottomRightRadius: theme.radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 12,
    maxWidth: "85%",
  },
  userText: { color: theme.colors.foreground, fontSize: 15, lineHeight: 21 },
  assistantRow: { paddingVertical: 4, rowGap: 6 },
  text: { color: theme.colors.foreground, fontSize: 15, lineHeight: 21 },
  card: { alignSelf: "stretch", padding: 12 },
  heading: { color: theme.colors.mutedForeground, fontSize: 11, fontWeight: "600", textTransform: "uppercase" },
  name: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" },
  muted: { color: theme.colors.mutedForeground, fontSize: 13, lineHeight: 18 },
  footer: { flexDirection: "row", alignItems: "center", columnGap: 10, flexWrap: "wrap", paddingTop: 2 },
  note: { color: theme.colors.mutedForeground, fontSize: 12 },
  link: { color: theme.colors.run, fontSize: 13, fontWeight: "600" },
  chipRow: { flexDirection: "row", alignItems: "center", columnGap: 6, flexWrap: "wrap", paddingVertical: 2 },
  chipDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.mutedForeground },
  chip: {
    color: theme.colors.mutedForeground,
    fontSize: 11,
    fontFamily: "monospace",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.full,
    paddingVertical: 1,
    paddingHorizontal: 8,
    overflow: "hidden",
  },
  chipReason: { color: theme.colors.mutedForeground, fontSize: 11, flex: 1, minWidth: 120 },
});
