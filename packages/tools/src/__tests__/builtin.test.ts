// ANY-72 W1–W10, W12 — the step-0 builtin tools. Exa and AgentMail are
// injected fakes; `web_fetch` hits a local loopback server through the
// test-only allowlist hook (W4), which W5 proves is off by default. DNS is
// faked through the injectable resolver; no test touches the network.
//
// Calls go through the registry's ToolPort, the path tool.exec takes, so a
// tool failure is asserted as the port's `{ ok: false }`, not a value the
// tool returned.
import { expect, test, vi } from "vitest";
import {
  baseScope,
  fakeAgentMail,
  fakeExa,
  startOrigin,
  type RecordingExa,
} from "./builtin-fixtures";
import { builtinTools } from "../builtin";
import type { ToolDef, ToolScope } from "../define";
import { createRegistry } from "../registry";

type PortResult<R = unknown> = { ok: boolean; result?: R; error?: string };

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
const registry = createRegistry(tools);

/** One call through the ToolPort, with test seams riding on the scope. */
const run = <R = unknown>(
  name: string,
  args: Record<string, unknown>,
  scope: Record<string, unknown>,
  io: { callId?: string } = {}
): Promise<PortResult<R>> =>
  registry.toolPort(scope as ToolScope).run(name, args, io) as Promise<PortResult<R>>;

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

  const bare = await run("web_search", { query: "agent memory" }, { ...baseScope, secret: key("exa"), exa });
  expect(exa.calls[0]?.query).toBe("agent memory");
  expect(exa.calls[0]?.options).toMatchObject({ numResults: 5 });
  expect(bare).toEqual({
    ok: true,
    result: [
      { title: "Exa", url: "https://exa.ai", snippet: "search for agents" },
      { title: "Second", url: "https://second.example", snippet: "another" },
    ],
  });

  const explicitExa = fakeExa([]);
  const explicit = await run("web_search", { query: "q", limit: 3 }, { ...baseScope, secret: key("exa"), exa: explicitExa });
  expect(explicit.ok).toBe(true);
  expect((explicitExa.calls[0]?.options as { numResults?: number } | undefined)?.numResults).toBe(3);
});

test("W3 web_search with no exa secret: ok false with the configured message, client untouched", async () => {
  const exa = fakeExa([]);
  const missing = async () => {
    throw new Error("vault: absent");
  };
  const result = await run("web_search", { query: "q" }, { ...baseScope, secret: missing, exa });

  expect(result).toEqual({
    ok: false,
    error: "web search is not configured (vault: exa)",
  });
  expect(exa.calls).toHaveLength(0);
});

type Fetched = { url: string; status: number; contentType: string; text: string; truncated: boolean };

test("W4 web_fetch of a local page: text without tags or script, plus status and contentType (loopback allowed via the test hook)", async () => {
  const origin = await startOrigin((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<html><head><style>body{color:red}</style></head><body><h1>Hi</h1><script>var x=1;</script><p>  body   text </p></body></html>"
    );
    void req;
  });
  try {
    const result = await run<Fetched>("web_fetch", { url: `${origin.url}/page` }, { ...baseScope, allowLoopback: origin.url });

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
  // The resolver answers every hostname with a public address, so only the
  // guard itself — on the literal, the hostname or the resolved address —
  // can refuse these.
  const attempts: string[] = [];
  const resolved: string[] = [];
  const publicResolver = (host: string) => {
    resolved.push(host);
    return ["93.184.215.14"];
  };
  const probe = (url: string, resolver: (host: string) => string[] = publicResolver) =>
    run("web_fetch", { url }, { ...baseScope, resolver, onConnect: (addr: string) => attempts.push(addr) });

  for (const url of [
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://169.254.169.254/meta",
    "http://0.0.0.0/x",
    "http://[::1]/x",
    "http://[::]/x",
    "http://[fe80::1]/x",
    "http://[fe90::1]/x", // still fe80::/10
    "http://[fd12:3456::1]/x", // ULA
    "http://[::ffff:127.0.0.1]/x", // IPv4-mapped loopback
    "http://[64:ff9b::a00:5]/x", // NAT64 of 10.0.0.5
    "http://metadata.google.internal/computeMetadata",
    "http://METADATA.google.internal./computeMetadata",
  ]) {
    const result = await probe(url);
    expect(result.ok, url).toBe(false);
    expect(result.error, url).toMatch(/^refused/);
  }
  // Literals are never resolved; the metadata host is refused by name.
  expect(resolved).toEqual([]);

  // A hostname that resolves private is refused too — the guard is on the
  // resolved address, not the literal.
  for (const address of ["192.168.1.1", "::ffff:7f00:1", "172.20.0.1"]) {
    const result = await probe("http://intranet.example/x", () => [address]);
    expect(result.ok, address).toBe(false);
    expect(result.error, address).toMatch(/^refused/);
  }
  expect(attempts).toEqual([]);
});

