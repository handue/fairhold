CREATE TABLE "heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "glim_actions" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "glim_actions" ADD COLUMN "source_event_log_id" bigint;--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
ALTER TABLE "glim_actions" ADD CONSTRAINT "glim_actions_source_event_log_id_event_log_id_fk" FOREIGN KEY ("source_event_log_id") REFERENCES "public"."event_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "glim_actions_source_event_log_uq" ON "glim_actions" USING btree ("source_event_log_id") WHERE "glim_actions"."source_event_log_id" is not null;