#!/bin/bash

echo "🚀 Starting FAST Render build for ASICS Scraper..."

# Fast install dependencies
echo "📦 Fast installing dependencies..."
npm install --no-audit --no-fund --prefer-offline

# Install full Puppeteer with Chrome
echo "🌐 Installing Puppeteer with Chrome..."
npm install puppeteer@21.11.0 --save

# Quick dependency check
echo "🔍 Quick dependency check..."
node -e "
try {
  require('express');
  const puppeteer = require('puppeteer');
  require('pg');
  require('node-cron');
  console.log('✅ All dependencies ready');
  console.log('✅ Puppeteer with Chrome installed');
} catch (e) {
  console.log('❌ Missing:', e.message);
  process.exit(1);
}
"

echo "✅ Fast build complete"
