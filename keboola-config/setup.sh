#!/bin/bash
set -Eeuo pipefail

echo "Installing Node dependencies..."
cd /app
npm install --omit=dev
