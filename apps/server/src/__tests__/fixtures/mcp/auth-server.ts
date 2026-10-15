// A fake OAuth 2.1 authorization server for the ANY-85 (M7) route tests, on
// node:http at 127.0.0.1: RFC 8414 / OIDC discovery, RFC 7591 registration,
// the token endpoint (authorization_code with PKCE S256 and RFC 8707
// resource, refresh_token with rotation) and RFC 7009 revocation. The user's
// consent is `approve(authorizeUrl)`, which returns the code a browser
// redirect would carry. Every request is logged, and every secret it hands
// out or receives is kept in `issued()` so the hygiene test (Z10) can scan
// for it. The ANY-78 package tests run the same protocol in
// packages/tools/src/__tests__/fixtures/mcp/auth-server.ts; this is the
// server-side twin, kept local because the app does not export test
// fixtures from its packages.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type AuthRequest = {
  method: string;
  path: string;
  params: Record<string, string>;
  authorization?: string;
};

export type FakeAuthServer = {
  issuer: string;
  /** The user approves the authorize URL; returns the authorization code. */
  approve(authorizeUrl: string): string;
  log(): AuthRequest[];
  count(path: string): number;
  /** For the protected MCP server: a live access token as `Bearer <token>`. */
  accepts(authorization: string | undefined): boolean;
  /** Invalidates every access token server-side (refresh tokens stay good). */
  expireAccessTokens(): void;
  /** Makes the token endpoint answer this OAuth error (undefined: back to normal). */
  failToken(error: string | undefined): void;
  /** Every access token, refresh token, client secret and code verifier seen. */
  issued(): string[];
  close(): Promise<void>;
};

const secret = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export async function startFakeAuthServer(
  options: {
    registration?: boolean;
    revocation?: boolean;
    /** false: advertises only `plain` PKCE. */
    s256?: boolean;
    /** false: 404 on oauth-authorization-server, so openid-configuration is used. */
    oauthMetadata?: boolean;
    /** expires_in for tokens from a code, and from a refresh (seconds). */
    lifetimes?: { code?: number; refresh?: number };
  } = {}
): Promise<FakeAuthServer> {
  const log: AuthRequest[] = [];
  const issued = new Set<string>();
  const codes = new Map<
    string,
    { challenge: string; clientId: string; redirectUri: string; resource: string | undefined }
  >();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, { clientId: string; resource: string | undefined }>();
  let tokenError: string | undefined;
  let issuer = "";

  function metadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      ...(options.registration === false ? {} : { registration_endpoint: `${issuer}/register` }),
      ...(options.revocation === false ? {} : { revocation_endpoint: `${issuer}/revoke` }),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: options.s256 === false ? ["plain"] : ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    };
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  function tokens(res: ServerResponse, clientId: string, resource: string | undefined, lifetime: number) {
    const access = secret("at");
    const refresh = secret("rt");
    issued.add(access);
    issued.add(refresh);
    accessTokens.add(access);
    refreshTokens.set(refresh, { clientId, resource });
    json(res, 200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: lifetime,
      refresh_token: refresh,
    });
  }

  /** client_id from the form, or from HTTP Basic. */
  function clientOf(params: Record<string, string>, authorization: string | undefined): string | undefined {
    if (params.client_id !== undefined) return params.client_id;
    if (authorization?.startsWith("Basic ")) {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      return decodeURIComponent(decoded.slice(0, decoded.indexOf(":")));
    }
    return undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const path = new URL(req.url ?? "/", issuer).pathname;
    const params: Record<string, string> = {};
    if (body !== "") {
      if ((req.headers["content-type"] ?? "").includes("application/json")) {
        for (const [key, value] of Object.entries(JSON.parse(body) as Record<string, unknown>)) {
          params[key] = typeof value === "string" ? value : JSON.stringify(value);
        }
      } else {
        for (const [key, value] of new URLSearchParams(body)) params[key] = value;
      }
    }
    const authorization = req.headers.authorization;
    log.push({ method: req.method ?? "GET", path, params, ...(authorization ? { authorization } : {}) });
    if (params.code_verifier !== undefined) issued.add(params.code_verifier);
    if (params.client_secret !== undefined) issued.add(params.client_secret);

    if (path === "/.well-known/oauth-authorization-server" && options.oauthMetadata !== false) {
      return json(res, 200, metadata());
    }
    if (path === "/.well-known/openid-configuration") {
      return json(res, 200, {
        ...metadata(),
        jwks_uri: `${issuer}/jwks`,
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (path === "/register" && options.registration !== false && req.method === "POST") {
      const registered = JSON.parse(body) as Record<string, unknown>;
      const clientSecret = secret("cs");
      issued.add(clientSecret);
      return json(res, 201, {
        ...registered,
        client_id: secret("client"),
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
      });
    }
    if (path === "/token" && req.method === "POST") {
      if (tokenError !== undefined) return json(res, 400, { error: tokenError });
      const clientId = clientOf(params, authorization);
      if (params.grant_type === "authorization_code") {
        const grant = codes.get(params.code ?? "");
        codes.delete(params.code ?? "");
        if (
          grant === undefined ||
          grant.clientId !== clientId ||
          grant.redirectUri !== params.redirect_uri ||
          grant.resource !== params.resource ||
          s256(params.code_verifier ?? "") !== grant.challenge
        ) {
          return json(res, 400, { error: "invalid_grant" });
        }
        return tokens(res, grant.clientId, grant.resource, options.lifetimes?.code ?? 3600);
      }
      if (params.grant_type === "refresh_token") {
        const grant = refreshTokens.get(params.refresh_token ?? "");
        if (grant === undefined || grant.clientId !== clientId) return json(res, 400, { error: "invalid_grant" });
        refreshTokens.delete(params.refresh_token ?? ""); // rotation: single use
        return tokens(res, grant.clientId, grant.resource, options.lifetimes?.refresh ?? 3600);
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (path === "/revoke" && options.revocation !== false && req.method === "POST") {
      accessTokens.delete(params.token ?? "");
      refreshTokens.delete(params.token ?? "");
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  return {
    issuer,
    approve(authorizeUrl) {
      const url = new URL(authorizeUrl);
      const param = (name: string) => {
        const value = url.searchParams.get(name);
        if (value === null) throw new Error(`authorize URL has no ${name}`);
        return value;
      };
      if (param("response_type") !== "code" || param("code_challenge_method") !== "S256") {
        throw new Error("authorize URL is not an S256 code request");
      }
      const code = secret("code");
      codes.set(code, {
        challenge: param("code_challenge"),
        clientId: param("client_id"),
        redirectUri: param("redirect_uri"),
        resource: url.searchParams.get("resource") ?? undefined,
      });
      return code;
    },
    log: () => [...log],
    count: (path) => log.filter((entry) => entry.path === path).length,
    accepts(authorization) {
      return authorization?.startsWith("Bearer ") === true && accessTokens.has(authorization.slice(7));
    },
    expireAccessTokens() {
      accessTokens.clear();
    },
    failToken(error) {
      tokenError = error;
    },
    issued: () => [...issued],
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
