CREATE TYPE "public"."glim_autopilot_decider" AS ENUM('model', 'rule', 'pending_raise', 'none');--> statement-breakpoint
CREATE TYPE "public"."glim_autopilot_outcome" AS ENUM('applied', 'raise_prepared', 'kept', 'skipped', 'stale', 'refused', 'failed', 'stopped');--> statement-breakpoint
ALTER TYPE "public"."glim_action_kind" ADD VALUE 'autopilot_changed';--> statement-breakpoint
ALTER TYPE "public"."glim_action_kind" ADD VALUE 'autopilot_raise_prepared';--> statement-breakpoint
CREATE TABLE "glim_autopilot" (
	"paddle_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"cursor_event_log_id" bigint DEFAULT 0 NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claimed_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closing_reviewed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"running_since" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_model_call_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glim_autopilot_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"paddle_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"plan_id" uuid,
	"action_id" uuid,
	"triggers" jsonb NOT NULL,
	"outcome" "glim_autopilot_outcome" NOT NULL,
	"decided_by" "glim_autopilot_decider" NOT NULL,
	"model" text,
	"brief" text,
	"error" text,
	"decision" jsonb,
	"issues" jsonb,
	"plan_version_before" integer,
	"plan_version_after" integer,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "glim_autopilot_runs_tokens_nonnegative" CHECK ("glim_autopilot_runs"."tokens_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "glim_actions" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "glim_plans" ADD COLUMN "mandate" jsonb;--> statement-breakpoint
ALTER TABLE "glim_autopilot" ADD CONSTRAINT "glim_autopilot_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_autopilot" ADD CONSTRAINT "glim_autopilot_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_autopilot_runs" ADD CONSTRAINT "glim_autopilot_runs_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_autopilot_runs" ADD CONSTRAINT "glim_autopilot_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_autopilot_runs" ADD CONSTRAINT "glim_autopilot_runs_plan_id_glim_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."glim_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_autopilot_runs" ADD CONSTRAINT "glim_autopilot_runs_action_id_glim_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."glim_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "glim_autopilot_due_idx" ON "glim_autopilot" USING btree ("due_at") WHERE "glim_autopilot"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "glim_autopilot_event_idx" ON "glim_autopilot" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "glim_autopilot_runs_paddle_idx" ON "glim_autopilot_runs" USING btree ("paddle_id","started_at");--> statement-breakpoint
CREATE INDEX "glim_autopilot_runs_event_idx" ON "glim_autopilot_runs" USING btree ("event_id","started_at");--> statement-breakpoint
CREATE INDEX "glim_autopilot_runs_started_idx" ON "glim_autopilot_runs" USING btree ("started_at");