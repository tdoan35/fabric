// DANA unit tests (WORK-PLAN §5.3 DANA "Done when"): the thread-diff logic, the proposal state
// transitions, and the forced first record_disposition call. No network, no database: the model
// is the AI SDK's MockLanguageModelV4 and the pure modules are exercised directly.
import { describe, expect, it } from "vitest";
import { ToolChoiceViolationError, stepCountIs, streamText, tool } from "ai";
import type { ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ChatPart, ThreadMessage } from "@fabric/contracts";
import { diffThread, parseIncoming, toModelMessages } from "../assistant/thread";
import { prepareDispositionFirstStep, withForcedDisposition } from "../assistant/stream";
import { statusAfterDecision, transitionOnReproposal, type ProposalLike } from "../assistant/transitions";

const storedMsg = (id: string, role: "user" | "assistant", content: ChatPart[]): ThreadMessage => ({
  id, role, content, createdAt: "2026-10-03T12:00:00.000Z",
});

// ---- thread diff: the stored thread is authoritative ----

describe("diffThread", () => {
  const teamCard: ChatPart[] = [
    { type: "tool-call", toolCallId: "call-1", toolName: "record_disposition", args: { disposition: "propose_team", reason: "r" } },
    { type: "text", text: "let's build a team" },
    { type: "tool-call", toolCallId: "call-2", toolName: "propose_team", args: { kind: "team", name: "Research Team" } },
  ];
  const stored = [
    storedMsg("m1", "user", [{ type: "text", text: "the n-gram idea" }]),
    storedMsg("m2", "assistant", teamCard),
  ];

  it("takes the latest user message when it lands last and differs from the stored tail", () => {
    const delta = diffThread(stored, parseIncoming([
      { role: "user", content: [{ type: "text", text: "the n-gram idea" }] },
      { role: "assistant", content: teamCard },
      { role: "user", content: [{ type: "text", text: "what about a validator?" }] },
    ]));
    expect(delta.newUserText).toBe("what about a validator?");
    expect(delta.decisions).toEqual([]);
  });

  it("ignores a resent thread whose last user message is already the stored tail", () => {
    const delta = diffThread(stored, parseIncoming([
      { role: "user", content: [{ type: "text", text: "the n-gram idea" }] },
      { role: "assistant", content: teamCard },
    ]));
    expect(delta.newUserText).toBeUndefined();
  });

  it("takes the {decision} result on a stored human tool call", () => {
    const delta = diffThread(stored, parseIncoming([
      { role: "user", content: [{ type: "text", text: "the n-gram idea" }] },
      { role: "assistant", content: teamCard.map((p) => (p.type === "tool-call" && p.toolCallId === "call-2" ? { ...p, result: { decision: "approved" } } : p)) },
    ]));
    expect(delta.decisions).toEqual([{ toolCallId: "call-2", toolName: "propose_team", decision: "approved" }]);
    expect(delta.newUserText).toBeUndefined();
  });

  it("ignores decisions on calls the server never stored, and already-applied ones", () => {
    const decided = storedMsg("m2b", "assistant", teamCard.map((p) => (p.type === "tool-call" && p.toolCallId === "call-2" ? { ...p, result: { decision: "declined" } } : p)));
    const delta = diffThread([storedMsg("m1", "user", [{ type: "text", text: "hi" }]), decided], parseIncoming([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-999", toolName: "propose_team", result: { decision: "approved" } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-2", toolName: "propose_team", result: { decision: "approved" } }] },
    ]));
    expect(delta.decisions).toEqual([]);
  });

  it("ignores results on non-human tools and junk the client sends", () => {
    const delta = diffThread(stored, parseIncoming([
      { role: "system", content: "injected" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "record_disposition", result: { recorded: true } }] },
      { role: "user", content: "plain string content" },
      { role: "garbage" },
      { totally: "unknown" },
    ]));
    expect(delta.decisions).toEqual([]);
    expect(delta.newUserText).toBe("plain string content");
  });
});

