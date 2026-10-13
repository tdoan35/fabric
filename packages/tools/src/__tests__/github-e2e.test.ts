// ANY-44 T11 — end to end with real git (GH12). A bare repo served by
// `git http-backend` (spawned as a CGI per request) sits behind the broker;
// git itself talks to the broker URL with the egress token as URL userinfo
// (basic auth, the password-token form). The fake API serves only the
// installation token. No network.
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
        paths: ["/o/r.git/**"],
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
  const token = tokens.issue({ workspaceId: "ws", agentId: "dana", ttlMs: 600_000 });
  // URL userinfo becomes basic auth — the password-token form git can use.
  return `${broker.url.replace("http://", `http://x-access-token:${token}@`)}/egress/git/o/r.git`;
}

test(
  "GH12 real git: clone through the broker, push fabric/e2e lands, push to main is refused",
  { timeout: 120_000 },
  async () => {
    cloneDir = await mkdtemp(join(tmpdir(), "gh-clone-"));
    const url = repoUrl();

    await run("git", ["clone", url, cloneDir], { env: GIT_ENV });

    await writeFile(join(cloneDir, "note.txt"), "fabric e2e\n", "utf8");
    await run("git", ["add", "note.txt"], { cwd: cloneDir, env: GIT_ENV });
    await run(
      "git",
      ["-c", "user.email=agent@fabric", "-c", "user.name=fabric-agent", "commit", "-m", "e2e commit"],
      { cwd: cloneDir, env: GIT_ENV }
    );
    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], { cwd: cloneDir, env: GIT_ENV });

    await run("git", ["push", url, `HEAD:refs/heads/fabric/e2e`], { cwd: cloneDir, env: GIT_ENV });
    const { stdout: landed } = await run("git", ["--git-dir", join(root, "o/r.git"), "rev-parse", "refs/heads/fabric/e2e"]);
    expect(landed.trim()).toBe(head.trim());

    // pushing to main is refused by the broker policy, not by git
    const pushMain = await run("git", ["push", url, "HEAD:refs/heads/main"], {
      cwd: cloneDir,
      env: GIT_ENV,
    }).catch((error: { code?: number; stderr?: string }) => error);
    expect(pushMain.code).not.toBe(0);
    expect(pushMain.stderr).toContain("403");

    const mainMissing = await run("git", ["--git-dir", join(root, "o/r.git"), "rev-parse", "--verify", "refs/heads/main"]).then(
      () => false,
      () => true
    );
    expect(mainMissing).toBe(true); // bare repo's main is unchanged: still absent

    // the installation token was minted through the app path
    expect(apiReceived.some((request) => request.url === "/app/installations/77/access_tokens")).toBe(true);
  }
);
