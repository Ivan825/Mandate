#!/usr/bin/env bash
# Run once on a fresh Ubuntu 24.04 EC2 instance (t3.small or larger, 20 GB disk):
#   curl -fsSL https://raw.githubusercontent.com/Ivan825/Mandate/main/deploy/aws/setup-ec2.sh | bash
# Installs Docker, clones the repo into ~/mandate, and leaves you at "fill in .env".
set -euo pipefail
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"
# 2 GB swap so `next build` never runs out of memory on a small instance.
if [ ! -f /swapfile ]; then sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab; fi
[ -d "$HOME/mandate" ] || git clone https://github.com/Ivan825/Mandate.git "$HOME/mandate"
cd "$HOME/mandate"
[ -f .env ] || cp deploy/aws/env.production.example .env
echo
echo "Docker installed. Log out and back in (for docker group), then:"
echo "  cd ~/mandate && nano .env      # fill in every value"
echo "  docker compose -f docker-compose.yml -f deploy/aws/docker-compose.prod.yml up -d --build"
