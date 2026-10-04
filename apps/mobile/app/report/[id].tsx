import { useLocalSearchParams } from "expo-router";

import { EmptyState, Pill, Screen } from "@/components/ui";

/** MOB-C owns this file. Placeholder from MOB-A so /report/:id resolves (MOBILE-PLAN §6 step 6). */
export default function ReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Screen>
      <EmptyState title={`Report ${id ?? ""}`} hint="Placeholder — MOB-C builds the read-only report (summary, results table, caveats, provenance)." />
      <Pill variant="run">MOB-C</Pill>
    </Screen>
  );
}
