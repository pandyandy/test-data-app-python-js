#!/bin/bash
set -euo pipefail

echo "Installing dependencies..."
cd /app
uv sync
echo "Setup complete."
