ALTER TABLE "mandates" ALTER COLUMN "timezone" SET DEFAULT 'UTC';--> statement-breakpoint
CREATE INDEX "txn_stripe_auth_idx" ON "transactions" USING btree ("stripe_authorization_id");