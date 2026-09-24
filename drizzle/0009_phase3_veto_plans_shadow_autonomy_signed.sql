CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"title" text NOT NULL,
	"items" text NOT NULL,
	"total_max" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'agent_api' NOT NULL,
	"flags" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "kind" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "veto_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "signed_with" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "veto_above" integer;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "veto_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "mode" text DEFAULT 'enforce' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "autonomy_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "autonomy_every" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "autonomy_ceiling" integer;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "autonomy_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "autonomy_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "shadow_decision" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "shadow_rule" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "shadow_reason" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "plan_id" text;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plans_mandate_status_idx" ON "plans" USING btree ("mandate_id","status");--> statement-breakpoint
CREATE INDEX "plans_ws_status_idx" ON "plans" USING btree ("workspace_id","status");