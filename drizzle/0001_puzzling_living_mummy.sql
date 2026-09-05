CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"target" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxy_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"proxy_key_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"path" text NOT NULL,
	"transaction_id" text,
	"decision" text NOT NULL,
	"estimated_amount" integer NOT NULL,
	"actual_amount" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"upstream_status" integer,
	"streamed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proxy_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"provider_key_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_reveal" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_keys" ADD CONSTRAINT "proxy_keys_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_keys" ADD CONSTRAINT "proxy_keys_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_keys" ADD CONSTRAINT "proxy_keys_provider_key_id_provider_keys_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."provider_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notif_user_idx" ON "notification_channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "provider_keys_ws_idx" ON "provider_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "proxy_calls_ws_idx" ON "proxy_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "proxy_calls_mandate_idx" ON "proxy_calls" USING btree ("mandate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_keys_token_hash_idx" ON "proxy_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "proxy_keys_ws_idx" ON "proxy_keys" USING btree ("workspace_id");