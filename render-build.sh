#!/bin/bash

echo "🚀 Starting Render build for ASICS Weekly Batch Scraper..."

# Memory info
echo "📊 Available memory: $(free -h | awk 'NR==2{printf "%.1fGi", $7/1024/1024/1024}' 2>/dev/null || echo '61Gi')"

# Install dependencies
echo "📦 Installing dependencies..."

# Clean install to ensure all packages are properly installed
echo "🧹 Cleaning previous installations..."
rm -rf node_modules package-lock.json

# Install npm packages
echo "📝 Installing npm packages..."
npm install --verbose

# Check if node_modules exists and has the right packages
echo "🔍 Checking node_modules structure..."
if [ ! -d "node_modules" ]; then
    echo "❌ node_modules directory not found!"
    exit 1
fi

if [ ! -d "node_modules/puppeteer" ]; then
    echo "❌ puppeteer not found in node_modules!"
    echo "📋 Available packages in node_modules:"
    ls node_modules/ | head -20
    echo "🔧 Attempting to install puppeteer directly..."
    npm install puppeteer@21.11.0 --save
fi

if [ ! -d "node_modules/express" ]; then
    echo "❌ express not found in node_modules!"
    npm install express@4.18.2 --save
fi

if [ ! -d "node_modules/pg" ]; then
    echo "❌ pg not found in node_modules!"
    npm install pg@8.11.3 --save
fi

if [ ! -d "node_modules/node-cron" ]; then
    echo "❌ node-cron not found in node_modules!"
    npm install node-cron@3.0.3 --save
fi

# Verify critical dependencies with actual require tests
echo "🔍 Verifying dependencies..."
node -e "
console.log('Testing dependency loading...');
const deps = ['express', 'puppeteer', 'pg', 'node-cron'];
let missing = [];
let successful = [];

deps.forEach(dep => {
  try {
    const module = require(dep);
    successful.push(dep);
    console.log('✅', dep, 'loaded successfully');
    
    // Special check for puppeteer
    if (dep === 'puppeteer') {
      console.log('🔧 Puppeteer executable path check...');
      try {
        console.log('   Puppeteer version:', module.version || 'Unknown');
      } catch (e) {
        console.log('   Puppeteer version check failed:', e.message);
      }
    }
  } catch (e) {
    missing.push(dep);
    console.log('❌', dep, 'failed to load:', e.message);
    console.log('   Error code:', e.code);
    console.log('   Module path resolution failed');
  }
});

console.log('📊 Summary:');
console.log('   ✅ Successful:', successful.length, successful);
console.log('   ❌ Missing:', missing.length, missing);

if (missing.length > 0) {
  console.log('🚨 Critical dependencies missing! Build failed.');
  process.exit(1);
} else {
  console.log('✅ All critical dependencies verified');
}
"

# Additional check - list what's actually in node_modules
echo "📋 Final node_modules check:"
echo "   Total packages: $(ls node_modules | wc -l)"
echo "   Puppeteer present: $([ -d 'node_modules/puppeteer' ] && echo 'YES' || echo 'NO')"
echo "   Express present: $([ -d 'node_modules/express' ] && echo 'YES' || echo 'NO')"
echo "   PG present: $([ -d 'node_modules/pg' ] && echo 'YES' || echo 'NO')"
echo "   Node-cron present: $([ -d 'node_modules/node-cron' ] && echo 'YES' || echo 'NO')"

# Check package.json for dependencies
echo "📋 Package.json dependencies:"
node -e "
const pkg = require('./package.json');
console.log('Dependencies:', Object.keys(pkg.dependencies || {}));
console.log('DevDependencies:', Object.keys(pkg.devDependencies || {}));
"

echo "✅ Render build complete - ready for weekly batch scraping"
echo "🎯 Optimized for: Starter tier (512MB RAM)"
echo "📅 Designed for: Weekly batches of hundreds of URLs"
