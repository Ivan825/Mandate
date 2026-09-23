# Mandate on ECS Fargate + RDS (the "proper" AWS shape)

Managed containers, managed Postgres, a load balancer with a certificate, scheduled cleanup. About $60–80/month at credit prices (Fargate 0.5 vCPU/1 GB ≈ $18, RDS `db.t4g.micro` ≈ $13, ALB ≈ $20, NAT-free networking as below). More moving parts than `deploy/aws/README.md` (one EC2 box); choose this if you want the architecture to scale out later or to show on a résumé.

Everything below uses the AWS console except image pushes. Region: pick one and use it everywhere (US East `us-east-1` for a Reddit beta).

## 0. One-time prerequisites on your Mac

`aws configure` with an IAM user that has AdministratorAccess (for setup; narrow it later). Docker Desktop running.

## 1. Network

Use the **default VPC**. Its subnets are public, which keeps this free of NAT gateways ($32/month each): the tasks get public IPs and reach the internet directly; RDS stays private.

## 2. Database (RDS)

RDS → Create database → Standard create → PostgreSQL 16 → template **Free tier** (or Dev/Test). Instance `db.t4g.micro`, 20 GB gp3, storage autoscaling on. DB name `mandate`, master user `mandate`, generate a password. Connectivity: default VPC, **not** publicly accessible, new security group `mandate-db`. Backups: 7 days. Create.

`DATABASE_URL` = `postgres://mandate:<password>@<endpoint>:5432/mandate?sslmode=require`. The app verifies RDS's certificate against the bundle baked into the image (`DATABASE_SSL_CA=/app/certs/rds.pem`, already in the task definition).

## 3. Secrets

Secrets Manager → Store a new secret → *Other type* → **Plaintext**, one secret per value, named exactly `mandate/DATABASE_URL`, `mandate/BETTER_AUTH_SECRET`, `mandate/NOTIFY_SECRET`, `mandate/MANDATE_ENCRYPTION_KEY`, `mandate/RECEIPT_SIGNING_KEY`, `mandate/CRON_SECRET`, `mandate/SMTP_URL` (generate values as in LAUNCH.md §1; SMTP as in LAUNCH.md §3). Optional extras (`GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, …) the same way; add them to the task definition's `secrets` when you use them.

## 4. Image

```bash
cd ~/projects/Mandate
AWS_REGION=us-east-1 ./deploy/ecs/push-image.sh
```

Creates the ECR repository on first run, builds for x86_64, pushes `:latest` and `:<git sha>`.

## 5. IAM role for the task

IAM → Roles → Create → trusted entity *Elastic Container Service Task* → attach `AmazonECSTaskExecutionRolePolicy` → name `mandateTaskExecutionRole`. Add an inline policy allowing `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:mandate/*`.

## 6. Task definition

Edit `deploy/ecs/task-definition.json`: replace `ACCOUNT_ID`, `REGION`, `YOUR_HOSTNAME`, the three `LEGAL_*`/`OPERATOR_EMAILS` values. Then

```bash
aws ecs register-task-definition --cli-input-json file://deploy/ecs/task-definition.json
```

## 7. Cluster, load balancer, service

1. ECS → Clusters → Create → name `mandate`, Fargate only.
2. Certificate Manager → Request → your hostname → DNS validation (add the CNAME it shows at your DNS) → *Issued*.
3. ECS → cluster `mandate` → Services → Create: launch type Fargate, task definition `mandate` (latest revision), service name `app`, desired tasks **1**. Networking: default VPC, all subnets, **public IP on**, new security group `mandate-app` allowing TCP 3000 from the load balancer's group (create it in the next step; the console lets you reference it). Load balancing: **Application Load Balancer**, create new `mandate-alb`, listener **443** with the certificate from step 2, target group `mandate-tg` (port 3000, health check path `/terms`). Create.
4. EC2 → Load Balancers → `mandate-alb` → Attributes → **idle timeout 600 s** (the API proxy streams long responses). Add a listener on 80 that redirects to 443.
5. Security groups: `mandate-db` inbound 5432 from `mandate-app`; `mandate-app` inbound 3000 from the ALB's group; ALB group inbound 80 and 443 from anywhere.
6. DNS: `CNAME` (or Route 53 alias) for your hostname → the ALB's DNS name.

The first task runs migrations on start (the image does `migrate` then `next start`). Watch CloudWatch → Log groups → `/ecs/mandate`.

## 8. Cleanup schedule

EventBridge → Scheduler → Create schedule: rate 1 day; target *Universal* → API destination, or simpler: a tiny Lambda (Node, 10 lines) that does `fetch("https://YOUR_HOSTNAME/api/cron/cleanup", { headers: { authorization: "Bearer " + process.env.CRON_SECRET } })` with `CRON_SECRET` as its environment variable. Either way one daily GET with the bearer.

## 9. Deploying a new version

```bash
AWS_REGION=us-east-1 ./deploy/ecs/push-image.sh
aws ecs update-service --cluster mandate --service app --force-new-deployment
```

Rolling: the new task starts, passes the health check, the old one drains. Migrations run inside the new task before it serves.

## 10. Scaling later

Service → desired count 2 (the app is stateless; rate limits, idempotency and locks all live in Postgres). RDS → modify instance class. Add auto scaling on CPU if you like. Nothing in the code changes.

## Amplify?

Amplify Hosting runs Next.js server code with a 30-second request timeout and no Docker. The API proxy streams for up to five minutes and MCP holds connections open, so Amplify would cut those off. Use Vercel for that shape, ECS or EC2 for AWS.
