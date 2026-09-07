CREATE TABLE "mcp_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_grants_user_idx" ON "mcp_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_grants_ws_idx" ON "mcp_grants" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rateLimit_key_idx" ON "rate_limit" USING btree ("key");