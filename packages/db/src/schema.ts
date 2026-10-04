// Drizzle schema for WORK-PLAN §4.7. Tables live in `public`; Mastra gets its own schema later.
// Read models (read.ts) project these rows into the frozen @fabric/contracts shapes.
import type {
  AgentWorkspace, Brief, CalendarEvent, ChatAgent, ContextSection, InboxItem, PulseEntry, Presence, Project, Task,
  Report, RunEventPayloads, RunEventType, RunSegment, SpriteAvatar, ToolPolicy, WorkflowStage,
} from "@fabric/contracts";
import { pgTable, text, integer, boolean, numeric, jsonb, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---- Registry: agents, teams, orgs ----

export type AgentToolRow = { name: string; note: string; policy: ToolPolicy };

/** One persona row = one StudioProfile (ChatAgent fields + workspace). */
export const agents = pgTable("agents", {
  id: text("id").primaryKey(), // persona slug: dana, jonah, …
  ord: integer("ord").notNull().default(0), // registry display order
  name: text("name").notNull(),
  role: text("role").notNull(),
  tagline: text("tagline").notNull().default(""),
  summary: text("summary").notNull().default(""),
  personality: text("personality").notNull().default(""),
  traits: jsonb("traits").$type<string[]>().notNull().default([]),
  tone: text("tone").notNull().default(""),
  avatar: jsonb("avatar").$type<SpriteAvatar | null>(),
  model: text("model").notNull().default(""),
  contextTokens: integer("context_tokens").notNull().default(0),
  memory: jsonb("memory").$type<{ label: string; value: string }[]>().notNull().default([]),
  tools: jsonb("tools").$type<AgentToolRow[]>().notNull().default([]),
  greeting: text("greeting").notNull().default(""),
  placeholder: text("placeholder").notNull().default(""),
  suggestions: jsonb("suggestions").$type<ChatAgent["suggestions"]>(),
  workspace: jsonb("workspace").$type<AgentWorkspace>().notNull(),
  origin: text("origin"),
  author: text("author"), // set on community profiles
  installs: integer("installs"),
  community: boolean("community").notNull().default(false),
  status: text("status").notNull().default("active"), // registry serves active only
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agentMemories = pgTable("agent_memories", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  text: text("text").notNull(),
  source: text("source").notNull(),
  when: text("when").notNull().default(""),
});

/** Personas Dana can hand a new specialist (D1); the demo profile holds Elliot and Sana. */
export const personaPool = pgTable("persona_pool", {
  id: text("id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  name: text("name").notNull(),
  role: text("role").notNull(),
  avatar: jsonb("avatar").$type<SpriteAvatar>().notNull(),
});

export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  name: text("name").notNull(),
  tagline: text("tagline").notNull().default(""),
  purpose: text("purpose").notNull().default(""),
  status: text("status").notNull().default("idle"), // active | idle
  origin: text("origin").notNull().default("Seeded"),
  author: text("author"),
  installs: integer("installs"),
  community: boolean("community").notNull().default(false),
  workflow: jsonb("workflow").$type<WorkflowStage[]>().notNull().default([]),
  criteria: jsonb("criteria").$type<string[]>().notNull().default([]),
  reworkBudget: integer("rework_budget").notNull().default(2),
});

export const teamMembers = pgTable("team_members", {
  teamId: text("team_id").notNull(),
  agentId: text("agent_id").notNull(),
  ord: integer("ord").notNull().default(0),
  duty: text("duty").notNull().default(""),
  lead: boolean("lead").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.teamId, t.agentId] })]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  headId: text("head_id").notNull(),
});

export const orgSlots = pgTable("org_slots", {
  orgId: text("org_id").notNull(),
  key: text("key").notNull(),
  ord: integer("ord").notNull().default(0),
  teamId: text("team_id").notNull(),
}, (t) => [primaryKey({ columns: [t.orgId, t.key] })]);

export const orgHandoffs = pgTable("org_handoffs", {
  orgId: text("org_id").notNull(),
  fromTeamId: text("from_team_id").notNull(),
  toTeamId: text("to_team_id").notNull(),
  ord: integer("ord").notNull().default(0),
  question: text("question").notNull(),
  preview: boolean("preview").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.orgId, t.fromTeamId, t.toTeamId] })]);

// ---- Work: projects, tasks, runs ----

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  name: text("name").notNull(),
  goal: text("goal").notNull(),
  archived: boolean("archived").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  teamId: text("team_id").notNull(),
  ord: integer("ord").notNull().default(0),
  title: text("title").notNull(),
  proposal: jsonb("proposal").$type<Task["proposal"]>(),
  preview: boolean("preview").notNull().default(false),
  recordingKey: text("recording_key"),
  sessionId: text("session_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id"), // null on an imported recording with no task
  teamId: text("team_id").notNull(),
  n: integer("n").notNull(),
  objective: text("objective").notNull(),
  status: text("status").notNull().default("running"), // running | blocked | accepted | stopped
  brief: jsonb("brief").$type<Brief>().notNull(),
  budget: jsonb("budget").$type<{ costUsd: number; timeS: number }>().notNull(),
  reworkBudget: integer("rework_budget").notNull().default(2),
  assistantTokens: integer("assistant_tokens").notNull().default(0),
  outcome: text("outcome"),
  reportId: text("report_id"),
  costUsd: numeric("cost_usd").notNull().default("0"),
  etaS: numeric("eta_s"),
  /** Set when the true length isn't wall-clock (seeded loops, recordings, splices). */
  durationS: numeric("duration_s"),
  recorded: boolean("recorded").notNull().default(false),
  recordingKey: text("recording_key"),
  recordingKind: text("recording_kind"), // real | illustrative
  splicedFromRunId: text("spliced_from_run_id"),
  spliceT: numeric("splice_t"),
  finalizedAt: ts("finalized_at"),
  startedAt: ts("started_at").notNull().defaultNow(),
  endedAt: ts("ended_at"),
}, (t) => [index("runs_task_idx").on(t.taskId), index("runs_recording_idx").on(t.recordingKey)]);

