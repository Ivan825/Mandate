CREATE TABLE "approval_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"min_amount" integer,
	"max_amount" integer,
	"category" text DEFAULT '' NOT NULL,
	"merchant_pattern" text DEFAULT '' NOT NULL,
	"mandate_id" text,
	"user_ids" text DEFAULT '[]' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"merchant" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_anchors" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"seq" integer NOT NULL,
	"hash" text NOT NULL,
	"prev_anchor_hash" text NOT NULL,
	"anchor_hash" text NOT NULL,
	"signature" text NOT NULL,
	"key_id" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"n" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxy_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_header" text DEFAULT 'authorization' NOT NULL,
	"auth_ciphertext" text NOT NULL,
	"auth_hint" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"pricing" text DEFAULT 'per_call' NOT NULL,
	"price_amount" integer DEFAULT 1 NOT NULL,
	"price_key" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proxy_keys" ALTER COLUMN "provider_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "required_approvers" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "signoffs" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "route_id" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "cosign_above" integer;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "cosign_count" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "sandbox" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_keys" ADD COLUMN "target_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "dispute_id" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "frozen_by" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "frozen_reason" text;--> statement-breakpoint
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_targets" ADD CONSTRAINT "proxy_targets_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_routes_ws_idx" ON "approval_routes" USING btree ("workspace_id","priority");--> statement-breakpoint
CREATE INDEX "disputes_ws_status_idx" ON "disputes" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "disputes_txn_idx" ON "disputes" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_anchors_n_idx" ON "ledger_anchors" USING btree ("n");--> statement-breakpoint
CREATE INDEX "ledger_anchors_ws_idx" ON "ledger_anchors" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_targets_ws_slug_idx" ON "proxy_targets" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "mandates_parent_idx" ON "mandates" USING btree ("parent_id");