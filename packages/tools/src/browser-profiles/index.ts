// @fabric/tools/browser-profiles (ANY-90 T12): one encrypted browser profile
// per user, the one-job lease, and load/save through a sandbox's archive
// seam. Served through T1's subpath map; src/index.ts stays untouched, exactly
// like ../folders and ../sandbox.
export {
  browserProfiles,
  ensureBrowserProfilesSchema,
  PROFILE_MAX_BYTES,
  type BrowserProfiles,
  type BrowserProfilesOptions,
  type BrowserProfileLease,
} from "./store";
