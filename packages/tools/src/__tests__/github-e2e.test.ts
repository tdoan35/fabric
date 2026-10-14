// ANY-44 T11 — end to end with real git (GH12). A bare repo served by
// `git http-backend` (spawned as a CGI per request) sits behind the broker;
// git itself talks to the broker URL with the egress token as URL userinfo
// (basic auth, the password-token form). The fake API serves only the
// installation token. The bare repo denies non-fast-forwards and deletes,
// standing in for the GitHub ruleset on refs/heads/fabric/**. No network.
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { memoryVault } from "../vault";
import { createTokenStore, startBroker, type BrokerServer } from "../broker";

const run = promisify(execFile);
const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: "/tmp" };

let root = "";
let cloneDir = "";
const apiReceived: { method: string; url: string }[] = [];

const api = createServer(async (req, res) => {
  apiReceived.push({ method: req.method ?? "", url: req.url ?? "" });
  if (req.method === "POST" && req.url === "/app/installations/77/access_tokens") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    void Buffer.concat(chunks);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: "ghs_e2e_token", expires_at: new Date(Date.now() + 3600_000).toISOString() }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ahead" }));
});

// `git http-backend` as a CGI: one child process per request, the body
// buffered and passed on stdin, the CGI response split into status/headers.
function serveGit(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const headerEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headerEnv[`HTTP_${name.replace(/-/g, "_").toUpperCase()}`] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        ...headerEnv,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(body);

    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", (error) => {
      res.writeHead(500);
      res.end(String(error));
    });
    child.on("close", () => {
      const all = Buffer.concat(output);
      const split = all.indexOf("\r\n\r\n");
      const headerBlock = (split === -1 ? all : all.subarray(0, split)).toString("utf8");
      const headerLines = headerBlock.split("\r\n");
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (!match) continue;
        if (match[1].toLowerCase() === "status") status = Number.parseInt(match[2], 10) || 200;
        else headers[match[1].toLowerCase()] = match[2];
      }
      // http-backend speaks CGI; the client speaks chunked — never pass a
      // stale content-length through, let the server frame the body.
      delete headers["content-length"];
      res.writeHead(status, headers);
      res.end(split === -1 ? undefined : all.subarray(split + 4));
    });
  });
}

const gitUpstream = createServer(serveGit);

let broker: BrokerServer;
const tokens = createTokenStore();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gh-e2e-"));
  await run("git", ["init", "--bare", "-b", "main", join(root, "o/r.git")], { env: GIT_ENV });
  // anonymous pushes need this on the fixture, or http-backend refuses receive-pack
  await run("git", ["--git-dir", join(root, "o/r.git"), "config", "http.receivepack", "true"], { env: GIT_ENV });
  // the ruleset's job upstream: no force pushes, no deletions
  await run("git", ["--git-dir", join(root, "o/r.git"), "config", "receive.denyNonFastForwards", "true"], { env: GIT_ENV });
  await run("git", ["--git-dir", join(root, "o/r.git"), "config", "receive.denyDeletes", "true"], { env: GIT_ENV });
  await Promise.all([
    new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => gitUpstream.listen(0, "127.0.0.1", resolve)),
  ]);
});
afterAll(async () => {
  for (const server of [gitUpstream, api]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
  await rm(cloneDir, { recursive: true, force: true });
});

beforeEach(async () => {
  apiReceived.length = 0;
  const vault = memoryVault();
  await vault.put("gh_app_key", KEY.privateKey, { agents: "all" });
  broker = await startBroker({
    vault,
    tokens,
    rules: [
      {
        name: "git",
        surface: "git",
        upstream: `http://127.0.0.1:${(gitUpstream.address() as AddressInfo).port}`,
        auth: {
          type: "github-app",
          appId: 1,
          installationId: 77,
          privateKeySecret: "gh_app_key",
          repos: ["o/r"],
          apiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
        },
        methods: ["GET", "POST"],
        paths: ["/o/r.git/**", "/o/other.git/**"],
        agents: "all",
      },
    ],
    onUse: () => {},
  });
});
afterEach(async () => {
  await broker.close();
});

function repoUrl(): string {
  return `${broker.url}/egress/git/o/r.git`;
}

/** git probes unauthenticated and retries only after a 401 challenge; the
 * broker answers 403 (its contract), so the credential rides along on
 * every request instead — the x-access-token basic form, password token. */
function gitAuth(): string[] {
  const token = tokens.issue({ workspaceId: "ws", agentId: "dana", ttlMs: 600_000 });
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

type GitResult = { code?: number; stdout?: string; stderr?: string };

/** Runs git and returns its outcome instead of throwing on a non-zero exit. */
function attempt(args: string[], cwd?: string): Promise<GitResult> {
  return run("git", args, { cwd, env: GIT_ENV }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: unknown) => error as GitResult
  );
}

async function bareRef(ref: string): Promise<string | null> {
  const result = await attempt(["--git-dir", join(root, "o/r.git"), "rev-parse", "--verify", ref]);
  return result.code === 0 ? (result.stdout ?? "").trim() : null;
}

async function commit(message: string, extra: string[] = []): Promise<string> {
  await writeFile(join(cloneDir, "note.txt"), `${message}\n`, "utf8");
  await run("git", ["add", "note.txt"], { cwd: cloneDir, env: GIT_ENV });
  await run(
    "git",
    ["-c", "user.email=agent@fabric", "-c", "user.name=fabric-agent", "commit", ...extra, "-m", message],
    { cwd: cloneDir, env: GIT_ENV }
  );
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: cloneDir, env: GIT_ENV });
  return stdout.trim();
}

