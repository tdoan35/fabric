import { Pressable, StyleSheet, Text, View } from "react-native";
import type { InboxItem } from "@fabric/contracts";

import { theme } from "@/lib/theme";
import { age, waited } from "./format";
import { personLabel, personName, type PersonMap } from "./people";
import { Face } from "./face";
import { type Resolution } from "./store";

/**
 * One inbox row (web counterpart: components/weave/inbox.tsx Row): unread dot, persona, time,
 * the one-line title, then the cost-of-delay line while it waits — or the `effect.outcome`
 * label once it's resolved locally.
 */

export function InboxRow({ item, resolution, read, people, onPress }: {
  item: InboxItem;
  resolution: Resolution | undefined;
  read: boolean;
  people: PersonMap;
  onPress: () => void;
}) {
  const done = resolution !== undefined;
  const unread = !!item.unread && !read;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${personLabel(item.agentId, people)}: ${item.title}`}>
      {unread && <View style={styles.dot} />}
      <Face agentId={item.agentId} size={36} />
      <View style={styles.main}>
        <View style={styles.topLine}>
          <Text numberOfLines={1} style={styles.name}>
            {personLabel(item.agentId, people)}
          </Text>
          <Text style={styles.time}>{age(item.at)}</Text>
        </View>
        <Text numberOfLines={2} style={[styles.title, unread && styles.titleUnread, done && styles.titleDone]}>
          {item.title}
        </Text>
        {done ? (
          <Text numberOfLines={1} style={styles.outcome}>
            ✓ {resolution.outcome} · {age(resolution.at)}
          </Text>
        ) : item.blocking ? (
          <Text numberOfLines={1} style={styles.blocking}>
            Blocks {item.blocking.step} · {personName(item.blocking.agentId, people)}, {waited(item.blocking.since)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    columnGap: 10,
    alignItems: "flex-start",
    paddingVertical: 10,
    paddingLeft: 8,
    paddingRight: 4,
    borderRadius: theme.radius.md,
  },
  pressed: { backgroundColor: theme.colors.secondary },
  dot: {
    position: "absolute",
    left: 0,
    top: 16,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.run,
  },
  main: { flex: 1, rowGap: 3 },
  topLine: { flexDirection: "row", alignItems: "baseline", columnGap: 8 },
  name: {
    flexShrink: 1,
    color: theme.colors.mutedForeground,
    fontSize: 12,
  },
  time: {
    marginLeft: "auto",
    color: theme.colors.mutedForeground,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  title: { color: theme.colors.foreground, fontSize: 14, lineHeight: 19 },
  titleUnread: { fontWeight: "600" },
  titleDone: { color: theme.colors.mutedForeground },
  blocking: { color: theme.colors.warn, fontSize: 12 },
  outcome: { color: theme.colors.ok, fontSize: 12 },
});