/** Append-only. `seq` is unique per run; concurrent writers stamp it atomically (writer.ts). */
export const runEvents = pgTable("run_events", {
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  /** Seconds since the run's started_at (the recorded timeline, not wall clock). */
  t: numeric("t").notNull(),
  type: text("type").$type<RunEventType>().notNull(),
  actorAgentId: text("actor_agent_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.runId, t.seq] }), index("run_events_run_idx").on(t.runId)]);

export const contextSnapshots = pgTable("context_snapshots", {
  id: text("id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  runId: text("run_id").notNull(),
  agentId: text("agent_id").notNull(),
  step: text("step").notNull(),
  assembledAtS: numeric("assembled_at_s").notNull(),
  sections: jsonb("sections").$type<ContextSection[]>().notNull(),
  totalTokens: integer("total_tokens").notNull(),
  tools: jsonb("tools").$type<{ name: string; policy: ToolPolicy }[]>().notNull(),
  lastDenied: text("last_denied"),
  notLoaded: text("not_loaded").notNull().default(""),
  note: text("note").notNull().default(""),
  sandbox: text("sandbox"),
});

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  name: text("name").notNull(),
  by: text("by").notNull().default(""),
  ord: integer("ord").notNull().default(0),
  contentType: text("content_type").notNull().default("text/plain"),
  content: text("content").notNull(), // small files live in the DB (TOOLS step 6)
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const reports = pgTable("reports", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  title: text("title").notNull(),
  intro: text("intro").notNull(),
  summary: text("summary").notNull(),
  results: jsonb("results").$type<Report["results"]>().notNull(),
  caveats: jsonb("caveats").$type<string[]>().notNull(),
  provenance: jsonb("provenance").$type<Report["provenance"]>().notNull(),
  madeBy: jsonb("made_by").$type<string[]>().notNull(),
  artifacts: jsonb("artifacts").$type<Report["artifacts"]>().notNull(),
  emailed: boolean("emailed").notNull().default(false),
  setup: jsonb("setup").$type<Report["setup"]>(),
  kind: text("kind"), // real | illustrative
});

// ---- Chat (rows are DANA's to write; DATA owns the tables) ----

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  title: text("title").notNull(),
  href: text("href").notNull().default("/"),
  projectId: text("project_id"),
  status: text("status"), // unread | input | idle
  agentId: text("agent_id").notNull(),
  teamId: text("team_id"),
  messages: integer("messages").notNull().default(0),
  newReplies: integer("new_replies"),
  /** Relative time of the last message, as the UI shows it ("12m", "2d"). */
  updated: text("updated").notNull().default(""),
});

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(), // user | assistant
  content: jsonb("content").notNull(), // ChatPart[]
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("chat_messages_session_idx").on(t.sessionId)]);

export const dispositions = pgTable("dispositions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  turn: integer("turn").notNull(),
  disposition: text("disposition").notNull(),
  considered: jsonb("considered").$type<string[]>().notNull().default([]),
  reason: text("reason").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const proposals = pgTable("proposals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // team | specialist
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | declined | superseded
  sessionId: text("session_id"),
  toolCallId: text("tool_call_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---- Weave (phase 1 serves the seeded world; finalize appends result items) ----

/** `data` holds the full InboxItem (kind-specific fields included); columns exist for lookups. */
export const weaveItems = pgTable("weave_items", {
  id: text("id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  kind: text("kind").notNull(),
  agentId: text("agent_id").notNull(),
  taskId: text("task_id"),
  at: text("at").notNull(),
  data: jsonb("data").$type<InboxItem>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const weavePulse = pgTable("weave_pulse", {
  id: text("id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  data: jsonb("data").$type<PulseEntry>().notNull(),
});

export const weavePresence = pgTable("weave_presence", {
  agentId: text("agent_id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  data: jsonb("data").$type<Presence>().notNull(),
});

export const weaveCalendar = pgTable("weave_calendar", {
  id: text("id").primaryKey(),
  ord: integer("ord").notNull().default(0),
  data: jsonb("data").$type<CalendarEvent>().notNull(),
});

/** Written by seed so tests and tools know which profile a branch holds. */
export const seedState = pgTable("seed_state", {
  id: integer("id").primaryKey().default(1),
  profile: text("profile").notNull(),
  seededAt: ts("seeded_at").notNull().defaultNow(),
});

// ---- payload typing helpers (not tables) ----

export type RunEventRow = typeof runEvents.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type { RunSegment, RunEventType, RunEventPayloads };
