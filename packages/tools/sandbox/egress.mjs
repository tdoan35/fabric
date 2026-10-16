// The sandbox egress gateway (ANY-44 T18), running inside the gateway
// container as `node /opt/fabric/egress.mjs`. Two listeners:
//
//  - :3128 an HTTP proxy (CONNECT host:port and absolute-URI requests). The
//    destination is resolved first; if ANY resolved address is loopback,
//    private (RFC 1918), CGNAT, link-local (incl. the metadata address),
//    unique-local, link-local IPv6 or unspecified, the request is refused
//    403 {"error":"egress: private address"} — one log line, never the body.
//    Otherwise the connection goes to the address that was checked, never
//    re-resolving, so a DNS rebinding cannot change the target.
//  :80   the broker route: any plain HTTP request is forwarded to the Fabric
//    broker (FABRIC_BROKER_HOST:FABRIC_BROKER_PORT, default the gateway's
//    own host.docker.internal), path and headers intact, so the broker's
//    named endpoints work from inside the sandbox.
//
// No dependencies; Node's http/net/dns only. The ports are fixed in the
// container and overridable (ephemeral) for the daemon-free tests.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { pathToFileURL } from "node:url";

const PROXY_PORT = Number(process.env.FABRIC_EGRESS_PROXY_PORT ?? 3128);
const HTTP_PORT = Number(process.env.FABRIC_EGRESS_HTTP_PORT ?? 80);
const BROKER_HOST = process.env.FABRIC_BROKER_HOST ?? "host.docker.internal";
const BROKER_PORT = Number(process.env.FABRIC_BROKER_PORT ?? 0);

/** The private-address classes of T18, for IPv4 and IPv6 text form. */
export function isPrivateAddress(ip) {
  if (typeof ip !== "string") return true;
  const s = ip.toLowerCase().replace(/^::ffff:/, "");
  if (s === "::" || s === "::1") return true; // unspecified, loopback
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // unspecified
    if (a === 127 || a === 10) return true; // loopback, private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local (incl. metadata)
    return false;
  }
  if (s.includes(":")) {
    if (s.startsWith("fc") || s.startsWith("fd")) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link-local
    return false;
  }
  return true; // unparseable: fail closed
}

const refuse = (res, reason, agent, destination) => {
  console.log(`[egress] refuse ${destination} ${reason} agent=${agent}`);
  if (res.socket === undefined) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "egress: private address" }));
  } else {
    // CONNECT: no ServerResponse yet — answer on the raw socket.
    res.socket.write(
      "HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n\r\n" +
        JSON.stringify({ error: "egress: private address" })
    );
    res.socket.end();
  }
};

/** Resolve `host`; refuse unless every address is public. Returns the checked
 * address to dial — never the name — so rebinding cannot change the target. */
async function resolvePublic(host) {
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: "cannot resolve host" };
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) return { ok: false, reason: "private address", address };
  }
  if (addresses.length === 0) return { ok: false, reason: "no addresses" };
  return { ok: true, address: addresses[0].address };
}

const agentOf = (headers) => {
  const agent = headers["x-fabric-agent"];
  return typeof agent === "string" && agent !== "" ? JSON.stringify(agent) : "-";
};

// -- the proxy (:3128) -----------------------------------------------------------

const proxy = http.createServer((req, res) => {
  // Absolute-URI form. (Origin-form on a proxy port has no single target.)
  let url;
  try {
    url = new URL(req.url ?? "");
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "egress: send an absolute-URI request or CONNECT" }));
    return;
  }
  const agent = agentOf(req.headers);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port === "" ? 80 : Number(url.port);

  resolvePublic(hostname).then((resolved) => {
    if (!resolved.ok) {
      if (resolved.reason === "private address") refuse(res, "private address", agent, `${hostname}:${port}`);
      else {
        console.log(`[egress] refuse ${hostname}:${port} ${resolved.reason} agent=${agent}`);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `egress: ${resolved.reason}` }));
      }
      return;
    }
    // host header stays the requested name (vhosts); dial the checked address.
    const headers = { ...req.headers, host: url.host };
    const upstream = http.request({ host: resolved.address, port, path: url.pathname + url.search, method: req.method, headers });
    upstream.on("response", (upstreamRes) => {
      const responseHeaders = {};
      upstreamRes.rawHeaders.forEach((value, index) => {
        if (index % 2 === 0) responseHeaders[value.toLowerCase()] = upstreamRes.rawHeaders[index + 1];
      });
      delete responseHeaders["transfer-encoding"];
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "egress: upstream unreachable" }));
      }
    });
    req.pipe(upstream);
  });
});

