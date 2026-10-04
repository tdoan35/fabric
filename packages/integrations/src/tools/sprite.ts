// sprite.exec and workspace.write: the sandbox tools (§5.3 TOOLS 3). Terminal output streams as
// throttled tool.result events; the first line is the "$ <command>" echo the mock's terminal shows.
import { z } from "zod";
import type { StudioProfile, ToolPolicy } from "@fabric/contracts";
import { execInSprite, readSpriteFile, spriteFor, writeSpriteFile } from "../sprites";
import { makeTool } from "../tool-context";
import type { ToolCtx } from "../tool-context";

export function spriteExecTool(agent: StudioProfile, policy: ToolPolicy, ctx: ToolCtx) {
  const sprite = spriteFor(agent.agent.id);
  return makeTool(
    {
      name: "sprite.exec",
      description: "Run one bash command in your sandbox. The terminal streams as you go; you get the exit code and the last lines of output.",
      inputSchema: z.object({
        command: z.string().min(1).describe("The bash command line to run"),
        timeoutMs: z.number().int().positive().max(600_000).optional().describe("Optional wall-clock limit; the default is 120 s"),
      }),
      policy,
      summary: (i) => i.command.split("\n")[0].slice(0, 120),
      target: (i) => i.command.split("\n")[0].slice(0, 60),
      run: async (i, io) => {
        if (!sprite) throw new Error(`no sandbox attached to ${agent.agent.id}`);
        await io.term(`$ ${i.command}`);
        const res = await execInSprite(sprite, i.command, { onLine: (line) => io.term(line), timeoutMs: i.timeoutMs ?? 120_000 });
        for (const host of res.blockedHosts) await io.denied("network.fetch", host, "not on the egress list");
        return { exitCode: res.exitCode, tail: res.tail };
      },
    },
    ctx,
  );
}

export function workspaceWriteTool(agent: StudioProfile, policy: ToolPolicy, ctx: ToolCtx) {
  const sprite = spriteFor(agent.agent.id);
  return makeTool(
    {
      name: "workspace.write",
      description: "Write one file to your workspace (the sandbox's /root, or the run's artifacts when you have no sandbox).",
      inputSchema: z.object({
        path: z.string().min(1).describe("File name or relative path, e.g. plan.md"),
        content: z.string().describe("The full file contents"),
      }),
      policy,
      summary: (i) => `write ${i.path} (${i.content.length} chars)`,
      target: (i) => i.path,
      run: async (i, io) => {
        if (sprite) {
          await writeSpriteFile(sprite, i.path, i.content);
          await io.term(`wrote ${i.path} · ${i.content.length} chars`);
          return { path: i.path, bytes: i.content.length };
        }
        // No sandbox (e.g. the lead): the file becomes a run artifact, so it is still readable.
        const { id } = await ctx.writer.saveArtifact(ctx.runId, { name: i.path, by: ctx.actor, content: i.content });
        return { path: i.path, artifactId: id };
      },
    },
    ctx,
  );
}

/** File read helper for checks and TEAM: the same view workspace.write writes to. */
export function spriteFileReader(agentId: string): ((path: string) => Promise<string>) | undefined {
  const sprite = spriteFor(agentId);
  return sprite ? (path) => readSpriteFile(sprite, path) : undefined;
}
