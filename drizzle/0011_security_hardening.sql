DROP INDEX "txn_stripe_auth_idx";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "delegated_by" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "voucher_issued_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "txn_stripe_auth_idx" ON "transactions" USING btree ("stripe_authorization_id");