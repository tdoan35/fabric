#!/usr/bin/env node
// npm run smoke — the demo path, end to end, on the demo branch (WORK-PLAN §5.3 OPS step 2).
// check:team's first two phases: fixture Dana's idea → two approvals → handoff → the real live start
// (≥3 members working by 45 s, Exa and terminal lines, snapshots) → splice at ~45 s → finalize →
// the report, Dana's results message and the accepted loop. Starts its own server; reseeds demo
// before and after. ~2 min on an idle Spark lane. Never run it during a rehearsal: one run at a time.
import { spawnSync } from "node:child_process";

const r = spawnSync("npm", ["run", "check:team", "--", "--skip-toy", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
