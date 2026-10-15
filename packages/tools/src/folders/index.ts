// @fabric/tools/folders (ANY-44 T10): the FolderStore port and its local-disk
// backend, the workspace-scoped folder grants, and run-folder retention.
// Served through T1's subpath map; src/index.ts stays untouched.
export {
  assertFolderName,
  assertFolderRef,
  FOLDER_NAME_PATTERN,
  FolderNameError,
  type FolderKind,
  type FolderRef,
  type FolderStore,
} from "./folders";
export { localFolders } from "./local";
export {
  ensureFoldersSchema,
  folderGrants,
  type FolderAccess,
  type FolderGrant,
  type FolderGrants,
  type FolderMount,
} from "./grants";
export { RUN_FOLDER_RETENTION_MS, sweepRuns, type SweepOptions } from "./retention";
