// The sandbox image coordinate (T8): overridable for a local rebuild or a
// CI mirror; the default is what `npm run sandbox:build -w @fabric/tools`
// produces from sandbox/Dockerfile.
export const SANDBOX_IMAGE = process.env.FABRIC_SANDBOX_IMAGE ?? "fabric-sandbox:1";
