import { randomUUID } from "node:crypto";
import type { AppEvent, ChatPart, ChatStreamLine } from "@fabric/contracts";
import type { Db, RunWriter } from "@fabric/db";
import { recallFacts } from "./recall";
import { runErrand } from "./errand";
import { errandContext } from "./errand-context";
import { listMessages, recordDisposition } from "./store";
import { toModelMessages } from "./thread";

interface FixtureErrandDeps {
  db: Db;
  writer: RunWriter;
  publish: (event: AppEvent) => void;
  sessionId: string;
  projectId?: string | null;
  goal: string;
  incognito?: boolean;
}

export async function* fixtureErrandTurn(deps: FixtureErrandDeps): AsyncGenerator<ChatStreamLine> {
  const parts: ChatPart[] = [];
  const call = (toolName: string, args: unknown, result?: unknown): ChatPart => ({ type: "tool-call", toolName, toolCallId: randomUUID(), args, argsText: JSON.stringify(args), ...(result === undefined ? {} : { result }) });
  const args = { disposition: "handle_directly" as const, reason: "Replaying Dana's recorded browser errand, without making a new reservation", considered: ["handle_directly"] };
  parts.push(call("record_disposition", args, await recordDisposition(deps.db, deps.sessionId, args)));
  yield { content: [...parts] };
  const facts = deps.incognito ? [] : await recallFacts("reservation home usual Japanese restaurant name phone email party size");
  parts.push(call("recall", { query: "reservation home usual Japanese restaurant name phone email party size" }, { facts }));
  yield { content: [...parts] };
  if (deps.incognito) {
    parts.push({ type: "text", text: "Personal recall is disabled in incognito; this rehearsal did not run." });
    yield { content: [...parts] };
    return;
  }
  const input = { goal: deps.goal, startUrl: facts.find((f) => f.key === "restaurant.bookingUrl")?.value, facts: Object.fromEntries(facts.map((f) => [f.key, f.value])) };
  const part = call("browser_task", input);
  parts.push(part);
  yield { content: [...parts] };
  const thread = await listMessages(deps.db, deps.sessionId);
  const result = await runErrand(input, {
    ...deps, operationKey: [...thread].reverse().find((m) => m.role === "user")?.id ?? deps.sessionId,
    snapshot: errandContext("Dana's recorded rehearsal: disposition → recall → browser.task. No live booking.", toModelMessages(thread)),
    browser: {}, fixture: true,
  });
  if (part.type === "tool-call") part.result = result;
  parts.push({ type: "text", text: result.summary });
  yield { content: [...parts] };
}
