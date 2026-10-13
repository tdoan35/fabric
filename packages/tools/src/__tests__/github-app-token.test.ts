// ANY-44 T11 — the GitHub App token path (GH1, GH2). A fake GitHub on
// 127.0.0.1 serves POST /app/installations/{id}/access_tokens and records
// every request; the private key is generated at runtime and lives only in
// the vault. No network.
import { createPublicKey, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { memoryVault } from "../vault";
import { createAppTokenManager } from "../broker/github";

const APP_ID = 1048576;
const INSTALLATION_ID = 77;
const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// The fake's responses and the manager share this clock so token expiry is
// controllable without waiting.
let clock = 1_700_000_000_000;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN = "ghs_fake_installation_token";

type TokenCall = { authorization: string; body: unknown };
const tokenCalls: TokenCall[] = [];

const api = createServer((req, res) => {
  if (req.method === "POST" && req.url === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      tokenCalls.push({ authorization: req.headers.authorization ?? "", body });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: TOKEN, expires_at: new Date(clock + TOKEN_TTL_MS).toISOString() }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
});
afterAll(async () => {
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

const apiUrl = () => `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

function base64UrlDecode(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

test("GH1 the installation request is a correctly signed RS256 JWT with iss and bounded iat/exp", async () => {
  const vault = memoryVault();
  await vault.put("gh_app_key", KEY.privateKey, { agents: "all" });
  const manager = createAppTokenManager({
    auth: {
      type: "github-app",
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeySecret: "gh_app_key",
      repos: ["o/r"],
      apiUrl: apiUrl(),
    },
    vault,
    now: () => clock,
  });

  const before = tokenCalls.length;
  const token = await manager.getToken();
  expect(token).toBe(TOKEN);
  expect(tokenCalls).toHaveLength(before + 1);

  const authorization = tokenCalls[tokenCalls.length - 1].authorization;
  expect(authorization.startsWith("Bearer ")).toBe(true);
  const jwt = authorization.slice("Bearer ".length);
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  expect([headerPart, payloadPart, signaturePart].every((part) => part.length > 0)).toBe(true);

  const header = JSON.parse(base64UrlDecode(headerPart).toString("utf8"));
  const payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));

  // The signature verifies with the test public key (RS256).
  expect(header.alg).toBe("RS256");
  const signatureValid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
    createPublicKey(KEY.publicKey),
    base64UrlDecode(signaturePart)
  );
  expect(signatureValid).toBe(true);

  // Claims: iss is the app id, iat is now-60s, exp is iat+9min.
  expect(String(payload.iss)).toBe(String(APP_ID));
  expect(payload.iat).toBe(clock / 1000 - 60);
  expect(payload.exp - payload.iat).toBe(9 * 60);
});

test("GH2 the token request scopes repos and permissions, caches per installation, re-mints near expiry", async () => {
  const vault = memoryVault();
  await vault.put("gh_app_key", KEY.privateKey, { agents: "all" });
  const manager = createAppTokenManager({
    auth: {
      type: "github-app",
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeySecret: "gh_app_key",
      repos: ["o/r", "other/repo2"],
      apiUrl: apiUrl(),
    },
    vault,
    now: () => clock,
  });

  const before = tokenCalls.length;
  await manager.getToken();
  await manager.getToken(); // within the token's life: served from cache
  expect(tokenCalls).toHaveLength(before + 1);

  const body = tokenCalls[tokenCalls.length - 1].body as {
    repositories: string[];
    permissions: Record<string, string>;
  };
  expect(body.repositories).toEqual(["r", "repo2"]); // names only, in rule order
  expect(body.permissions).toEqual({ contents: "write", pull_requests: "write", metadata: "read" });

  // expires_at was clock + 60min; at expiry minus 5 minutes the cache is stale.
  clock += 55 * 60 * 1000 + 1000;
  await manager.getToken();
  expect(tokenCalls).toHaveLength(before + 2);
});
