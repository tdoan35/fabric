import type { InboxItem, ItemKind } from "@fabric/contracts";
import type { PillVariant } from "@/components/ui/pill";

/**
 * Pure list logic, no react-native imports, so the live-payload smoke script can run it under
 * plain node/tsx against the server's response.
 */

/** Label + semantic tone per kind, mirroring the web's KIND map (components/weave/parts.tsx). */
export const KIND_META: Record<ItemKind, { label: string; variant: PillVariant }> = {
  approval: { label: "Approval", variant: "warn" },
  question: { label: "Question", variant: "run" },
  escalation: { label: "Escalation", variant: "warn" },
  proposal: { label: "Proposal", variant: "replay" },
  finding: { label: "Finding", variant: "run" },
  result: { label: "Result", variant: "ok" },
};

/** Section order: asks first (waiting on you), then for-you, then results. */
export const KIND_ORDER: readonly ItemKind[] = [
  "approval",
  "question",
  "escalation",
  "proposal",
  "finding",
  "result",
];

export interface WeaveGroup<T = InboxItem> {
  kind: ItemKind;
  data: T[];
}

/** List sections: one non-empty group per kind, newest first inside each. */
export function groupByKind<T extends { kind: ItemKind; at: string }>(items: readonly T[]): WeaveGroup<T>[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    data: items
      .filter((item) => item.kind === kind)
      .sort((a, b) => +new Date(b.at) - +new Date(a.at)),
  })).filter((group) => group.data.length > 0);
}

export type HrefTarget = { type: "report"; reportId: string } | { type: "desktop"; href: string };

/** Report hrefs open the native Report screen; any other href stays desktop-only in M0. */
export function hrefTarget(href: string): HrefTarget {
  const match = /^\/reports\/(.+)$/.exec(href);
  return match ? { type: "report", reportId: match[1] } : { type: "desktop", href };
}
