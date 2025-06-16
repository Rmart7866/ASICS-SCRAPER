#!/bin/bash

echo "🚀 Starting FAST Render build for ASICS Scraper..."

# Quick install without cache
echo "📦 Fast installing dependencies..."
npm install --no-audit --no-fund --prefer-offline

# Quick check
echo "🔍 Quick dependency check..."
node -e "
try {
  require('express');
  require('puppeteer-core');
  require('pg');
  require('node-cron');
  console.log('✅ All dependencies ready');
} catch (e) {
  console.log('❌ Missing:', e.message);
  process.exit(1);
}
"

echo "✅ Fast build complete"
