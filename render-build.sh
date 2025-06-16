#!/bin/bash

echo "🚀 Starting Render build for ASICS Weekly Batch Scraper..."
echo "📊 Available memory: 61Gi"

# Clean and install
echo "📦 Installing dependencies..."
rm -rf node_modules package-lock.json

# Install with verbose output
npm install --verbose

# Force install puppeteer if missing
if [ ! -d "node_modules/puppeteer" ]; then
    echo "🔧 Force installing puppeteer..."
    npm install puppeteer@21.11.0 --force
fi

# Quick dependency check
echo "🔍 Verifying dependencies..."
node -e "
const deps = ['express', 'puppeteer', 'pg', 'node-cron'];
deps.forEach(dep => {
  try {
    require(dep);
    console.log('✅', dep);
  } catch (e) {
    console.log('❌', dep, 'MISSING');
    process.exit(1);
  }
});
console.log('✅ All critical dependencies verified');
"

echo "✅ Render build complete - ready for weekly batch scraping"
echo "🎯 Optimized for: Starter tier (512MB RAM)"
echo "📅 Designed for: Weekly batches of hundreds of URLs"
