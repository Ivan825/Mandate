#!/usr/bin/env bash
# Build the image for Fargate (x86_64) and push it to ECR.
#   AWS_REGION=us-east-1 ./deploy/ecs/push-image.sh
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/mandate"
aws ecr describe-repositories --repository-names mandate --region "$REGION" >/dev/null 2>&1 || aws ecr create-repository --repository-name mandate --region "$REGION" >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker buildx build --platform linux/amd64 -t "$REPO:latest" -t "$REPO:$(git rev-parse --short HEAD)" --push .
echo "pushed $REPO:latest"
