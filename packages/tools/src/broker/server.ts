// The broker HTTP server (ANY-44 T5, D3): listens on the given host only
// (default 127.0.0.1 — sandboxes reach it through their own network path),
// hands every request to the pipeline in broker.ts. No new dependencies;
// Node's http and fetch only.
import { createServer } from "node:http";
import type { BrokerDeps, BrokerServer } from "./broker";
import { handleBrokerRequest } from "./broker";
import type { CredentialRule } from "./rules";
import type { TokenStore } from "./tokens";
import type { Vault } from "../vault";

export type BrokerOptions = BrokerDeps & {
  /** Bind address; the broker must never bind wider than intended. */
  host?: string;
  port?: number;
};

export function startBroker(options: BrokerOptions): Promise<BrokerServer> {
  const { host = "127.0.0.1", port = 0, ...deps } = options;
  const server = createServer((req, res) => {
    void handleBrokerRequest(deps, req, res).catch((error: unknown) => {
      console.error("broker error handling", req.method, req.url, error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "broker error" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://${host}:${boundPort}`,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.closeAllConnections();
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

// Re-exported for the subpath entry: the types callers name.
export type { BrokerUseRecord } from "./broker";
export type { CredentialRule } from "./rules";
export type { TokenStore, TokenIdentity } from "./tokens";
export type { Vault } from "../vault";
