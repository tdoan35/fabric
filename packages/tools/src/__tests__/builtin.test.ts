// ANY-72 W1–W10, W12 — the step-0 builtin tools. Exa and AgentMail are
// injected fakes; `web_fetch` hits a local loopback server through the
// test-only allowlist hook (W4), which W5 proves is off by default. DNS is
// faked through the injectable resolver; no test touches the network.
import { expect, test, vi } from "vitest";
import type { ToolExecCtx } from "../define";
import {
  baseScope,
  fakeAgentMail,
  fakeExa,
  startOrigin,
  type RecordingExa,
} from "./builtin-fixtures";
import { builtinTools } from "../builtin";
import type { ToolDef } from "../define";

/** Lines a tool streams; the tests never assert on them, execute needs the key. */
const lines: string[] = [];
const ctx = (scope: Record<string, unknown>): ToolExecCtx => ({
    scope: scope as ToolExecCtx["scope"],
    onLine: (line) => lines.push(line),
  });

const key = (v: string) => async (name: string) => {
  if (name !== v) throw new Error(`unexpected secret ${name}`);
  return `key-for-${v}`;
};

const tool = (name: string): ToolDef => {
    const t = tools.find((d: ToolDef) => d.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };

const tools = builtinTools({ sendFrom: "sana-fabric@agentmail.to" });

test("W1 metadata table: web_search, web_fetch and send declare the exact effect, gate, kind and step", () => {
  expect(tool("web_search").effect).toBe("read");
  expect(tool("web_search").gate).toBe("none");
  expect(tool("web_search").kind).toBe("read");
  expect(tool("web_search").step).toBe(0);

  expect(tool("web_fetch").effect).toBe("read");
  expect(tool("web_fetch").gate).toBe("none");
  expect(tool("web_fetch").kind).toBe("read");
  expect(tool("web_fetch").step).toBe(0);

  expect(tool("send").effect).toBe("once");
  expect(tool("send").gate).toBe("always");
  expect(tool("send").kind).toBe("external");
  expect(tool("send").step).toBe(0);
});

test("W2 web_search passes query, limit and the vault key to the client; hits map to { title, url, snippet }; limit defaults to 5", async () => {
  const exa = fakeExa([
    { title: "Exa", url: "https://exa.ai", highlight: "search for agents" },
    { title: "Second", url: "https://second.example", highlight: "another" },
  ]);
  const search = tool("web_search");

  const bare = (await search.execute({ query: "agent memory" }, ctx({ ...baseScope, secret: key("exa"), exa }))) as {
    ok: boolean;
    results?: unknown;
  };
  expect(exa.calls[0]?.query).toBe("agent memory");
  expect(exa.calls[0]?.options).toMatchObject({ numResults: 5 });
  expect(bare.ok).toBe(true);
  expect(bare.results).toEqual([
    { title: "Exa", url: "https://exa.ai", snippet: "search for agents" },
    { title: "Second", url: "https://second.example", snippet: "another" },
  ]);

  const explicitExa = fakeExa([]);
  const explicit = (await search.execute({ query: "q", limit: 3 }, ctx({ ...baseScope, secret: key("exa"), exa: explicitExa }))) as { ok: boolean };
  expect(explicit.ok).toBe(true);
  expect((explicitExa.calls[0]?.options as { numResults?: number } | undefined)?.numResults).toBe(3);
});

test("W3 web_search with no exa secret: ok false with the configured message, client untouched", async () => {
  const exa = fakeExa([]);
  const missing = async () => {
    throw new Error("vault: absent");
  };
  const result = (await tool("web_search").execute(
    { query: "q" },
    ctx({ ...baseScope, secret: missing, exa }))
  ) as { ok: boolean; error?: string };

  expect(result).toEqual({
    ok: false,
    error: "web search is not configured (vault: exa)",
  });
  expect(exa.calls).toHaveLength(0);
});

test("W4 web_fetch of a local page: text without tags or script, plus status and contentType (loopback allowed via the test hook)", async () => {
  const origin = await startOrigin((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<html><head><style>body{color:red}</style></head><body><h1>Hi</h1><script>var x=1;</script><p>  body   text </p></body></html>"
    );
    void req;
  });
  try {
    const result = (await tool("web_fetch").execute(
      { url: `${origin.url}/page` },
      ctx({ ...baseScope, allowLoopback: origin.url })
    )) as { ok: boolean; result?: { url: string; status: number; contentType: string; text: string; truncated: boolean } };

    expect(result.ok).toBe(true);
    expect(result.result?.status).toBe(200);
    expect(result.result?.contentType).toContain("text/html");
    expect(result.result?.truncated).toBe(false);
    expect(result.result?.text).toContain("Hi");
    expect(result.result?.text).toContain("body text");
    expect(result.result?.text).not.toContain("<");
    expect(result.result?.text).not.toContain("var x=1");
    expect(result.result?.text).not.toContain("color:red");
    expect(result.result?.url).toBe(`${origin.url}/page`);
  } finally {
    await origin.close();
  }
});

