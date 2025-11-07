#!/bin/bash

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Setting up Twake LDAP Demo Environment${NC}"

# Check if running with sudo
if [ "$EUID" -ne 0 ]; then
    echo -e "${YELLOW}This script needs sudo privileges to modify /etc/hosts${NC}"
    echo "Re-running with sudo..."
    exec sudo bash "$0" "$@"
fi

# Add hosts entries
HOSTS_FILE="/etc/hosts"
HOSTS_ENTRY="127.0.0.1 auth.twake.local manager.twake.local reload.twake.local test1.twake.local test2.twake.local api.twake.local ldap.twake.local"

echo "Adding hosts entries to $HOSTS_FILE..."
if grep -q "twake.local" "$HOSTS_FILE"; then
    echo "twake.local entries already exist in $HOSTS_FILE, skipping..."
else
    echo "$HOSTS_ENTRY" >> "$HOSTS_FILE"
    echo -e "${GREEN}Hosts entries added successfully${NC}"
fi

# Start docker-compose
echo "Starting docker-compose..."
cd "$(dirname "$0")"

# Copy .env.example to .env if .env doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
fi

# Stop and remove existing containers to avoid conflicts
echo "Cleaning up existing containers..."
docker-compose down 2>/dev/null || true

# Build images
echo "Building Docker images..."
docker-compose build

# Start services
docker-compose up -d

echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "Services available at:"
echo "  - LemonLDAP::NG Auth: http://auth.twake.local"
echo "  - LemonLDAP::NG Manager: http://manager.twake.local"
echo "  - LDAP REST API: http://api.twake.local:8081"
echo "  - Test App 1: http://test1.twake.local"
echo "  - Test App 2: http://test2.twake.local"
