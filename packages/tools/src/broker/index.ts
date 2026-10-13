// @fabric/tools/broker (ANY-44 T5): the credential broker — named egress
// endpoints, in-memory egress tokens, the fail-closed check pipeline, the
// HTTP server, and the scrubbing backstop. Served through T1's subpath map;
// src/index.ts and package.json stay untouched.
export { handleBrokerRequest, type BrokerDeps, type BrokerServer, type BrokerUseRecord } from "./broker";
export { normalizePath, pathAllowed, type CredentialAuth, type CredentialRule } from "./rules";
export { startBroker, type BrokerOptions } from "./server";
export { createTokenStore, type TokenIdentity, type TokenStore } from "./tokens";
export { makeScrubber, withScrubbing, type Scrubber } from "./scrub";
