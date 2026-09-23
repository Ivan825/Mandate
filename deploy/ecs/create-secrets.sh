#!/usr/bin/env bash
# Creates the application secrets in AWS Secrets Manager (one per value).
# Run once per region before deploying the stack. Re-running skips existing.
#   AWS_REGION=us-east-1 ./deploy/ecs/create-secrets.sh
# Then set the ones that are not random:
#   ./deploy/ecs/create-secrets.sh set SMTP_URL 'smtps://you%40gmail.com:app-password@smtp.gmail.com:465'
#   ./deploy/ecs/create-secrets.sh set EMAIL_FROM 'Mandate <you@gmail.com>'
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
PREFIX="${SECRETS_PREFIX:-mandate}"

put() { # name value
  if aws secretsmanager describe-secret --secret-id "$PREFIX/$1" --region "$REGION" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$PREFIX/$1" --secret-string "$2" --region "$REGION" >/dev/null
    echo "updated $PREFIX/$1"
  else
    aws secretsmanager create-secret --name "$PREFIX/$1" --secret-string "$2" --region "$REGION" >/dev/null
    echo "created $PREFIX/$1"
  fi
}
ensure_random() { # name generator
  if aws secretsmanager describe-secret --secret-id "$PREFIX/$1" --region "$REGION" >/dev/null 2>&1; then echo "exists  $PREFIX/$1"; else put "$1" "$($2)"; fi
}
ensure_placeholder() { # name — optional values start empty so the task definition can reference them
  if aws secretsmanager describe-secret --secret-id "$PREFIX/$1" --region "$REGION" >/dev/null 2>&1; then echo "exists  $PREFIX/$1"; else put "$1" " "; fi
}

if [ "${1:-}" = "set" ]; then put "$2" "$3"; exit 0; fi

ensure_random BETTER_AUTH_SECRET   "openssl rand -base64 32"
ensure_random NOTIFY_SECRET        "openssl rand -base64 32"
ensure_random MANDATE_ENCRYPTION_KEY "openssl rand -base64 32"
ensure_random RECEIPT_SIGNING_KEY  "openssl rand -base64 32"
ensure_random CRON_SECRET          "openssl rand -hex 32"
for opt in SMTP_URL EMAIL_FROM GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET SENTRY_DSN; do ensure_placeholder "$opt"; done
echo
echo "Back up MANDATE_ENCRYPTION_KEY and RECEIPT_SIGNING_KEY somewhere durable:"
echo "  aws secretsmanager get-secret-value --secret-id $PREFIX/MANDATE_ENCRYPTION_KEY --query SecretString --output text --region $REGION"
echo "Now set SMTP_URL and EMAIL_FROM with:  $0 set SMTP_URL '...'"
