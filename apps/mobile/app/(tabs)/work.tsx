import { EmptyState, Pill, Screen } from "@/components/ui";

/**
 * MOB-C owns this file (plus app/report/[id].tsx and components/work/**). Placeholder from MOB-A
 * so the tab resolves; replace it with the Work index (MOBILE-PLAN §6 step 5). lib/** and
 * components/ui/** are frozen — request changes through docs/status/mobile.md.
 */
export default function WorkTab() {
  return (
    <Screen>
      <EmptyState title="Work" hint="Placeholder — MOB-C builds tasks and runs here (grouped by project, latest run per task)." />
      <Pill variant="run">MOB-C</Pill>
    </Screen>
  );
}
