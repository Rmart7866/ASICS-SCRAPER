#!/usr/bin/env bash
set -o errexit

echo "🚀 Starting Render build for ASICS Weekly Batch Scraper..."
echo "📊 Available memory: $(free -h | grep Mem: | awk '{print $2}' || echo 'Unknown')"

# Install dependencies with memory optimization
echo "📦 Installing dependencies..."
npm ci --only=production --no-audit --no-fund --prefer-offline

# Verify critical dependencies
echo "🔍 Verifying dependencies..."
node -e "
try {
  require('puppeteer-core');
  require('@sparticuz/chromium');
  require('express');
  require('pg');
  console.log('✅ All critical dependencies verified');
} catch(e) {
  console.error('❌ Dependency verification failed:', e.message);
  process.exit(1);
}
"

echo "✅ Render build complete - ready for weekly batch scraping"
echo "🎯 Optimized for: Starter tier (512MB RAM)"
echo "📅 Designed for: Weekly batches of hundreds of URLs"
