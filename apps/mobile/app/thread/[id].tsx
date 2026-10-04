// An existing thread (a row in /threads): history from the server, then the same composer as the
// Chat tab. Web counterpart: `/?session=<id>` (routes/home.tsx).
import { Stack, useLocalSearchParams } from "expo-router";

import { ThreadView } from "@/components/chat/thread-view";
import { Screen } from "@/components/ui";

export default function ThreadScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  return (
    <Screen>
      <Stack.Screen options={{ title: title || "Thread" }} />
      <ThreadView key={id} sessionId={id} placeholder="Reply to Dana…" />
    </Screen>
  );
}