test("W5 web_fetch refuses loopback, private, link-local, unspecified and metadata hosts with no connection attempt", async () => {
  const attempts: string[] = [];
  const probe = async (url: string) =>
    tool("web_fetch").execute(
      { url },
      ctx({
        ...baseScope,
        resolver: () => [],
        onConnect: (host: string) => attempts.push(host),
      })
    );

  for (const url of [
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://169.254.169.254/meta",
    "http://[::1]/x",
    "http://metadata.google.internal/computeMetadata",
  ]) {
    const result = (await probe(url)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  }

  // A hostname that resolves private is refused too — the guard is on the
  // resolved address, not the literal.
  const priv = (await tool("web_fetch").execute(
    { url: "http://intranet.example/x" },
    ctx({ ...baseScope, resolver: () => ["192.168.1.1"] })
  )) as { ok: boolean };
  expect(priv.ok).toBe(false);
  expect(attempts).toEqual([]);
});

test("W6 DNS rebinding: the connection goes to the first, validated address the resolver returned", async () => {
    const origin = await startOrigin((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reached");
      void req;
    });
    try {
      const port = new URL(origin.url).port;
      const local = "127.0.0.1";
      const other = "192.0.2.9"; // public, unroutable here: connecting to it fails
      let connected = "";
      const result = (await tool("web_fetch").execute(
        { url: `http://rebind.example:${port}/` },
        ctx({
          ...baseScope,
          // The validated list, reachable first: the pinning must connect to
          // the first entry; a lookup-after-check preferring the second would
          // time out against 192.0.2.9. The loopback allowlist (W4's seam)
          // admits the local server; W5 proves it off by default.
          allowLoopback: `http://rebind.example:${port}`,
          resolver: () => [local, other],
          onConnect: (addr: string) => {
            connected = addr;
          },
        })
      )) as { ok: boolean };

      expect(result.ok).toBe(true);
      expect(connected).toBe(local);
    } finally {
      await origin.close();
    }
  }, 30_000);

test("W7 redirects: a 302 to a private address is refused; the fourth hop fails with too many redirects", async () => {
  const origin = await startOrigin((req, res) => {
    const to = new URL(req.url ?? "/", `http://127.0.0.1`);
    switch (to.pathname) {
      case "/to-private":
        res.writeHead(302, { location: "http://10.0.0.9/inside" });
        res.end();
        return;
      case "/hop1":
        res.writeHead(302, { location: "/hop2" });
        res.end();
        return;
      case "/hop2":
        res.writeHead(302, { location: "/hop3" });
        res.end();
        return;
      case "/hop3":
        res.writeHead(302, { location: "/hop4" });
        res.end();
        return;
      case "/hop4":
        res.writeHead(302, { location: "/landed" });
        res.end();
        return;
      default:
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("landed");
    }
  });
  try {
    const priv = (await tool("web_fetch").execute(
      { url: `${origin.url}/to-private` },
      ctx({ ...baseScope, allowLoopback: origin.url })
    )) as { ok: boolean };
    expect(priv.ok).toBe(false);

    const loops = (await tool("web_fetch").execute(
      { url: `${origin.url}/hop1` },
      ctx({ ...baseScope, allowLoopback: origin.url })
    )) as { ok: boolean; error?: string };
    expect(loops.ok).toBe(false);
    expect(loops.error).toBe("too many redirects");
  } finally {
    await origin.close();
  }
});

test("W8 the 2 MB body cap truncates and the 20 s timeout fires under fake timers", { timeout: 30_000 }, async () => {
  const big = "x".repeat(2 * 1024 * 1024 + 11);
  const origin = await startOrigin((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(big);
    void req;
  });
  try {
    const result = (await tool("web_fetch").execute(
      { url: `${origin.url}/big` },
      ctx({ ...baseScope, allowLoopback: origin.url })
    )) as { ok: boolean; result?: { text: string; truncated: boolean } };
    expect(result.ok).toBe(true);
    expect(result.result?.truncated).toBe(true);
    expect(result.result?.text.length).toBeLessThanOrEqual(2 * 1024 * 1024);

    // The hang case: response headers, body never ends. Fake timers drive the
    // 20 s timeout; the socket close is observed via the aborted fetch.
    vi.useFakeTimers();
    try {
      const hang = await startOrigin((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        // no end: the body hangs
      });
      try {
        const pending = tool("web_fetch").execute(
          { url: `${hang.url}/hang` },
          ctx({ ...baseScope, allowLoopback: hang.url })
        ) as Promise<{ ok: boolean; error?: string }>;
        const done = pending.then((r) => r);
        await vi.advanceTimersByTimeAsync(20_000);
        const timedOut = await done;
        expect(timedOut.ok).toBe(false);
        expect(timedOut.error).toMatch(/timed out|timeout|abort/i);
      } finally {
        hang.server.closeAllConnections?.();
        await hang.close();
      }
    } finally {
      vi.useRealTimers();
    }
  } finally {
    await origin.close();
  }
});

test("W9 send passes to, subject, text, the sendFrom inbox and idempotencyKey fabric:<callId>; returns messageId", async () => {
  const mail = fakeAgentMail("am-42");
  const result = (await tool("send").execute(
    { to: "ty@example.com", subject: "Hello", text: "Body" },
    ctx({ ...baseScope, callId: "c7", secret: key("agentmail"), agentmail: mail })
  )) as { ok: boolean; result?: { messageId: string; idempotencyKey: string } };

  expect(result.ok).toBe(true);
  expect(result.result).toEqual({ messageId: "am-42", idempotencyKey: "fabric:c7" });
  expect(mail.sends).toHaveLength(1);
  expect(mail.sends[0]?.inboxId).toBe("sana-fabric@agentmail.to");
  expect(mail.sends[0]?.request).toMatchObject({
    to: "ty@example.com",
    subject: "Hello",
    text: "Body",
  });
  expect(mail.sends[0]?.options).toMatchObject({ idempotencyKey: "fabric:c7" });
});

test("W10 send with no agentmail secret: ok false, client untouched", async () => {
  const mail = fakeAgentMail();
  const missing = async () => {
    throw new Error("vault: absent");
  };
  const result = (await tool("send").execute(
    { to: "ty@example.com", subject: "s", text: "t" },
    ctx({ ...baseScope, callId: "c8", secret: missing, agentmail: mail })
  )) as { ok: boolean; error?: string };

  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
  expect(mail.sends).toHaveLength(0);
});

test("W12 ToolScope.secret is the only path to a key: builtin sources never import the vault", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = path.resolve(import.meta.dirname, "../builtin");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
  expect(files).toContain("index.ts");
  for (const file of files) {
    const src = await readFile(path.join(dir, file), "utf8");
    const code = src.replace(/\/\/[^\n]*/g, ""); // comments may mention env; code may not use it
    expect(code, `${file} imports the vault`).not.toMatch(/from "(.*\/)?vault/);
    expect(code, `${file} reads process.env`).not.toMatch(/process\.env/);
  }
});

export type { RecordingExa };
