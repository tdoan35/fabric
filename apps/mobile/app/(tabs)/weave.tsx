import { EmptyState, Pill, Screen } from "@/components/ui";

/**
 * MOB-B owns this file (plus app/weave/[id].tsx and components/weave/**). Placeholder from MOB-A
 * so the tab resolves; replace it with the Weave list (MOBILE-PLAN §6 step 4). lib/** and
 * components/ui/** are frozen — request changes through docs/status/mobile.md.
 */
export default function WeaveTab() {
  return (
    <Screen>
      <EmptyState title="Weave" hint="Placeholder — MOB-B builds the inbox here (pull to refresh, tap for detail)." />
      <Pill variant="replay">MOB-B</Pill>
    </Screen>
  );
}
