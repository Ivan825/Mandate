#!/usr/bin/env bash
# Creates or updates the CloudFormation stack. Fill deploy/ecs/params.env first.
#   AWS_REGION=us-east-1 ./deploy/ecs/deploy-stack.sh
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/params.env" ] || { echo "copy deploy/ecs/params.env.example to deploy/ecs/params.env and fill it in"; exit 1; }
set -a; . "$HERE/params.env"; set +a
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
IMAGE="${IMAGE_URI:-$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/mandate:latest}"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name mandate \
  --template-file "$HERE/stack.yml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" SubnetIds="$SUBNET_IDS" VpcCidr="${VPC_CIDR:-172.31.0.0/16}" \
    Hostname="$HOSTNAME_" CertificateArn="$CERTIFICATE_ARN" ImageUri="$IMAGE" \
    LegalOperatorName="$LEGAL_OPERATOR_NAME" LegalContactEmail="$LEGAL_CONTACT_EMAIL" OperatorEmails="$OPERATOR_EMAILS" \
    DesiredCount="${DESIRED_COUNT:-1}" Cpu="${CPU:-512}" Memory="${MEMORY:-1024}" DbInstanceClass="${DB_INSTANCE_CLASS:-db.t4g.micro}"
aws cloudformation describe-stacks --region "$REGION" --stack-name mandate --query "Stacks[0].Outputs" --output table