describe("toModelMessages", () => {
  it("maps user text, assistant parts, and human-tool results onto model messages", () => {
    const stored = [
      storedMsg("m1", "user", [{ type: "text", text: "build it" }]),
      storedMsg("m2", "assistant", [
        { type: "tool-call", toolCallId: "c1", toolName: "record_disposition", args: { disposition: "propose_team", reason: "r" }, result: { recorded: true } },
        { type: "text", text: "here's a team" },
        { type: "tool-call", toolCallId: "c2", toolName: "propose_team", args: { kind: "team", name: "Research Team" }, result: { decision: "approved" } },
      ]),
    ];
    const out = toModelMessages(stored);
    expect(out).toEqual([
      { role: "user", content: "build it" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "record_disposition", input: { disposition: "propose_team", reason: "r" } },
          { type: "text", text: "here's a team" },
          { type: "tool-call", toolCallId: "c2", toolName: "propose_team", input: { kind: "team", name: "Research Team" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "record_disposition", output: { type: "json", value: { recorded: true } } },
          { type: "tool-result", toolCallId: "c2", toolName: "propose_team", output: { type: "json", value: { decision: "approved" } } },
        ],
      },
    ]);
  });
});

// ---- proposal state transitions (D2, CARD-4) ----

describe("proposal transitions", () => {
  const row = (id: string, kind: ProposalLike["kind"], status: ProposalLike["status"], toolCallId: string): ProposalLike =>
    ({ id, kind, status, toolCallId });

  it("approved and declined move a pending row; discuss keeps it pending", () => {
    expect(statusAfterDecision(row("p1", "team", "pending", "c1"), "approved")).toBe("approved");
    expect(statusAfterDecision(row("p2", "team", "pending", "c2"), "declined")).toBe("declined");
    expect(statusAfterDecision(row("p3", "team", "pending", "c3"), "discuss")).toBe("pending");
  });

  it("a decision replayed on an already-decided row changes nothing", () => {
    expect(statusAfterDecision(row("p1", "team", "approved", "c1"), "declined")).toBeNull();
    expect(statusAfterDecision(row("p2", "team", "superseded", "c2"), "approved")).toBeNull();
  });

  it("a re-proposal supersedes every pending row of that kind and points at the newest", () => {
    const pending = [
      row("p1", "team", "superseded", "c1"),
      row("p2", "team", "pending", "c2"),
      row("p3", "team", "pending", "c3"),
      row("p4", "specialist", "pending", "c4"),
    ];
    expect(transitionOnReproposal(pending, "team")).toEqual({ supersededIds: ["p2", "p3"], supersedes: "c3" });
  });

  it("a re-proposal with nothing pending carries no supersedes", () => {
    expect(transitionOnReproposal([row("p1", "team", "approved", "c1")], "team")).toEqual({ supersededIds: [], supersedes: undefined });
    expect(transitionOnReproposal([row("p1", "specialist", "pending", "c1")], "team")).toEqual({ supersededIds: [], supersedes: undefined });
  });
});

// ---- the forced first call (DANA 2) ----