test("W6 DNS rebinding: the connection goes to the first, validated address the resolver returned", async () => {
    let seenHost = "";
    const origin = await startOrigin((req, res) => {
      seenHost = req.headers.host ?? "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reached");
    });
    try {
      const port = new URL(origin.url).port;
      // The first answer is the validated one (the local server, admitted by
      // W4's allowlist seam, which W5 proves off by default); every later
      // answer is the rebind target 192.0.2.9, unroutable here. Connecting
      // anywhere but the validated address — by asking the resolver again or
      // by letting the system resolve rebind.example — fails.
      const answers: string[][] = [["127.0.0.1"], ["192.0.2.9"]];
      let lookups = 0;
      const connected: string[] = [];
      const result = await run<Fetched>(
        "web_fetch",
        { url: `http://rebind.example:${port}/` },
        {
          ...baseScope,
          allowLoopback: `http://rebind.example:${port}`,
          resolver: () => answers[Math.min(lookups++, answers.length - 1)]!,
          onConnect: (addr: string) => connected.push(addr),
        }
      );

      expect(result.ok).toBe(true);
      expect(result.result?.text).toBe("reached");
      expect(lookups).toBe(1);
      expect(connected).toEqual(["127.0.0.1"]); // the socket's remote address
      expect(seenHost).toBe(`rebind.example:${port}`); // the original authority
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
    const priv = await run("web_fetch", { url: `${origin.url}/to-private` }, { ...baseScope, allowLoopback: origin.url });
    expect(priv.ok).toBe(false);
    expect(priv.error).toMatch(/^refused/);

    const three = await run<Fetched>("web_fetch", { url: `${origin.url}/hop2` }, { ...baseScope, allowLoopback: origin.url });
    expect(three.ok).toBe(true);
    expect(three.result?.url).toBe(`${origin.url}/landed`);

    const loops = await run("web_fetch", { url: `${origin.url}/hop1` }, { ...baseScope, allowLoopback: origin.url });
    expect(loops).toEqual({ ok: false, error: "too many redirects" });
  } finally {
    await origin.close();
  }
});

test("W8 the 2 MB body cap truncates and the 20 s timeout fires under fake timers", { timeout: 30_000 }, async () => {
  const cap = 2 * 1024 * 1024;
  const big = "x".repeat(cap + 11);
  const origin = await startOrigin((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(big);
    void req;
  });
  try {
    const result = await run<Fetched>("web_fetch", { url: `${origin.url}/big` }, { ...baseScope, allowLoopback: origin.url });
    expect(result.ok).toBe(true);
    expect(result.result?.truncated).toBe(true);
    expect(result.result?.text.length).toBe(cap);
  } finally {
    await origin.close();
  }

  // An endless body: the cap is enforced while reading, so the fetch returns
  // at 2 MB and drops the socket instead of buffering until the timeout.
  let served = 0;
  const endless = await startOrigin((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const chunk = "y".repeat(64 * 1024);
    const pump = () => {
      while (!res.destroyed && res.write(chunk)) served += chunk.length;
      if (!res.destroyed) res.once("drain", pump);
    };
    pump();
  });
  try {
    const result = await run<Fetched>("web_fetch", { url: `${endless.url}/endless` }, { ...baseScope, allowLoopback: endless.url });
    expect(result.ok).toBe(true);
    expect(result.result?.truncated).toBe(true);
    expect(result.result?.text.length).toBe(cap);
    expect(served).toBeLessThan(64 * cap);
  } finally {
    endless.server.closeAllConnections();
    await endless.close();
  }

  // The hang case: response headers, body never ends. Fake timers drive the
  // 20 s timeout once the request has reached the server.
  vi.useFakeTimers();
  try {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const hang = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      arrived();
      // no end: the body hangs
    });
    try {
      const pending = run("web_fetch", { url: `${hang.url}/hang` }, { ...baseScope, allowLoopback: hang.url });
      await reached;
      await vi.advanceTimersByTimeAsync(19_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: false, error: "request timed out after 20000 ms" });
    } finally {
      hang.server.closeAllConnections();
      await hang.close();
    }
  } finally {
    vi.useRealTimers();
  }
});

test("W9 send passes to, subject, text, the sendFrom inbox and idempotencyKey fabric:<callId>; returns messageId", async () => {
  const mail = fakeAgentMail("am-42");
  // The call id arrives in the port's io, the way tool.exec passes it (W11).
  const result = await run<{ messageId: string; idempotencyKey: string }>(
    "send",
    { to: "ty@example.com", subject: "Hello", text: "Body" },
    { ...baseScope, secret: key("agentmail"), agentmail: mail },
    { callId: "c7" }
  );

  expect(result).toEqual({ ok: true, result: { messageId: "am-42", idempotencyKey: "fabric:c7" } });
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
  const result = await run(
    "send",
    { to: "ty@example.com", subject: "s", text: "t" },
    { ...baseScope, secret: missing, agentmail: mail },
    { callId: "c8" }
  );

  expect(result).toEqual({ ok: false, error: "email sending is not configured (vault: agentmail)" });
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
