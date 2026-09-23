# Mandate on AWS (one EC2 instance, paid from credits)

Everything on one box: the app, Postgres, automatic HTTPS, nightly backups, the cleanup cron. No function time limits, no database auto-suspend, no cold starts. Cost at credit prices: a `t3.small` (2 vCPU, 2 GB) is about $17/month on-demand; `t3.medium` (4 GB) about $34. Both are fine for a beta of hundreds of users.

## 1. Create the instance (10 minutes, in the AWS console)

1. EC2 → Launch instance. Name `mandate`. Image **Ubuntu Server 24.04 LTS**. Type `t3.small` (or `t3.medium`). Key pair: create one, download the `.pem`.
2. Network: allow SSH (22) from *My IP*, HTTP (80) and HTTPS (443) from *Anywhere*.
3. Storage: 20 GB gp3.
4. Launch. Then **Elastic IPs → Allocate → Associate** with the instance (so the address survives restarts).
5. DNS: at your domain's DNS, an `A` record for your hostname → that Elastic IP. (No domain? A free `duckdns.org` or `nip.io` name works for a beta: e.g. `mandate.duckdns.org`. Caddy issues a real certificate for it.)

## 2. Install and configure (10 minutes, in a terminal)

```bash
ssh -i mandate.pem ubuntu@<elastic-ip>
curl -fsSL https://raw.githubusercontent.com/Ivan825/Mandate/main/deploy/aws/setup-ec2.sh | bash
exit            # then ssh back in so the docker group applies
ssh -i mandate.pem ubuntu@<elastic-ip>
cd ~/mandate && nano .env
```

Fill every line of `.env` (it was copied from `deploy/aws/env.production.example`). Generate the secrets with the commands in the comments. `DOMAIN` is the bare hostname, `APP_URL` is `https://` + that hostname.

## 3. Start

```bash
docker compose -f docker-compose.yml -f deploy/aws/docker-compose.prod.yml up -d --build
docker compose logs -f app      # wait for "Ready", Ctrl-C
```

First build takes 3–5 minutes on a t3.small. Open `https://<your hostname>`. Caddy fetches the certificate on the first request (a few seconds). Migrations run automatically on every start.

## 4. Email

Gmail SMTP (free, 500/day) as in `.env`. With credits, **Amazon SES** is the upgrade: Console → SES → verify your sending address (or domain), request production access (a one-line form, approved within a day), create SMTP credentials, then

```
SMTP_URL=smtps://<SES SMTP username>:<SES SMTP password>@email-smtp.us-east-1.amazonaws.com:465
EMAIL_FROM="Mandate <you@yourdomain>"
```

## 5. Operate

| Task | Command (from `~/mandate`) |
|---|---|
| Deploy a new version | `git pull && docker compose -f docker-compose.yml -f deploy/aws/docker-compose.prod.yml up -d --build` |
| Logs | `docker compose logs -f app` (JSON lines with request ids) |
| Restart | `docker compose restart app` |
| Backups | nightly `.dump` files in `~/mandate/backups/` (14 kept). Copy them off the box: `aws s3 sync backups s3://your-bucket/mandate-backups` in a crontab line, after `aws configure`. |
| Restore | `docker compose exec -T db pg_restore -U mandate -d mandate --clean < backups/mandate-YYYY-MM-DD.dump` |
| Grant beta credit / record a refund | `docker compose exec app npx tsx scripts/credit.ts <workspaceId> 2500 USD "beta credit"` |
| Change `.env` | edit, then `docker compose ... up -d` (recreates only what changed) |

Set `SENTRY_DSN` in `.env` and an uptime monitor on the URL, as in LAUNCH.md §6. Everything in LAUNCH.md §7 (the pre-launch walkthrough) applies unchanged; skip §4 (Vercel).

## 6. Later, if it grows

Move Postgres to RDS (`DATABASE_URL` in `.env`, drop the `db` service), put the app behind an ALB with two instances, or run the image on ECS Fargate. Nothing in the code changes; it already assumes several instances can run at once.

## Why not the free tier alone?

You can: `t3.micro`/`t2.micro` is free for 12 months, and this stack runs on it (the swap file in the setup script is there for exactly that). It will be slow to build and occasionally sluggish under load. With credits, `t3.small` is the sensible floor.
