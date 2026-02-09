#!/usr/bin/env bash
set -euo pipefail

# ContextMate installer
# Usage: curl -fsSL https://raw.githubusercontent.com/<user>/contextmate/main/install.sh | bash

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

info()  { echo -e "${BLUE}==>${RESET} ${BOLD}$1${RESET}"; }
ok()    { echo -e "${GREEN}✓${RESET}  $1"; }
fail()  { echo -e "${RED}✗${RESET}  $1"; exit 1; }

echo ""
echo -e "${BOLD}ContextMate Installer${RESET}"
echo -e "${DIM}Zero-knowledge encrypted sync for AI agent context${RESET}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  fail "Node.js is required but not installed. Install Node.js 20+ from https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  fail "Node.js 20+ is required (found v$(node -v | sed 's/v//')). Update at https://nodejs.org"
fi
ok "Node.js $(node -v) detected"

# Check npm
if ! command -v npm &> /dev/null; then
  fail "npm is required but not installed."
fi
ok "npm $(npm -v) detected"

# Install
info "Installing ContextMate..."
npm install -g contextmate 2>&1 | tail -1
ok "ContextMate installed"

# Initialize
echo ""
info "Initializing vault..."
echo -e "${DIM}You'll be prompted to create an encryption passphrase.${RESET}"
echo ""
contextmate init

echo ""
echo -e "${GREEN}${BOLD}ContextMate is ready!${RESET}"
echo ""
echo -e "  Next steps:"
echo -e "  ${DIM}1.${RESET} Connect an agent:  ${BOLD}contextmate adapter claude init${RESET}"
echo -e "  ${DIM}2.${RESET} Start syncing:     ${BOLD}contextmate daemon start${RESET}"
echo -e "  ${DIM}3.${RESET} Check status:      ${BOLD}contextmate status${RESET}"
echo ""