test(
  "GH12 real git: clone, create and update fabric/e2e land; main, deletes and force pushes are refused with reasons",
  { timeout: 120_000 },
  async () => {
    cloneDir = await mkdtemp(join(tmpdir(), "gh-clone-"));
    const url = repoUrl();
    const auth = gitAuth();

    await run("git", [...auth, "clone", url, cloneDir], { env: GIT_ENV });

    // create, then update (a fast-forward with a non-zero old)
    const first = await commit("e2e commit");
    await run("git", [...auth, "push", url, "HEAD:refs/heads/fabric/e2e"], { cwd: cloneDir, env: GIT_ENV });
    expect(await bareRef("refs/heads/fabric/e2e")).toBe(first);
    const second = await commit("e2e update");
    await run("git", [...auth, "push", url, "HEAD:refs/heads/fabric/e2e"], { cwd: cloneDir, env: GIT_ENV });
    expect(await bareRef("refs/heads/fabric/e2e")).toBe(second);

    // pushing to main is refused by the broker policy, and git says why
    const pushMain = await attempt([...auth, "push", url, "HEAD:refs/heads/main"], cloneDir);
    expect(pushMain.code).not.toBe(0);
    expect(pushMain.stderr).toContain("[remote rejected]");
    expect(pushMain.stderr).toContain("pushes must stay under refs/heads/fabric/");
    expect(await bareRef("refs/heads/main")).toBeNull(); // bare repo's main is unchanged: still absent

    // a delete is refused by the broker, the branch survives
    const remove = await attempt([...auth, "push", url, ":refs/heads/fabric/e2e"], cloneDir);
    expect(remove.code).not.toBe(0);
    expect(remove.stderr).toContain("ref deletion is not allowed");
    expect(await bareRef("refs/heads/fabric/e2e")).toBe(second);

    // a force push passes the broker and is refused upstream (the ruleset)
    await commit("e2e rewritten", ["--amend"]);
    const force = await attempt([...auth, "push", "--force", url, "HEAD:refs/heads/fabric/e2e"], cloneDir);
    expect(force.code).not.toBe(0);
    expect(force.stderr).toContain("non-fast-forward");
    expect(await bareRef("refs/heads/fabric/e2e")).toBe(second);

    // a repo outside `repos`: git prints the broker's plain-text reason
    const detached = await attempt([...auth, "clone", repoUrl().replace("/o/r.git", "/o/other.git"), `${cloneDir}-other`]);
    expect(detached.code).not.toBe(0);
    expect(detached.stderr).toContain("repo not attached to this installation: o/other");

    // the installation token was minted through the app path
    expect(apiReceived.some((request) => request.url === "/app/installations/77/access_tokens")).toBe(true);
  }
);
