import { useState } from "react";
import { AssistantThread } from "@/components/chat/assistant-thread";
import { useTabs } from "@/components/shell/tabs";

export function HomePage() {
  // The selected agent lives here so it survives starting a new thread ("Back to Dana" remounts the thread).
  const [agentIndex, setAgentIndex] = useState(0);
  const [threadKey, setThreadKey] = useState(0);
  // A new tab gets a fresh thread even though it is the same route.
  const { activeId } = useTabs();
  return (
    <AssistantThread
      key={`${activeId}:${threadKey}`}
      agentIndex={agentIndex}
      onAgentChange={setAgentIndex}
      onBackToDana={() => { setAgentIndex(0); setThreadKey((k) => k + 1); }}
    />
  );
}
