#!/bin/bash

echo "🚀 Starting SUPER FAST Browserless build for ASICS Scraper..."

# No browser downloads needed - Browserless handles that!
echo "📦 Installing dependencies (no browser downloads)..."
npm install --no-audit --no-fund --prefer-offline

# Quick dependency check
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

echo "✅ SUPER FAST Browserless build complete (no Chrome needed locally!)"
echo "🎭 Browser automation will use Browserless cloud service"
