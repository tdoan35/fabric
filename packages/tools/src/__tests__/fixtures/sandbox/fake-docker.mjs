#!/usr/bin/env node
// A fake `docker` CLI for the sandbox tests that run without a daemon (the
// daemon-backed cases live in sandbox-docker.test.ts). State is one JSON file
// named by FABRIC_FAKE_DOCKER_STATE, rewritten atomically per invocation, so
// every provider call is observable: `run` records the full argv (flags,
// labels, mounts, env), `ps` filters on labels, `rm` drops containers, and
// `exec` runs the command argv as a real local process — the "container
// filesystem" is whatever directories the test mounts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const statePath = process.env.FABRIC_FAKE_DOCKER_STATE;
if (statePath === undefined || statePath === "") {
  console.error("fake-docker: set FABRIC_FAKE_DOCKER_STATE to a json file");
  process.exit(2);
}

const load = () => {
  if (!existsSync(statePath)) return { seq: 0, images: [], containers: [] };
  return JSON.parse(readFileSync(statePath, "utf8"));
};
const save = (state) => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

const [, , command, ...rest] = process.argv;

// Flags that take a value; every other `-x` is treated as boolean.
const VALUE_FLAGS = new Set([
  "--label", "-e", "--env", "-v", "-w", "--workdir", "--name", "--user",
  "--network", "--memory", "--cpus", "--pids-limit", "--security-opt",
  "--cap-drop", "--hostname", "--entrypoint", "--restart", "--platform",
  "--filter", "--format",
]);

function parse(argv) {
  const flags = [];
  const positionals = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (VALUE_FLAGS.has(arg)) {
      flags.push([arg, argv[index + 1]]);
      index += 2;
    } else if (arg.startsWith("-") && arg !== "-") {
      flags.push([arg, undefined]);
      index += 1;
    } else {
      break;
    }
  }
  return { flags, positionals: argv.slice(index) };
}

const state = load();

switch (command) {
  case "info":
  case "version": {
    console.log("fake docker");
    break;
  }

  case "image": {
    // image inspect <ref>: exit 0 only for seeded images.
    if (rest[0] !== "inspect") {
      console.error(`fake-docker: image ${rest[0] ?? "?"} unsupported`);
      process.exit(2);
    }
    if (state.images.includes(rest[1])) {
      console.log(rest[1]);
    } else {
      console.error(`fake-docker: image ${rest[1]} not found`);
      process.exit(1);
    }
    break;
  }

  case "run": {
    const { flags, positionals } = parse(rest);
    const labels = {};
    for (const [flag, value] of flags) {
      if ((flag === "--label") && value !== undefined) {
        const at = value.indexOf("=");
        labels[value.slice(0, at)] = value.slice(at + 1);
      }
    }
    const id = `c${String(state.seq + 1).padStart(3, "0")}`;
    state.seq += 1;
    state.containers.push({ id, labels, argv: ["run", ...rest] });
    save(state);
    console.log(id);
    break;
  }

  case "ps": {
    const wanted = [];
    for (let index = 0; index < rest.length; index++) {
      if (rest[index] === "--filter") {
        const filter = rest[index + 1];
        if (filter.startsWith("label=")) wanted.push(filter.slice("label=".length));
        index += 1;
      }
    }
    const matching = state.containers.filter((container) =>
      wanted.every((label) => {
        const at = label.indexOf("=");
        if (at < 0) return container.labels[label] !== undefined;
        return container.labels[label.slice(0, at)] === label.slice(at + 1);
      })
    );
    for (const container of matching) console.log(container.id);
    break;
  }

  case "rm": {
    const ids = rest.filter((id) => !id.startsWith("-"));
    const gone = new Set(ids);
    state.containers = state.containers.filter((c) => !gone.has(c.id));
    save(state);
    break;
  }

  case "exec": {
    const envAdd = {};
    let cwd;
    let index = 0;
    while (index < rest.length) {
      const arg = rest[index];
      if (arg === "-i" || arg === "-d" || arg === "-t") {
        index += 1;
      } else if (arg === "-w" || arg === "--workdir") {
        cwd = rest[index + 1];
        index += 2;
      } else if (arg === "-e" || arg === "--env") {
        const pair = rest[index + 1];
        const at = pair.indexOf("=");
        envAdd[pair.slice(0, at)] = pair.slice(at + 1);
        index += 2;
      } else {
        break;
      }
    }
    const id = rest[index];
    const container = state.containers.find((c) => c.id === id);
    if (container === undefined) {
      console.error(`fake-docker: no such container ${id}`);
      process.exit(1);
    }
    const argv = rest.slice(index + 1);
    const result = spawnSync(argv[0], argv.slice(1), {
      stdio: "inherit",
      cwd: cwd ?? undefined,
      env: { ...process.env, ...envAdd },
    });
    process.exit(result.status ?? 128 + (result.signal ? 2 : 0));
  }

  default: {
    console.error(`fake-docker: unsupported command ${command}`);
    process.exit(2);
  }
}