// CONNECT: tunnel to the checked address.
proxy.on("connect", (req, socket, head) => {
  const [rawHost, rawPort] = (req.url ?? "").split(":");
  const port = Number(rawPort ?? 80);
  const host = (rawHost ?? "").replace(/^\[|\]$/g, "");
  const agent = agentOf(req.headers);
  if (host === "" || !Number.isFinite(port)) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.end();
    return;
  }
  resolvePublic(host).then((resolved) => {
    if (!resolved.ok) {
      if (resolved.reason === "private address") refuse({ socket }, "private address", agent, `${host}:${port}`);
      else {
        console.log(`[egress] refuse ${host}:${port} ${resolved.reason} agent=${agent}`);
        socket.write(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ error: `egress: ${resolved.reason}` })}`);
        socket.end();
      }
      return;
    }
    const upstream = net.connect({ host: resolved.address, port }, () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const tearDown = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", tearDown);
    upstream.on("error", tearDown);
    socket.on("close", tearDown);
  });
});

// -- the broker route (:80) --------------------------------------------------------

const brokerRoute = http.createServer((req, res) => {
  if (BROKER_PORT === 0) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "egress: no broker configured" }));
    return;
  }
  // Origin-form is the normal case; tolerate an absolute URI too.
  let path = req.url ?? "/";
  if (path.startsWith("http://") || path.startsWith("https://")) {
    try {
      const parsed = new URL(path);
      path = parsed.pathname + parsed.search;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "egress: bad request path" }));
      return;
    }
  }
  const headers = { ...req.headers, host: `${BROKER_HOST}:${BROKER_PORT}` };
  const upstream = http.request({
    host: BROKER_HOST,
    port: BROKER_PORT,
    path,
    method: req.method,
    headers,
  });
  upstream.on("response", (upstreamRes) => {
    const responseHeaders = {};
    upstreamRes.rawHeaders.forEach((value, index) => {
      if (index % 2 === 0) responseHeaders[value.toLowerCase()] = upstreamRes.rawHeaders[index + 1];
    });
    delete responseHeaders["transfer-encoding"];
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "egress: broker unreachable" }));
    }
  });
  req.pipe(upstream);
});

/** Start both listeners; exported for the daemon-free tests. */
export function startEgress({ proxyPort = PROXY_PORT, httpPort = HTTP_PORT, brokerHost = BROKER_HOST, brokerPort = BROKER_PORT } = {}) {
  return new Promise((resolve, reject) => {
    proxy.on("error", reject);
    brokerRoute.on("error", reject);
    proxy.listen(proxyPort, "0.0.0.0", () => {
      brokerRoute.listen(httpPort, "0.0.0.0", () => {
        const bound = { proxy: proxy.address().port, http: brokerRoute.address().port };
        console.log(`[egress] listening proxy=:${bound.proxy} http=:${bound.http} broker=${brokerHost}:${brokerPort}`);
        resolve({
          ...bound,
          close: () =>
            Promise.all([
              new Promise((done) => proxy.close(() => done(null))),
              new Promise((done) => {
                brokerRoute.closeAllConnections();
                brokerRoute.close(() => done(null));
              }),
            ]),
        });
      });
    });
  });
}

// Run as the entrypoint (the container's CMD); imported as a module, no listener.
const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  await startEgress();
}
