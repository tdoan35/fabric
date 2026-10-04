CREATE TABLE "agent_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"when" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"personality" text DEFAULT '' NOT NULL,
	"traits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tone" text DEFAULT '' NOT NULL,
	"avatar" jsonb,
	"model" text DEFAULT '' NOT NULL,
	"context_tokens" integer DEFAULT 0 NOT NULL,
	"memory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"greeting" text DEFAULT '' NOT NULL,
	"placeholder" text DEFAULT '' NOT NULL,
	"suggestions" jsonb,
	"workspace" jsonb NOT NULL,
	"origin" text,
	"author" text,
	"installs" integer,
	"community" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"name" text NOT NULL,
	"by" text DEFAULT '' NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"content_type" text DEFAULT 'text/plain' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"step" text NOT NULL,
	"assembled_at_s" numeric NOT NULL,
	"sections" jsonb NOT NULL,
	"total_tokens" integer NOT NULL,
	"tools" jsonb NOT NULL,
	"last_denied" text,
	"not_loaded" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"sandbox" text
);
--> statement-breakpoint
CREATE TABLE "dispositions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn" integer NOT NULL,
	"disposition" text NOT NULL,
	"considered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_handoffs" (
	"org_id" text NOT NULL,
	"from_team_id" text NOT NULL,
	"to_team_id" text NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"question" text NOT NULL,
	"preview" boolean DEFAULT false NOT NULL,
	CONSTRAINT "org_handoffs_org_id_from_team_id_to_team_id_pk" PRIMARY KEY("org_id","from_team_id","to_team_id")
);
--> statement-breakpoint
CREATE TABLE "org_slots" (
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "org_slots_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"head_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_pool" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"avatar" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"session_id" text,
	"tool_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"title" text NOT NULL,
	"intro" text NOT NULL,
	"summary" text NOT NULL,
	"results" jsonb NOT NULL,
	"caveats" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"made_by" jsonb NOT NULL,
	"artifacts" jsonb NOT NULL,
	"emailed" boolean DEFAULT false NOT NULL,
	"setup" jsonb,
	"kind" text
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"t" numeric NOT NULL,
	"type" text NOT NULL,
	"actor_agent_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"team_id" text NOT NULL,
	"n" integer NOT NULL,
	"objective" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"brief" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"rework_budget" integer DEFAULT 2 NOT NULL,
	"assistant_tokens" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"report_id" text,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"eta_s" numeric,
	"duration_s" numeric,
	"recorded" boolean DEFAULT false NOT NULL,
	"recording_key" text,
	"recording_kind" text,
	"spliced_from_run_id" text,
	"splice_t" numeric,
	"finalized_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "seed_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"profile" text NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"href" text DEFAULT '/' NOT NULL,
	"project_id" text,
	"status" text,
	"agent_id" text NOT NULL,
	"team_id" text,
	"messages" integer DEFAULT 0 NOT NULL,
	"new_replies" integer,
	"updated" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"team_id" text NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"proposal" jsonb,
	"preview" boolean DEFAULT false NOT NULL,
	"recording_key" text,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"duty" text DEFAULT '' NOT NULL,
	"lead" boolean DEFAULT false NOT NULL,
	CONSTRAINT "team_members_team_id_agent_id_pk" PRIMARY KEY("team_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"origin" text DEFAULT 'Seeded' NOT NULL,
	"author" text,
	"community" boolean DEFAULT false NOT NULL,
	"workflow" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rework_budget" integer DEFAULT 2 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weave_calendar" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weave_items" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text NOT NULL,
	"task_id" text,
	"at" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weave_presence" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weave_pulse" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_recording_idx" ON "runs" USING btree ("recording_key");