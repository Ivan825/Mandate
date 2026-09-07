CREATE TABLE "topups" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount" integer NOT NULL,
	"source" text NOT NULL,
	"reference" text NOT NULL,
	"by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cardholder_profiles" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cardholder_profiles" ADD COLUMN "terms_ip" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cardholder_profiles" ADD COLUMN "terms_user_agent" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cardholder_profiles" ADD COLUMN "stripe_cardholder_id" text;--> statement-breakpoint
ALTER TABLE "cardholder_profiles" ADD COLUMN "cardholder_status" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cardholder_profiles" ADD COLUMN "cardholder_requirements" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "card_exp" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "card_status" text;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topups_reference_idx" ON "topups" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "topups_ws_idx" ON "topups" USING btree ("workspace_id","currency");