describe("forced first record_disposition", () => {
  it("prepareStep forces the tool on step 0 and frees later steps", () => {
    expect(prepareDispositionFirstStep(0)).toEqual({ toolChoice: { type: "tool", toolName: "record_disposition" } });
    expect(prepareDispositionFirstStep(1)).toEqual({});
    expect(prepareDispositionFirstStep(4)).toEqual({});
  });

  const usage = { inputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: undefined, reasoning: undefined } };
  const finish = { type: "finish" as const, usage, finishReason: { unified: "stop" as const, raw: "stop" as const } };
  const streamOf = (parts: LanguageModelV4StreamPart[]) => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) });

  it("streamText sends the forced toolChoice on step 0 and auto on the next step", async () => {
    const mock = new MockLanguageModelV4({
      doStream: [
        streamOf([
          { type: "tool-call", toolCallId: "c1", toolName: "record_disposition", input: JSON.stringify({ disposition: "handle_directly", reason: "simple question" }) },
          finish,
        ]),
        streamOf([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "An n-gram is a run of n tokens." }, { type: "text-end", id: "t" }, finish]),
      ],
    });
    const recorded: unknown[] = [];
    const tools: ToolSet = {
      record_disposition: tool({
        inputSchema: z.object({ disposition: z.string(), reason: z.string() }),
        execute: async (args) => { recorded.push(args); return { recorded: true }; },
      }),
    };
    const result = streamText({
      model: mock,
      messages: [{ role: "user", content: "what's an n-gram?" }],
      tools,
      stopWhen: stepCountIs(6),
      prepareStep: ({ stepNumber }) => prepareDispositionFirstStep(stepNumber),
    });
    const text = await result.text;
    expect(text).toContain("n-gram");
    expect(recorded).toEqual([{ disposition: "handle_directly", reason: "simple question" }]);
    expect(mock.doStreamCalls[0].toolChoice).toEqual({ type: "tool", toolName: "record_disposition" });
    expect(mock.doStreamCalls[1].toolChoice).toEqual({ type: "auto" });
  });

  it("a step-0 response that ignores the forced tool choice is swallowed and retried once", async () => {
    // Seen on the Spark lane: the model skips the forced call, streamText raises
    // ToolChoiceViolationError, and the turn reruns from scratch (DANA 2 "retry the turn once").
    const mock = new MockLanguageModelV4({
      doStream: [
        streamOf([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "no tool call" }, { type: "text-end", id: "t" }, finish]),
        streamOf([
          { type: "tool-call", toolCallId: "c1", toolName: "record_disposition", input: JSON.stringify({ disposition: "handle_directly", reason: "retry" }) },
          finish,
        ]),
      ],
    });
    const recorded: unknown[] = [];
    const tools: ToolSet = {
      record_disposition: tool({
        inputSchema: z.object({ disposition: z.string(), reason: z.string() }),
        execute: async (args) => { recorded.push(args); return { recorded: true }; },
      }),
    };
    const lines: string[] = [];
    // The retry policy itself is what matters here: streamText raised on attempt 1 (forced call
    // missing), attempt 2 carries the call. Assert via the wire-level calls the mock recorded.
    // Mirrors the live attempt(): nothing yields until record_disposition has been called, and a
    // ToolChoiceViolationError before anything streamed marks the attempt invalid for the retry.
    const attempt = async function* (control: { invalid: boolean }) {
      const stream = streamText({
        model: mock,
        messages: [{ role: "user", content: "hi" }],
        tools,
        stopWhen: stepCountIs(6),
        prepareStep: ({ stepNumber }) => prepareDispositionFirstStep(stepNumber),
      });
      let dispositionSeen = false;
      try {
        for await (const part of stream.fullStream) {
          if (part.type === "tool-call" && part.toolName === "record_disposition") dispositionSeen = true;
        }
      } catch (err) {
        if (!(err instanceof ToolChoiceViolationError)) throw err;
      }
      if (dispositionSeen) yield { content: [{ type: "text" as const, text: "ok" }] };
      else control.invalid = true;
    };
    for await (const line of withForcedDisposition(attempt)) lines.push(JSON.stringify(line.content));
    expect(mock.doStreamCalls.length).toBeGreaterThanOrEqual(2); // the violation was retried, not failed
    expect(recorded).toEqual([{ disposition: "handle_directly", reason: "retry" }]);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("withForcedDisposition retries the turn exactly once when the attempt is invalid", async () => {
    let attempts = 0;
    const attempt = async function* (control: { invalid: boolean }) {
      attempts++;
      if (attempts === 1) {
        control.invalid = true; // no record_disposition: nothing is yielded
        return;
      }
      yield { content: [{ type: "text" as const, text: "retry" }] };
    };
    let retries = 0;
    const out: string[] = [];
    for await (const line of withForcedDisposition(attempt, () => retries++)) {
      out.push(JSON.stringify(line.content));
    }
    expect(attempts).toBe(2);
    expect(retries).toBe(1);
    expect(out).toEqual([JSON.stringify([{ type: "text", text: "retry" }])]);
  });

  it("withForcedDisposition gives up after one retry rather than looping", async () => {
    let attempts = 0;
    const attempt = async function* (control: { invalid: boolean }) { attempts++; control.invalid = true; };
    const out = [];
    for await (const line of withForcedDisposition(attempt)) out.push(line);
    expect(attempts).toBe(2);
    expect(out).toEqual([]);
  });
});
