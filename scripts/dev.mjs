// npm run dev: the server and the web dev server together, with prefixed output. Ctrl-C stops both.
// Ports come from the shell or the root .env (PORT, VITE_PORT).
import { spawn } from "node:child_process";

const procs = [
  ["server", "\x1b[35m", ["run", "dev", "-w", "@fabric/server"]],
  ["web   ", "\x1b[36m", ["run", "dev", "-w", "web"]],
].map(([name, color, args]) => {
  const p = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const out = (stream) => (chunk) => {
    for (const line of chunk.toString().split("\n")) if (line) stream.write(`${color}${name}\x1b[0m │ ${line}\n`);
  };
  p.stdout.on("data", out(process.stdout));
  p.stderr.on("data", out(process.stderr));
  p.on("exit", (code) => { console.log(`${name.trim()} exited (${code})`); stop(code ?? 0); });
  return p;
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
