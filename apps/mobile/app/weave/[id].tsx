import { useLocalSearchParams } from "expo-router";

import { EmptyState, Pill, Screen } from "@/components/ui";

/** MOB-B owns this file. Placeholder from MOB-A so /weave/:id resolves (MOBILE-PLAN §6 step 4). */
export default function WeaveItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Screen>
      <EmptyState title={`Weave item ${id ?? ""}`} hint="Placeholder — MOB-B builds the item detail (why, preview/budget rows, actions[])." />
      <Pill variant="replay">MOB-B</Pill>
    </Screen>
  );
}
