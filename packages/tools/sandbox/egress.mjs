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

/** The T18 private classes for IPv4 bytes: unspecified, loopback, private
 * (RFC 1918), CGNAT, link-local (incl. the metadata address). */
const isPrivateIPv4 = (bytes) => {
  const [a, b] = bytes;
  if (a === 0) return true; // unspecified
  if (a === 127 || a === 10) return true; // loopback, private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local (incl. metadata)
  return false;
};

/** Expand IPv6 text to 16 bytes, `::` compression per RFC 5952; null if
 * malformed. A zone suffix (%eth0) is dropped — never meaningful here. The
 * final group may be a dotted IPv4 (`::ffff:8.8.8.8`, RFC 4291 §2.2), which
 * dns.lookup and net.isIP both emit for IPv4-mapped literals. */
const parseIPv6 = (text) => {
  const s = text.includes("%") ? text.slice(0, text.indexOf("%")) : text;
  const groupsOf = (part) => {
    const groups = part === "" ? [] : part.split(":");
    const last = groups.at(-1) ?? "";
    if (net.isIPv4(last) && groups.length > 1) {
      const octets = last.split(".").map(Number);
      groups.splice(-1, 1, ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
    }
    return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) ? groups : null;
  };
  if (s.includes("::")) {
    if (s.indexOf("::") !== s.lastIndexOf("::")) return null;
    const [left, right] = s.split("::");
    if ((left !== "" && left.endsWith(":")) || (right !== undefined && right.startsWith(":"))) return null;
    const head = groupsOf(left);
    const tail = groupsOf(right ?? "");
    if (head === null || tail === null) return null;
    if (head.length + tail.length > 7) return null;
    const missing = 8 - head.length - tail.length;
    const groups = [...head, ...Array(missing).fill("0"), ...tail];
    return groups.flatMap((g) => [Number.parseInt(g, 16) >> 8, Number.parseInt(g, 16) & 0xff]);
  }
  const groups = groupsOf(s);
  if (groups === null || groups.length !== 8) return null;
  return groups.flatMap((g) => [Number.parseInt(g, 16) >> 8, Number.parseInt(g, 16) & 0xff]);
};

/** ::ffff:0:0/96 (mapped), ::/96 (compatible) and 64:ff9b::/96 (NAT64) all
 * carry an IPv4 in the last 32 bits — unwrap and apply the IPv4 classes. */
const ipv4Embedded = (bytes) => {
  const head = bytes.slice(0, 6);
  const nat64 = head[0] === 0 && head[1] === 0x64 && head[2] === 0xff && head[3] === 0x9b && head[4] === 0 && head[5] === 0;
  const mappedOrCompatible = head.every((b) => b === 0) && bytes[6] === 0;
  return mappedOrCompatible || nat64 ? bytes.slice(-4) : null;
};

/** The private-address classes of T18, IPv4 and IPv6, any text form. IPv4
 * embedded in IPv6 (mapped, compatible, NAT64) is unwrapped and checked as
 * IPv4, so `::ffff:10.0.0.1` and its hex form `::ffff:a00:1` classify alike.
 * Unparseable input fails closed. */
export function isPrivateAddress(ip) {
  if (typeof ip !== "string") return true;
  if (net.isIP(ip) === 4) return isPrivateIPv4(ip.split(".").map(Number));
  if (net.isIP(ip) === 6) {
    const bytes = parseIPv6(ip);
    if (bytes === null) return true;
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
    if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
    if (bytes.every((b) => b === 0)) return true; // ::/128 unspecified
    if (bytes[0] === 0 && bytes[1] === 0 && bytes.every((b, i) => i < 2 || b === (i === 15 ? 1 : 0))) return true; // ::1/128
    const embedded = ipv4Embedded(bytes);
    if (embedded !== null) return isPrivateIPv4(embedded);
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
  // Bracket-aware host:port — an IPv6 literal has colons of its own
  // (`[::ffff:127.0.0.1]:8080`), so a plain split cannot carry it.
  const match = /^(?:\[(.+)\]|([^:]+)):(\d+)$/.exec(req.url ?? "");
  const host = match?.[1] ?? match?.[2] ?? "";
  const port = match === null ? 80 : Number(match[3]);
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
