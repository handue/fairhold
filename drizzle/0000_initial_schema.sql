CREATE TYPE "public"."bid_source" AS ENUM('guest', 'guest_max', 'glim', 'bot');--> statement-breakpoint
CREATE TYPE "public"."chat_card_type" AS ENUM('plan', 'event', 'action', 'none');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('guest', 'glim');--> statement-breakpoint
CREATE TYPE "public"."director_job_status" AS ENUM('queued', 'running', 'done', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."event_log_type" AS ENUM('bid', 'lot_closed', 'event_status', 'hold', 'glim', 'settlement');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'scheduled', 'live', 'closed', 'settling', 'settled');--> statement-breakpoint
CREATE TYPE "public"."glim_action_kind" AS ENUM('plan_started', 'bid', 'raise', 'limit_reached', 'lot_won', 'lot_lost', 'paused', 'resumed', 'plan_edited', 'proposal_rejected', 'nudge');--> statement-breakpoint
CREATE TYPE "public"."glim_chip" AS ENUM('winning', 'closed', 'none');--> statement-breakpoint
CREATE TYPE "public"."glim_decision" AS ENUM('executed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."glim_plan_item_status" AS ENUM('watching', 'winning', 'at_limit', 'outbid_over_limit', 'won', 'lost', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."glim_plan_status" AS ENUM('proposed', 'active', 'paused', 'ended', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."hold_kind" AS ENUM('paypal', 'simulated');--> statement-breakpoint
CREATE TYPE "public"."hold_status" AS ENUM('pending_approval', 'authorized', 'replaced', 'voided', 'captured', 'expired', 'denied', 'canceled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."limit_owner" AS ENUM('guest_max', 'glim');--> statement-breakpoint
CREATE TYPE "public"."lot_category" AS ENUM('dining', 'experiences', 'art', 'wellness', 'pets');--> statement-breakpoint
CREATE TYPE "public"."lot_status" AS ENUM('draft', 'open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."photo_kind" AS ENUM('illustration', 'upload');--> statement-breakpoint
CREATE TYPE "public"."settlement_action" AS ENUM('capture', 'void', 'simulate');--> statement-breakpoint
CREATE TYPE "public"."settlement_item_status" AS ENUM('queued', 'processing', 'succeeded', 'pending', 'failed');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('running', 'done', 'done_with_errors');--> statement-breakpoint
CREATE TABLE "bid_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paddle_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"max_cents" integer NOT NULL,
	"owner" "limit_owner" NOT NULL,
	"plan_item_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"paused_at" timestamp with time zone,
	"exhausted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bid_limits_max_positive" CHECK ("bid_limits"."max_cents" > 0),
	CONSTRAINT "bid_limits_ended_iff_inactive" CHECK ("bid_limits"."active" = ("bid_limits"."ended_at" is null))
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"paddle_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"source" "bid_source" NOT NULL,
	"limit_id" uuid,
	"glim_action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bids_amount_positive" CHECK ("bids"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paddle_id" uuid NOT NULL,
	"role" "chat_role" NOT NULL,
	"text" text NOT NULL,
	"card_type" "chat_card_type" DEFAULT 'none' NOT NULL,
	"card" jsonb,
	"plan_id" uuid,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_tokens_nonnegative" CHECK ("chat_messages"."tokens_used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "director_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" "director_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "director_jobs_attempts_nonnegative" CHECK ("director_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "error_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"code" text,
	"message" text NOT NULL,
	"event_id" uuid,
	"paddle_id" uuid,
	"paypal_debug_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"paddle_id" uuid,
	"type" "event_log_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"charity_name" text NOT NULL,
	"charity_ein" text,
	"charity_is_501c3" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"soft_descriptor" text,
	"hold_presets_cents" integer[] DEFAULT '{25000,50000,100000}' NOT NULL,
	"hold_min_cents" integer,
	"hold_max_cents" integer,
	"pickup_note" text,
	"join_url" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"demo_expires_at" timestamp with time zone,
	"template_key" text,
	"closed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_unique" UNIQUE("slug"),
	CONSTRAINT "events_currency_usd" CHECK ("events"."currency" = 'USD'),
	CONSTRAINT "events_soft_descriptor_length" CHECK (char_length("events"."soft_descriptor") <= 22),
	CONSTRAINT "events_hold_range" CHECK ("events"."hold_min_cents" <= "events"."hold_max_cents")
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"paddle_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_paddle_id_lot_id_pk" PRIMARY KEY("paddle_id","lot_id")
);
--> statement-breakpoint
CREATE TABLE "glim_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paddle_id" uuid NOT NULL,
	"plan_id" uuid,
	"lot_id" uuid,
	"kind" "glim_action_kind" NOT NULL,
	"amount_cents" integer,
	"limit_cents" integer,
	"hold_cents_at_time" integer,
	"decision" "glim_decision" NOT NULL,
	"reject_reason" text,
	"message" text NOT NULL,
	"chip" "glim_chip" DEFAULT 'none' NOT NULL,
	"trigger_bid_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glim_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"max_cents" integer NOT NULL,
	"status" "glim_plan_item_status" NOT NULL,
	CONSTRAINT "glim_plan_items_priority_positive" CHECK ("glim_plan_items"."priority" > 0),
	CONSTRAINT "glim_plan_items_max_positive" CHECK ("glim_plan_items"."max_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "glim_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paddle_id" uuid NOT NULL,
	"status" "glim_plan_status" NOT NULL,
	"budget_cents" integer NOT NULL,
	"proposal" jsonb NOT NULL,
	"model" text,
	"source_message_id" uuid,
	"confirmed_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glim_plans_budget_nonnegative" CHECK ("glim_plans"."budget_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "glim_transcript" (
	"paddle_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"message" jsonb NOT NULL,
	"chat_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glim_transcript_paddle_id_position_pk" PRIMARY KEY("paddle_id","position"),
	CONSTRAINT "glim_transcript_position_nonnegative" CHECK ("glim_transcript"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"paddle_id" uuid NOT NULL,
	"kind" "hold_kind" NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "hold_status" DEFAULT 'pending_approval' NOT NULL,
	"paypal_order_id" text,
	"original_authorization_id" text,
	"current_authorization_id" text,
	"authorized_at" timestamp with time zone,
	"honor_until" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"reauthorized_at" timestamp with time zone,
	"replaced_by_hold_id" uuid,
	"captured_cents" integer,
	"last_synced_at" timestamp with time zone,
	"paypal_debug_id" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holds_amount_positive" CHECK ("holds"."amount_cents" > 0),
	CONSTRAINT "holds_captured_nonnegative" CHECK ("holds"."captured_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lot_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"is_cover" boolean DEFAULT false NOT NULL,
	"kind" "photo_kind" NOT NULL,
	"illustration_key" text,
	"data" "bytea",
	"url" text,
	"mime" text,
	"alt" text,
	CONSTRAINT "lot_photos_source" CHECK (("lot_photos"."kind" = 'illustration' and "lot_photos"."illustration_key" is not null)
        or ("lot_photos"."kind" = 'upload' and "lot_photos"."mime" is not null and ("lot_photos"."data" is not null or "lot_photos"."url" is not null))),
	CONSTRAINT "lot_photos_data_size" CHECK (octet_length("lot_photos"."data") <= 1048576)
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"short_title" text NOT NULL,
	"title" text NOT NULL,
	"category" "lot_category" NOT NULL,
	"donor_name" text,
	"description" text,
	"estimated_value_cents" integer,
	"value_basis" text,
	"starting_bid_cents" integer NOT NULL,
	"min_raise_cents" integer NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"status" "lot_status" DEFAULT 'draft' NOT NULL,
	"current_bid_cents" integer,
	"bid_count" integer DEFAULT 0 NOT NULL,
	"high_paddle_id" uuid,
	"high_bid_source" "bid_source",
	"winning_paddle_id" uuid,
	"winning_cents" integer,
	"closed_at" timestamp with time zone,
	"cover_photo_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lots_number_positive" CHECK ("lots"."number" > 0),
	CONSTRAINT "lots_starting_bid_positive" CHECK ("lots"."starting_bid_cents" > 0),
	CONSTRAINT "lots_min_raise_positive" CHECK ("lots"."min_raise_cents" > 0),
	CONSTRAINT "lots_bid_count_nonnegative" CHECK ("lots"."bid_count" >= 0),
	CONSTRAINT "lots_estimated_value_nonnegative" CHECK ("lots"."estimated_value_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "paddles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"first_name" text NOT NULL,
	"last_initial" text,
	"email" text,
	"paypal_payer_id" text,
	"is_simulated" boolean DEFAULT false NOT NULL,
	"bot_profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paddles_number_positive" CHECK ("paddles"."number" > 0)
);
--> statement-breakpoint
CREATE TABLE "paypal_webhook_events" (
	"paypal_event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"verified" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"paddle_id" uuid NOT NULL,
	"number" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hold_cents" integer NOT NULL,
	"hold_authorized_at" timestamp with time zone,
	"paid_cents" integer NOT NULL,
	"released_cents" integer NOT NULL,
	"deductible_cents" integer NOT NULL,
	"paypal_capture_id" text,
	"statement_descriptor" text,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"glim_recap" jsonb,
	"emailed_at" timestamp with time zone,
	CONSTRAINT "receipts_amounts_nonnegative" CHECK ("receipts"."hold_cents" >= 0 and "receipts"."paid_cents" >= 0 and "receipts"."released_cents" >= 0 and "receipts"."deductible_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"event_id" uuid NOT NULL,
	"paddle_id" uuid,
	"is_organizer" boolean DEFAULT false NOT NULL,
	"organizer_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settlement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"paddle_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"action" "settlement_action" NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"released_cents" integer DEFAULT 0 NOT NULL,
	"status" "settlement_item_status" DEFAULT 'queued' NOT NULL,
	"paypal_request_id" text,
	"paypal_capture_id" text,
	"paypal_debug_id" text,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "settlement_items_amounts_nonnegative" CHECK ("settlement_items"."amount_cents" >= 0 and "settlement_items"."released_cents" >= 0 and "settlement_items"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "settlement_status" DEFAULT 'running' NOT NULL,
	"started_by_session_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"to_charge_cents" integer DEFAULT 0 NOT NULL,
	"to_release_cents" integer DEFAULT 0 NOT NULL,
	"winners" integer DEFAULT 0 NOT NULL,
	"non_winners" integer DEFAULT 0 NOT NULL,
	"checks" jsonb,
	CONSTRAINT "settlements_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "settlements_totals_nonnegative" CHECK ("settlements"."to_charge_cents" >= 0 and "settlements"."to_release_cents" >= 0 and "settlements"."winners" >= 0 and "settlements"."non_winners" >= 0)
);
--> statement-breakpoint
ALTER TABLE "bid_limits" ADD CONSTRAINT "bid_limits_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_limits" ADD CONSTRAINT "bid_limits_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_limits" ADD CONSTRAINT "bid_limits_plan_item_id_glim_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."glim_plan_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_limit_id_bid_limits_id_fk" FOREIGN KEY ("limit_id") REFERENCES "public"."bid_limits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_glim_action_id_glim_actions_id_fk" FOREIGN KEY ("glim_action_id") REFERENCES "public"."glim_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_plan_id_glim_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."glim_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "director_jobs" ADD CONSTRAINT "director_jobs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_log" ADD CONSTRAINT "error_log_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_log" ADD CONSTRAINT "error_log_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_actions" ADD CONSTRAINT "glim_actions_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_actions" ADD CONSTRAINT "glim_actions_plan_id_glim_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."glim_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_actions" ADD CONSTRAINT "glim_actions_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_actions" ADD CONSTRAINT "glim_actions_trigger_bid_id_bids_id_fk" FOREIGN KEY ("trigger_bid_id") REFERENCES "public"."bids"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_plan_items" ADD CONSTRAINT "glim_plan_items_plan_id_glim_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."glim_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_plan_items" ADD CONSTRAINT "glim_plan_items_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_plans" ADD CONSTRAINT "glim_plans_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_plans" ADD CONSTRAINT "glim_plans_source_message_id_chat_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_transcript" ADD CONSTRAINT "glim_transcript_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glim_transcript" ADD CONSTRAINT "glim_transcript_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_replaced_by_hold_id_holds_id_fk" FOREIGN KEY ("replaced_by_hold_id") REFERENCES "public"."holds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_photos" ADD CONSTRAINT "lot_photos_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_high_paddle_id_paddles_id_fk" FOREIGN KEY ("high_paddle_id") REFERENCES "public"."paddles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_winning_paddle_id_paddles_id_fk" FOREIGN KEY ("winning_paddle_id") REFERENCES "public"."paddles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_cover_photo_id_lot_photos_id_fk" FOREIGN KEY ("cover_photo_id") REFERENCES "public"."lot_photos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paddles" ADD CONSTRAINT "paddles_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_started_by_session_id_sessions_id_fk" FOREIGN KEY ("started_by_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bid_limits_one_active_uq" ON "bid_limits" USING btree ("paddle_id","lot_id") WHERE "bid_limits"."active";--> statement-breakpoint
CREATE INDEX "bid_limits_active_lot_idx" ON "bid_limits" USING btree ("lot_id") WHERE "bid_limits"."active";--> statement-breakpoint
CREATE INDEX "bid_limits_paddle_idx" ON "bid_limits" USING btree ("paddle_id");--> statement-breakpoint
CREATE INDEX "bid_limits_lot_idx" ON "bid_limits" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_lot_amount_uq" ON "bids" USING btree ("lot_id","amount_cents");--> statement-breakpoint
CREATE INDEX "bids_paddle_idx" ON "bids" USING btree ("paddle_id");--> statement-breakpoint
CREATE INDEX "chat_messages_paddle_idx" ON "chat_messages" USING btree ("paddle_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_created_idx" ON "chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "director_jobs_due_idx" ON "director_jobs" USING btree ("run_at") WHERE "director_jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "director_jobs_event_idx" ON "director_jobs" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "error_log_created_idx" ON "error_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "error_log_event_idx" ON "error_log" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "error_log_paddle_idx" ON "error_log" USING btree ("paddle_id");--> statement-breakpoint
CREATE INDEX "event_log_event_id_idx" ON "event_log" USING btree ("event_id","id");--> statement-breakpoint
CREATE INDEX "event_log_paddle_idx" ON "event_log" USING btree ("paddle_id") WHERE "event_log"."paddle_id" is not null;--> statement-breakpoint
CREATE INDEX "events_demo_expires_idx" ON "events" USING btree ("demo_expires_at") WHERE "events"."is_demo";--> statement-breakpoint
CREATE INDEX "favorites_lot_idx" ON "favorites" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "glim_actions_paddle_idx" ON "glim_actions" USING btree ("paddle_id","created_at");--> statement-breakpoint
CREATE INDEX "glim_actions_plan_idx" ON "glim_actions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "glim_actions_lot_idx" ON "glim_actions" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "glim_plan_items_plan_lot_uq" ON "glim_plan_items" USING btree ("plan_id","lot_id");--> statement-breakpoint
CREATE INDEX "glim_plan_items_lot_idx" ON "glim_plan_items" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "glim_plans_one_running_per_paddle_uq" ON "glim_plans" USING btree ("paddle_id") WHERE "glim_plans"."status" in ('active', 'paused');--> statement-breakpoint
CREATE INDEX "glim_plans_paddle_idx" ON "glim_plans" USING btree ("paddle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "holds_one_authorized_per_paddle_uq" ON "holds" USING btree ("paddle_id") WHERE "holds"."status" = 'authorized';--> statement-breakpoint
CREATE UNIQUE INDEX "holds_paypal_order_uq" ON "holds" USING btree ("paypal_order_id");--> statement-breakpoint
CREATE INDEX "holds_event_idx" ON "holds" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "holds_paddle_idx" ON "holds" USING btree ("paddle_id");--> statement-breakpoint
CREATE INDEX "holds_original_authorization_idx" ON "holds" USING btree ("original_authorization_id");--> statement-breakpoint
CREATE INDEX "holds_current_authorization_idx" ON "holds" USING btree ("current_authorization_id");--> statement-breakpoint
CREATE INDEX "lot_photos_lot_idx" ON "lot_photos" USING btree ("lot_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "lots_event_number_uq" ON "lots" USING btree ("event_id","number");--> statement-breakpoint
CREATE INDEX "lots_open_closes_at_idx" ON "lots" USING btree ("closes_at") WHERE "lots"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "paddles_event_number_uq" ON "paddles" USING btree ("event_id","number");--> statement-breakpoint
CREATE INDEX "paypal_webhook_events_resource_idx" ON "paypal_webhook_events" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "paypal_webhook_events_unprocessed_idx" ON "paypal_webhook_events" USING btree ("received_at") WHERE "paypal_webhook_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_event_paddle_uq" ON "receipts" USING btree ("event_id","paddle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_event_number_uq" ON "receipts" USING btree ("event_id","number");--> statement-breakpoint
CREATE INDEX "receipts_paddle_idx" ON "receipts" USING btree ("paddle_id");--> statement-breakpoint
CREATE INDEX "sessions_event_idx" ON "sessions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "sessions_paddle_idx" ON "sessions" USING btree ("paddle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_items_settlement_paddle_uq" ON "settlement_items" USING btree ("settlement_id","paddle_id");--> statement-breakpoint
CREATE INDEX "settlement_items_hold_idx" ON "settlement_items" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "settlement_items_paddle_idx" ON "settlement_items" USING btree ("paddle_id");