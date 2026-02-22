#!/bin/bash

set -e

echo "========================================"
echo "QR Flight Search - Ubuntu Setup Script"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  echo "[!] Running as root - this is fine for setup"
fi

# Detect OS
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
else
  echo "[X] Cannot detect OS. This script supports Ubuntu/Debian."
  exit 1
fi

if [[ "$OS" != "ubuntu" && "$OS" != "debian" ]]; then
  echo "[X] Unsupported OS: $OS. This script supports Ubuntu/Debian only."
  exit 1
fi

echo "[OK] Detected: $OS"
echo ""

# Update apt
echo "[1/7] Updating apt packages..."
apt-get update -qq

# Install curl if not present
if ! command -v curl &> /dev/null; then
  echo "     Installing curl..."
  apt-get install -y -qq curl
fi

# Check Node.js
echo ""
echo "[2/7] Checking Node.js..."
if command -v node &> /dev/null; then
  NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  echo "     Found Node.js v$(node -v)"
  if [ "$NODE_VERSION" -lt 18 ]; then
    echo "     [!] Node.js version too old. Upgrading to v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  fi
else
  echo "     Node.js not found. Installing v20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "     Node.js version: $(node -v)"
echo "     npm version: $(npm -v)"

# Install build essentials (needed for some npm packages)
echo ""
echo "[3/7] Installing build essentials..."
apt-get install -y -qq build-essential

# npm install
echo ""
echo "[4/7] Installing npm dependencies..."
cd "$(dirname "$0")"
npm install --quiet

# Playwright system dependencies
echo ""
echo "[5/7] Installing Playwright system dependencies..."
npx playwright install-deps chromium

# Playwright browser
echo ""
echo "[6/7] Installing Chromium browser..."
npx playwright install chromium

# Check RAM and setup swap if needed
echo ""
echo "[7/7] Checking system memory..."
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
echo "     Total RAM: ${TOTAL_RAM_MB}MB"

if [ "$TOTAL_RAM_MB" -lt 1024 ]; then
  echo "     [!] Low RAM detected. Checking swap..."
  
  SWAP_TOTAL=$(free -m | awk '/Swap:/ {print $2}')
  
  if [ "$SWAP_TOTAL" -lt 1000 ]; then
    echo "     Creating 2GB swap file..."
    
    if [ -f /swapfile ]; then
      echo "     /swapfile exists but swap not active. Enabling..."
      swapon /swapfile 2>/dev/null || echo "     Swap already enabled or failed"
    else
      fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo "/swapfile none swap sw 0 0" >> /etc/fstab
      echo "     Swap file created and enabled"
    fi
  else
    echo "     Swap already configured: ${SWAP_TOTAL}MB"
  fi
else
  echo "     [OK] Sufficient RAM, no swap needed"
fi

# Done
echo ""
echo "========================================"
echo "Setup Complete!"
echo "========================================"
echo ""
echo "To start the server:"
echo "  npm start"
echo ""
echo "For production (low RAM servers):"
echo "  npm run start:prod"
echo ""
echo "App will be available at: http://localhost:3000"
echo ""
