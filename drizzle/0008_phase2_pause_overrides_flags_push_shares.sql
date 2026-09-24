CREATE TABLE "mandate_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"field" text NOT NULL,
	"amount" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "flags" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "paused_by" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "flags" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "mandate_overrides" ADD CONSTRAINT "mandate_overrides_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mandate_overrides_mandate_idx" ON "mandate_overrides" USING btree ("mandate_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "txn_share_token_idx" ON "transactions" USING btree ("share_token");