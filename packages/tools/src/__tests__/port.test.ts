// ANY-67 R4–R9 — the ToolPort adapter: describe without execute, run with
// parsed args and the caller's scope, fail-closed validation, thrown errors
// as results, onLine streaming, and the allowed-list narrowing.
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createRegistry, defineTool } from "../index";
import { scope, webSearchSpec } from "./fixtures";

test("R4 describe returns the declared effect and no execute key; an unknown name is undefined", () => {
  const port = createRegistry([
    defineTool({ name: "web_search", ...webSearchSpec }),
  ]).toolPort(scope);

  const described = port.describe("web_search");
  expect(described?.effect).toBe("read");
  expect("execute" in described!).toBe(false);

  expect(port.describe("nope")).toBeUndefined();
});

test("R5 run returns ok with the execute result; execute received the parsed args (default applied) and the exact scope object", async () => {
  const seen: { args?: unknown; scope?: unknown } = {};
  const probe = defineTool({
    name: "probe",
    description: "records what it was handed",
    parameters: z.object({ q: z.string(), n: z.number().default(3) }),
    effect: "read",
    gate: "none",
    kind: "read",
    step: 0,
    execute: async (args, ctx) => {
      seen.args = args;
      seen.scope = ctx.scope;
      return args.q;
    },
  });

  const result = await createRegistry([probe]).toolPort(scope).run("probe", { q: "hi" }, {});
  expect(result).toEqual({ ok: true, result: "hi" });
  expect(seen.args).toEqual({ q: "hi", n: 3 });
  expect(seen.scope).toBe(scope);
});

test('R6 invalid arguments fail closed: ok false, error starts with "invalid arguments", execute is never called', async () => {
  const execute = vi.fn(async () => "never reached");
  const guarded = defineTool({
    name: "guarded",
    description: "requires a query",
    parameters: z.object({ q: z.string() }),
    effect: "read",
    gate: "none",
    kind: "read",
    step: 0,
    execute,
  });

  const result = await createRegistry([guarded]).toolPort(scope).run("guarded", { q: 42 }, {});
  expect(result.ok).toBe(false);
  expect(result.error?.startsWith("invalid arguments")).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

test('R7 a thrown Error("boom") becomes { ok: false, error: "boom" } and the run never rejects', async () => {
  const bomb = defineTool({
    name: "bomb",
    description: "always throws",
    parameters: z.object({}),
    effect: "once",
    gate: "always",
    kind: "external",
    step: 2,
    execute: async () => {
      throw new Error("boom");
    },
  });

  await expect(
    createRegistry([bomb]).toolPort(scope).run("bomb", {}, {})
  ).resolves.toEqual({ ok: false, error: "boom" });
});

test("R8 lines passed to ctx.onLine reach io.onLine in order; a run without io.onLine still succeeds", async () => {
  const chatty = defineTool({
    name: "chatty",
    description: "streams two lines",
    parameters: z.object({}),
    effect: "read",
    gate: "none",
    kind: "command",
    step: 1,
    execute: async (_args, ctx) => {
      ctx.onLine("one");
      ctx.onLine("two");
      return "done";
    },
  });

  const port = createRegistry([chatty]).toolPort(scope);
  const lines: string[] = [];
  const result = await port.run("chatty", {}, { onLine: (line) => lines.push(line) });
  expect(result).toEqual({ ok: true, result: "done" });
  expect(lines).toEqual(["one", "two"]);

  await expect(port.run("chatty", {}, {})).resolves.toEqual({ ok: true, result: "done" });
});

test('R9 a port built with allowed ["a"]: registered tool b is undefined to describe and "unknown tool: b" to run', async () => {
  const mk = (name: string) =>
    defineTool({
      name,
      description: "narrowed by the allowed list",
      parameters: z.object({}),
      effect: "read",
      gate: "none",
      kind: "read",
      step: 0,
      execute: async () => name,
    });

  const port = createRegistry([mk("a"), mk("b")]).toolPort(scope, ["a"]);
  expect(port.describe("b")).toBeUndefined();
  expect(port.describe("a")?.name).toBe("a");
  await expect(port.run("b", {}, {})).resolves.toEqual({
    ok: false,
    error: "unknown tool: b",
  });
});
