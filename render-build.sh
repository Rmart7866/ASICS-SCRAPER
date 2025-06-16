#!/bin/bash

echo "🚀 Starting SUPER FAST Render build for ASICS Scraper..."

# Skip Playwright browser downloads during install
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Fast install dependencies
echo "📦 Fast installing dependencies (no browser download)..."
npm install --no-audit --no-fund --prefer-offline

# Quick dependency check
echo "🔍 Quick dependency check..."
node -e "
try {
  require('express');
  require('playwright-chromium');
  require('pg');
  require('node-cron');
  console.log('✅ All dependencies ready');
} catch (e) {
  console.log('❌ Missing:', e.message);
  process.exit(1);
}
"

echo "✅ SUPER FAST build complete (no Chrome download needed)"
