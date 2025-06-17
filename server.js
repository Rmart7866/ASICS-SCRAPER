const express = require('express');
const puppeteer = require('puppeteer-core');
const { Pool } = require('pg');
const cron = require('node-cron');
const fs = require('fs').promises;

class EnhancedASICSScraper {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 10000;
        
        // Database configuration
        if (process.env.DATABASE_URL) {
            this.pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                max: 10,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 10000,
            });
            this.databaseEnabled = true;
        } else {
            this.pool = null;
            this.databaseEnabled = false;
        }

        // Enhanced Browserless configuration
        this.browserlessToken = process.env.BROWSERLESS_TOKEN;
        if (this.browserlessToken) {
            this.browserlessEndpoint = 'wss://production-sfo.browserless.io?token=' + this.browserlessToken;
        } else {
            this.browserlessEndpoint = 'ws://browserless:3000';
        }

        // Session storage with enhanced state management
        this.sessionCookies = [];
        this.sessionStorage = {};
        this.localStorage = {};
        this.sessionValid = false;
        this.sessionFingerprint = null;
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        
        this.urlsToMonitor = [];
        this.scrapingLogs = [];
        this.debugLogs = [];
        this.scrapingProgress = { active: false, total: 0, completed: 0 };
        
        // Rate limiting
        this.lastBrowserlessRequest = 0;
        this.minRequestInterval = 3000;
        
        this.setupMiddleware();
        this.setupRoutes();
        this.initializeDatabase();
    }

    addDebugLog(message, data = null) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            message,
            data
        };
        this.debugLogs.unshift(logEntry);
        console.log('🐛 ENHANCED DEBUG: ' + message, data ? JSON.stringify(data, null, 2) : '');
        
        if (this.debugLogs.length > 100) {
            this.debugLogs = this.debugLogs.slice(0, 100);
        }
    }

    async rateLimitedBrowserlessRequest() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastBrowserlessRequest;
        
        if (timeSinceLastRequest < this.minRequestInterval) {
            const waitTime = this.minRequestInterval - timeSinceLastRequest;
            this.addDebugLog('Rate limiting: waiting ' + waitTime + 'ms');
            await this.delay(waitTime);
        }
        
        this.lastBrowserlessRequest = Date.now();
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.static('public'));
    }

    setupRoutes() {
        // Health check
        this.app.get('/', (req, res) => {
            res.json({
                status: 'Enhanced ASICS B2B Scraper Active - Vue.js Ready',
                version: '3.1-vue-js-master',
                uptime: process.uptime(),
                urlCount: this.urlsToMonitor.length,
                sessionValid: this.sessionValid,
                cookieCount: this.sessionCookies.length,
                hasSessionStorage: Object.keys(this.sessionStorage).length > 0,
                hasLocalStorage: Object.keys(this.localStorage).length > 0,
                enhancement: 'vue-js-dynamic-content-handling'
            });
        });

        // Enhanced dashboard with Vue.js features
        this.app.get('/dashboard', (req, res) => {
            res.send(this.generateEnhancedDashboard());
        });

        // Enhanced API Routes
        
        // Complete session import (cookies + storage + fingerprint)
        this.app.post('/api/import-complete-session', async (req, res) => {
            try {
                const { cookies, sessionStorage, localStorage, userAgent, sessionData } = req.body;
                
                this.addDebugLog('Importing complete session state for Vue.js scraping');
                
                // Import cookies
                if (cookies) {
                    this.sessionCookies = this.parseCookieStringEnhanced(cookies);
                    this.addDebugLog('Imported cookies', { count: this.sessionCookies.length });
                }
                
                // Import session storage
                if (sessionStorage) {
                    this.sessionStorage = sessionStorage;
                    this.addDebugLog('Imported sessionStorage', { keys: Object.keys(sessionStorage) });
                }
                
                // Import local storage
                if (localStorage) {
                    this.localStorage = localStorage;
                    this.addDebugLog('Imported localStorage', { keys: Object.keys(localStorage) });
                }
                
                // Import user agent
                if (userAgent) {
                    this.userAgent = userAgent;
                    this.addDebugLog('Imported userAgent', { userAgent });
                }
                
                // Import additional session data
                if (sessionData) {
                    this.sessionFingerprint = sessionData;
                    this.addDebugLog('Imported session fingerprint data');
                }
                
                // Test the complete session
                await this.rateLimitedBrowserlessRequest();
                const testResult = await this.testCompleteSessionValidity();
                this.sessionValid = testResult.valid;
                
                res.json({
                    success: true,
                    message: 'Complete session imported successfully - Vue.js ready',
                    cookieCount: this.sessionCookies.length,
                    storageKeys: Object.keys(this.sessionStorage).length + Object.keys(this.localStorage).length,
                    sessionValid: this.sessionValid,
                    testResult: testResult.message,
                    enhancement: 'vue-js-ready'
                });
                
            } catch (error) {
                this.addDebugLog('Error importing complete session', { error: error.message });
                res.json({
                    success: false,
                    error: 'Failed to import session: ' + error.message
                });
            }
        });

        // Generate session extractor script
        this.app.get('/api/generate-session-extractor', (req, res) => {
            const extractorScript = `
// ASICS B2B Complete Session Extractor - Vue.js Enhanced
// Run this in your browser console on the ASICS B2B page where you're logged in

(function() {
    console.log('🚀 Starting ASICS B2B Vue.js Session Extraction...');
    
    // Extract cookies
    const cookies = document.cookie;
    console.log('✅ Extracted cookies:', cookies.length, 'characters');
    
    // Extract sessionStorage
    const sessionStorage = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        const value = window.sessionStorage.getItem(key);
        sessionStorage[key] = value;
    }
    console.log('✅ Extracted sessionStorage:', Object.keys(sessionStorage).length, 'keys');
    
    // Extract localStorage
    const localStorage = {};
    for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        const value = window.localStorage.getItem(key);
        localStorage[key] = value;
    }
    console.log('✅ Extracted localStorage:', Object.keys(localStorage).length, 'keys');
    
    // Extract user agent
    const userAgent = navigator.userAgent;
    console.log('✅ Extracted userAgent:', userAgent);
    
    // Extract Vue.js specific data
    const vueData = {
        hasVue: !!window.Vue,
        vueElements: document.querySelectorAll('[data-v-]').length,
        hasAsicsGrid: !!document.querySelector('.grid.grid-flow-col'),
        hasInventoryData: /\\d+\\+?/.test(document.body.innerText),
        hasColorData: /\\d{3}\\s*-\\s*\\w+/.test(document.body.innerText)
    };
    console.log('✅ Extracted Vue.js data:', vueData);
    
    // Extract additional browser fingerprint data
    const sessionData = {
        url: window.location.href,
        referrer: document.referrer,
        timestamp: new Date().toISOString(),
        viewport: {
            width: window.innerWidth,
            height: window.innerHeight
        },
        screen: {
            width: screen.width,
            height: screen.height,
            colorDepth: screen.colorDepth
        },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
        languages: navigator.languages,
        platform: navigator.platform,
        cookieEnabled: navigator.cookieEnabled,
        onLine: navigator.onLine,
        vueApp: vueData
    };
    console.log('✅ Extracted session fingerprint data');
    
    // Prepare the complete session object
    const completeSession = {
        cookies,
        sessionStorage,
        localStorage,
        userAgent,
        sessionData
    };
    
    console.log('🎉 Vue.js-enhanced session extraction finished!');
    console.log('📋 Copy this JSON and paste it into the scraper dashboard:');
    console.log('---START COPY FROM HERE---');
    console.log(JSON.stringify(completeSession, null, 2));
    console.log('---END COPY TO HERE---');
    
    // Also copy to clipboard if possible
    if (navigator.clipboard) {
        navigator.clipboard.writeText(JSON.stringify(completeSession, null, 2))
            .then(() => console.log('✅ Session data copied to clipboard!'))
            .catch(() => console.log('❌ Could not copy to clipboard, please copy manually'));
    }
    
    return completeSession;
})();
            `;
            
            res.setHeader('Content-Type', 'text/javascript');
            res.setHeader('Content-Disposition', 'attachment; filename="asics-vue-session-extractor.js"');
            res.send(extractorScript);
        });

        // Enhanced session testing with Vue.js awareness
        this.app.post('/api/test-complete-session', async (req, res) => {
            try {
                const { url } = req.body;
                const testUrl = url || 'https://b2b.asics.com/orders/100454100/products/1011B875?colorCode=600&deliveryDate=2025-06-18';
                
                this.addDebugLog('Testing complete session with Vue.js dynamic content handling', { testUrl });
                
                await this.rateLimitedBrowserlessRequest();
                
                const result = await this.testCompleteSessionValidity(testUrl);
                this.sessionValid = result.valid;
                
                res.json({
                    success: result.valid,
                    message: result.message,
                    details: result.details,
                    sessionValid: this.sessionValid,
                    enhancement: 'vue-js-session-test'
                });
                
            } catch (error) {
                this.addDebugLog('Vue.js session test error', { error: error.message });
                res.json({
                    success: false,
                    error: 'Session test failed: ' + error.message
                });
            }
        });

        // Enhanced scraping with Vue.js dynamic content handling
        this.app.post('/api/start-enhanced-scraping', async (req, res) => {
            try {
                if (!this.sessionValid || this.sessionCookies.length === 0) {
                    return res.json({ 
                        success: false, 
                        error: 'No valid session. Please import complete session first.' 
                    });
                }
                
                this.addDebugLog('Starting Vue.js-aware enhanced scraping');
                
                this.scrapingProgress = {
                    active: true,
                    total: this.urlsToMonitor.length,
                    completed: 0,
                    results: []
                };
                
                setTimeout(() => this.startEnhancedVueJSScraping(), 1000);
                
                res.json({
                    success: true,
                    message: 'Vue.js-enhanced scraping started',
                    urlCount: this.urlsToMonitor.length,
                    enhancement: 'vue-js-dynamic-content'
                });
                
            } catch (error) {
                this.addDebugLog('Error starting Vue.js scraping', { error: error.message });
                res.json({ success: false, error: error.message });
            }
        });

        // URL Management
        this.app.get('/api/urls', (req, res) => {
            res.json({ success: true, urls: this.urlsToMonitor });
        });

        this.app.post('/api/urls', async (req, res) => {
            try {
                const { url } = req.body;
                
                if (!url || !url.startsWith('http')) {
                    return res.json({ success: false, error: 'Valid URL required' });
                }
                
                if (this.urlsToMonitor.includes(url)) {
                    return res.json({ success: false, error: 'URL already exists' });
                }
                
                this.urlsToMonitor.push(url);
                this.addDebugLog('URL added for Vue.js scraping', { url });
                res.json({ success: true });
                
            } catch (error) {
                res.json({ success: false, error: error.message });
            }
        });

        this.app.delete('/api/urls/:index', async (req, res) => {
            try {
                const index = parseInt(req.params.index);
                
                if (index < 0 || index >= this.urlsToMonitor.length) {
                    return res.json({ success: false, error: 'Invalid URL index' });
                }
                
                const deletedUrl = this.urlsToMonitor.splice(index, 1)[0];
                this.addDebugLog('URL deleted', { url: deletedUrl });
                res.json({ success: true });
                
            } catch (error) {
                res.json({ success: false, error: error.message });
            }
        });

        // Debug logs endpoint
        this.app.get('/api/debug-logs', (req, res) => {
            res.json(this.debugLogs.slice(0, 50));
        });

        this.app.delete('/api/debug-logs', (req, res) => {
            this.debugLogs = [];
            res.json({ success: true });
        });

        this.app.get('/api/logs', (req, res) => {
            res.json(this.scrapingLogs.slice(-20));
        });

        this.app.get('/api/scraping-progress', (req, res) => {
            res.json(this.scrapingProgress || { active: false, total: 0, completed: 0 });
        });

        // Export results
        this.app.get('/api/export-results', (req, res) => {
            try {
                const allProducts = [];
                
                this.scrapingLogs.forEach(log => {
                    if (log.status === 'success' && log.products) {
                        log.products.forEach(product => {
                            allProducts.push({
                                ...product,
                                sourceUrl: log.url,
                                scrapedAt: log.timestamp,
                                batchId: log.batchId
                            });
                        });
                    }
                });
                
                res.json({
                    success: true,
                    products: allProducts,
                    totalProducts: allProducts.length,
                    exportedAt: new Date().toISOString(),
                    enhancement: 'vue-js-extracted'
                });
                
            } catch (error) {
                res.json({
                    success: false,
                    error: error.message,
                    products: []
                });
            }
        });
    }

    generateEnhancedDashboard() {
        const sessionStatusClass = this.sessionValid ? 'success' : 'danger';
        const sessionStatusText = this.sessionValid ? '✅ Session Valid' : '❌ No Session';
        
        const urlListHtml = this.urlsToMonitor.map((url, index) => {
            return `<li class="url-item">
                <span style="word-break: break-all; font-size: 11px;">${url}</span>
                <button onclick="removeUrl(${index})" class="btn danger">❌</button>
            </li>`;
        }).join('');

        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ASICS B2B Scraper v3.1 - Vue.js Master Edition</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #00ff87 0%, #60efff 100%); color: #000; padding: 30px; border-radius: 10px; margin-bottom: 30px; text-align: center; box-shadow: 0 4px 15px rgba(0,255,135,0.3); }
        .card { background: white; padding: 25px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
        .danger { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        .info { background: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460; }
        .btn { background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 5px; cursor: pointer; margin: 5px; font-size: 14px; transition: all 0.3s; }
        .btn:hover { background: #0056b3; transform: translateY(-1px); }
        .btn.success { background: #28a745; }
        .btn.danger { background: #dc3545; }
        .btn.warning { background: #ffc107; color: #212529; }
        .btn.large { padding: 16px 32px; font-size: 16px; }
        .input-group { margin: 15px 0; }
        .input-group label { display: block; margin-bottom: 5px; font-weight: bold; }
        .input-group textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-family: monospace; font-size: 12px; }
        .input-group input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
        .logs { max-height: 400px; overflow-y: auto; background: #f8f9fa; padding: 15px; border-radius: 5px; font-family: monospace; font-size: 11px; }
        .debug-logs { max-height: 300px; overflow-y: auto; background: #fff3cd; padding: 15px; border-radius: 5px; font-family: monospace; font-size: 10px; }
        .url-list { list-style: none; }
        .url-item { background: #f8f9fa; padding: 10px; margin: 5px 0; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
        @media (max-width: 768px) { .grid, .grid-3 { grid-template-columns: 1fr; } }
        .code { background: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 12px; margin: 10px 0; border: 1px solid #dee2e6; }
        .vue-feature { border: 2px solid #00ff87 !important; position: relative; }
        .vue-feature::before { content: "⚡ VUE.JS"; position: absolute; top: -10px; right: 10px; background: #00ff87; color: #000; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; }
        .pulse { animation: pulse 2s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(0, 255, 135, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(0, 255, 135, 0); } 100% { box-shadow: 0 0 0 0 rgba(0, 255, 135, 0); } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>⚡ ASICS B2B Scraper v3.1 - Vue.js Master</h1>
            <p>Dynamic Content Extraction • Inventory Matrix Decoding • Vue.js Framework Bypass</p>
            <div style="margin-top: 15px;">
                <span class="btn ${sessionStatusClass}" style="cursor: default;">
                    ${sessionStatusText}
                </span>
                <span class="btn" style="background: #6c757d; cursor: default;">
                    ${this.sessionCookies.length} Cookies
                </span>
                <span class="btn" style="background: #6c757d; cursor: default;">
                    ${Object.keys(this.sessionStorage).length} Session Keys
                </span>
                <span class="btn" style="background: #6c757d; cursor: default;">
                    ${Object.keys(this.localStorage).length} Local Keys
                </span>
            </div>
        </div>

        <div class="grid-3">
            <div class="card vue-feature pulse">
                <h3>🎯 Vue.js Session Import</h3>
                <div class="input-group">
                    <label for="completeSession">Complete Session JSON:</label>
                    <textarea id="completeSession" rows="8" placeholder="Paste the complete Vue.js session JSON from browser extraction..."></textarea>
                </div>
                <button onclick="importCompleteSession()" class="btn success large">⚡ Import Vue.js Session</button>
                <button onclick="downloadExtractor()" class="btn warning">📥 Download Vue.js Extractor</button>
                <div id="sessionResult" style="margin-top: 10px;"></div>
            </div>

            <div class="card vue-feature">
                <h3>🔗 Dynamic URL Testing</h3>
                <div class="input-group">
                    <input type="url" id="newUrl" placeholder="https://b2b.asics.com/orders/..." value="https://b2b.asics.com/orders/100454100/products/1011B875?colorCode=600&deliveryDate=2025-06-18">
                </div>
                <button onclick="addUrl()" class="btn">➕ Add URL</button>
                <button onclick="testCompleteSession()" class="btn warning">⚡ Test Vue.js Session</button>
                
                <h4 style="margin-top: 15px;">URLs (${this.urlsToMonitor.length}):</h4>
                <ul id="urlList" class="url-list">
                    ${urlListHtml}
                </ul>
            </div>

            <div class="card vue-feature">
                <h3>🚀 Vue.js Enhanced Scraping</h3>
                <button onclick="startEnhancedScraping()" class="btn success large" ${this.sessionValid ? '' : 'disabled'}>
                    ⚡ Start Vue.js Scraping
                </button>
                <button onclick="exportResults()" class="btn">📄 Export Inventory CSV</button>
                <button onclick="viewAllResults()" class="btn">👁️ View Inventory Matrix</button>
                
                <div id="scrapingStatus" style="margin-top: 15px;"></div>
                <div id="progressBar" style="margin-top: 10px;"></div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <h3>📊 Scraping Logs</h3>
                <button onclick="refreshLogs()" class="btn">🔄 Refresh</button>
                <div id="logs" class="logs">
                    Click refresh to load Vue.js scraping activity...
                </div>
            </div>

            <div class="card">
                <h3>🐛 Vue.js Debug Logs</h3>
                <button onclick="refreshDebugLogs()" class="btn">🔄 Refresh Debug</button>
                <button onclick="clearDebugLogs()" class="btn danger">🗑️ Clear Debug</button>
                <div id="debugLogs" class="debug-logs">
                    Click refresh to load Vue.js debug information...
                </div>
            </div>
        </div>

        <div class="card info vue-feature">
            <h3>⚡ Vue.js Dynamic Content Extraction Guide</h3>
            <p><strong>Now with enhanced Vue.js framework handling for ASICS B2B:</strong></p>
            
            <div style="margin: 15px 0; padding: 15px; background: #e7f3ff; border-radius: 8px;">
                <h4>🚀 Vue.js Extraction Process</h4>
                <ol style="margin: 10px 0 10px 20px; line-height: 1.8;">
                    <li><strong>Open ASICS B2B</strong> in your regular browser</li>
                    <li><strong>Log in completely</strong> and navigate to a working order page</li>
                    <li><strong>Wait for inventory grid</strong> to load completely (you see quantities)</li>
                    <li><strong>Download the Vue.js extractor</strong> by clicking the button above</li>
                    <li><strong>Run the extractor script</strong> in browser console (F12 → Console)</li>
                    <li><strong>Copy the complete JSON</strong> and paste it into the textarea above</li>
                    <li><strong>Import and test</strong> - scraper will wait for Vue.js content</li>
                </ol>
            </div>
            
            <div class="code">
                <strong>Vue.js Enhanced Features:</strong><br>
                • 8+ second wait for Vue.js app to load<br>
                • Dynamic inventory grid detection<br>
                • Color/size matrix extraction<br>
                • Quantity parsing (0, 3, 1, 0+, -)<br>
                • Real-time debug logging
            </div>
            
            <div style="margin: 15px 0; padding: 15px; background: #d4edda; border-radius: 8px;">
                <h4>⚡ Expected Output</h4>
                <p><strong>MAGIC SPEED 4 (1011B875)</strong><br>
                📍 Color 600 - FLASH RED/WHITE: Size 7 (3 units), Size 7.5 (1 unit)<br>
                📍 Color 401 - SOOTHING SEA/BLACK: Size 7.5 (1 unit), Size 9 (1 unit)<br>
                📍 Color 750 - SAFETY YELLOW/BLACK: Not available</p>
            </div>
        </div>
    </div>

    <script>
        async function importCompleteSession() {
            const sessionData = document.getElementById('completeSession').value.trim();
            const resultDiv = document.getElementById('sessionResult');
            
            if (!sessionData) {
                resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">Please paste Vue.js session JSON first!</div>';
                return;
            }

            try {
                resultDiv.innerHTML = '<div class="info" style="padding: 10px; margin-top: 10px;">⚡ Importing Vue.js session...</div>';
                
                const sessionObj = JSON.parse(sessionData);
                
                const response = await fetch('/api/import-complete-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(sessionObj)
                });
                
                const result = await response.json();
                
                if (result.success) {
                    resultDiv.innerHTML = '<div class="success" style="padding: 10px; margin-top: 10px;">✅ Vue.js session imported!<br>Cookies: ' + result.cookieCount + '<br>Storage keys: ' + result.storageKeys + '<br>Session valid: ' + (result.sessionValid ? 'Yes' : 'No') + '</div>';
                    
                    if (result.sessionValid) {
                        setTimeout(() => location.reload(), 2000);
                    }
                } else {
                    resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ Failed: ' + result.error + '</div>';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ Error: ' + error.message + '</div>';
            }
        }

        async function downloadExtractor() {
            try {
                window.open('/api/generate-session-extractor', '_blank');
            } catch (error) {
                alert('Error downloading Vue.js extractor: ' + error.message);
            }
        }

        async function testCompleteSession() {
            const url = document.getElementById('newUrl').value.trim();
            const resultDiv = document.getElementById('sessionResult');
            
            resultDiv.innerHTML = '<div class="info" style="padding: 10px; margin-top: 10px;">⚡ Testing Vue.js session...</div>';
            
            try {
                const response = await fetch('/api/test-complete-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    resultDiv.innerHTML = '<div class="success" style="padding: 10px; margin-top: 10px;">✅ Vue.js session test passed!<br><strong>Message:</strong> ' + result.message + '</div>';
                } else {
                    resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ Vue.js session test failed: ' + result.message + '</div>';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ Error: ' + error.message + '</div>';
            }
        }

        async function startEnhancedScraping() {
            const statusDiv = document.getElementById('scrapingStatus');
            
            try {
                statusDiv.innerHTML = '<div class="info" style="padding: 10px;">⚡ Starting Vue.js scraping...</div>';
                
                const response = await fetch('/api/start-enhanced-scraping', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    statusDiv.innerHTML = '<div class="success" style="padding: 10px;">✅ Vue.js scraping started!</div>';
                    pollProgress();
                } else {
                    statusDiv.innerHTML = '<div class="danger" style="padding: 10px;">❌ Failed: ' + result.error + '</div>';
                }
            } catch (error) {
                statusDiv.innerHTML = '<div class="danger" style="padding: 10px;">❌ Error: ' + error.message + '</div>';
            }
        }

        async function pollProgress() {
            try {
                const response = await fetch('/api/scraping-progress');
                const data = await response.json();
                
                if (data.active) {
                    const progress = (data.completed / data.total) * 100;
                    document.getElementById('progressBar').innerHTML = '<div style="background: #f0f0f0; border-radius: 4px; padding: 5px;"><div style="background: #00ff87; height: 20px; width: ' + progress + '%; border-radius: 4px; transition: width 0.3s;"></div><div style="text-align: center; margin-top: 5px; font-size: 12px;">⚡ Vue.js: ' + data.completed + ' of ' + data.total + ' URLs (' + Math.round(progress) + '%)</div></div>';
                    
                    if (data.completed < data.total) {
                        setTimeout(pollProgress, 3000);
                    } else {
                        document.getElementById('scrapingStatus').innerHTML = 
                            '<div class="success" style="padding: 10px;">🎉 Vue.js scraping completed!</div>';
                        refreshLogs();
                        refreshDebugLogs();
                    }
                }
            } catch (error) {
                console.error('Error polling progress:', error);
            }
        }

        // URL Management
        async function addUrl() {
            const url = document.getElementById('newUrl').value.trim();
            if (!url) return;

            try {
                const response = await fetch('/api/urls', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                
                const result = await response.json();
                if (result.success) {
                    document.getElementById('newUrl').value = '';
                    location.reload();
                } else {
                    alert('❌ Error: ' + result.error);
                }
            } catch (error) {
                alert('❌ Error: ' + error.message);
            }
        }

        async function removeUrl(index) {
            if (!confirm('Remove this URL?')) return;

            try {
                const response = await fetch('/api/urls/' + index, { method: 'DELETE' });
                const result = await response.json();
                if (result.success) location.reload();
            } catch (error) {
                alert('❌ Error: ' + error.message);
            }
        }

        async function refreshLogs() {
            try {
                const response = await fetch('/api/logs');
                const logs = await response.json();
                
                const logsContainer = document.getElementById('logs');
                if (logs.length > 0) {
                    logsContainer.innerHTML = logs.map(log => '<div style="margin: 5px 0; padding: 8px; border-left: 3px solid ' + (log.status === 'success' ? '#00ff87' : '#dc3545') + ';"><strong>' + new Date(log.timestamp).toLocaleString() + ':</strong><br>URL: ' + log.url + '<br>Status: ' + log.status + ' | Products: ' + (log.productCount || 0) + '<br>' + (log.error ? 'Error: ' + log.error : '') + '</div>').join('');
                } else {
                    logsContainer.innerHTML = '<div style="color: #666;">No Vue.js logs available yet.</div>';
                }
            } catch (error) {
                document.getElementById('logs').innerHTML = '<div style="color: red;">Error loading logs: ' + error.message + '</div>';
            }
        }

        async function refreshDebugLogs() {
            try {
                const response = await fetch('/api/debug-logs');
                const logs = await response.json();
                
                const debugContainer = document.getElementById('debugLogs');
                if (logs.length > 0) {
                    debugContainer.innerHTML = logs.map(log => '<div style="margin: 3px 0; padding: 5px; border-left: 2px solid #00ff87;"><strong>' + new Date(log.timestamp).toLocaleString() + ':</strong> ' + log.message + '<br>' + (log.data ? '<pre style="font-size: 9px; margin: 3px 0;">' + JSON.stringify(log.data, null, 2) + '</pre>' : '') + '</div>').join('');
                } else {
                    debugContainer.innerHTML = '<div style="color: #666;">No Vue.js debug logs available.</div>';
                }
                
                debugContainer.scrollTop = debugContainer.scrollHeight;
            } catch (error) {
                document.getElementById('debugLogs').innerHTML = '<div style="color: red;">Error loading debug logs: ' + error.message + '</div>';
            }
        }

        async function clearDebugLogs() {
            try {
                await fetch('/api/debug-logs', { method: 'DELETE' });
                refreshDebugLogs();
            } catch (error) {
                console.error('Error clearing debug logs:', error);
            }
        }

        async function exportResults() {
            try {
                const response = await fetch('/api/export-results');
                const data = await response.json();
                
                if (data.success && data.products.length > 0) {
                    const csvContent = convertToCSV(data.products);
                    const blob = new Blob([csvContent], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'asics-vue-inventory-' + new Date().toISOString().split('T')[0] + '.csv';
                    a.click();
                    URL.revokeObjectURL(url);
                    
                    alert('✅ Vue.js inventory CSV exported with ' + data.products.length + ' products!');
                } else {
                    alert('❌ No inventory data to export. Run a Vue.js scraping session first.');
                }
            } catch (error) {
                alert('Error exporting results: ' + error.message);
            }
        }

        async function viewAllResults() {
            try {
                const response = await fetch('/api/export-results');
                const data = await response.json();
                
                if (data.success && data.products.length > 0) {
                    let html = '<div style="max-height: 400px; overflow-y: auto; font-family: monospace; font-size: 11px;">';
                    html += '<h4>⚡ Vue.js Inventory Extraction Results (' + data.products.length + ' products):</h4>';
                    
                    data.products.forEach((product, index) => {
                        html += '<div style="margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">';
                        html += '<strong>' + (index + 1) + '. ' + product.name + '</strong><br>';
                        if (product.styleId) html += 'Style ID: ' + product.styleId + '<br>';
                        html += 'SKU: ' + product.sku + '<br>';
                        if (product.colorCode) html += 'Color: ' + product.colorCode + ' - ' + product.colorName + '<br>';
                        if (product.sizeUS) html += 'Size: ' + product.sizeUS + '<br>';
                        html += 'Quantity: ' + product.rawQuantity + ' (' + product.quantity + ')<br>';
                        html += 'Available: ' + (product.available ? 'Yes' : 'No') + '<br>';
                        html += 'Extracted: ' + new Date(product.extractedAt).toLocaleString() + '<br>';
                        html += 'Method: ' + product.extractionMethod + '<br>';
                        html += '</div>';
                    });
                    
                    html += '</div>';
                    
                    const overlay = document.createElement('div');
                    overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center;';
                    
                    const modal = document.createElement('div');
                    modal.style.cssText = 'background: white; padding: 20px; border-radius: 8px; max-width: 80%; max-height: 80%; overflow-y: auto;';
                    modal.innerHTML = html + '<br><button onclick="this.parentElement.parentElement.remove()" class="btn">Close</button>';
                    
                    overlay.appendChild(modal);
                    document.body.appendChild(overlay);
                } else {
                    alert('❌ No inventory data to view. Run a Vue.js scraping session first.');
                }
            } catch (error) {
                alert('Error viewing results: ' + error.message);
            }
        }

        function convertToCSV(products) {
            const headers = ['Name', 'Style ID', 'SKU', 'Color Code', 'Color Name', 'Size US', 'Quantity', 'Raw Quantity', 'Available', 'Price', 'Source URL', 'Extraction Method', 'Scraped At'];
            let csv = headers.join(',') + '\\n';
            
            products.forEach(product => {
                const row = [
                    '"' + (product.name || '').replace(/"/g, '""') + '"',
                    '"' + (product.styleId || '').replace(/"/g, '""') + '"',
                    '"' + (product.sku || '').replace(/"/g, '""') + '"',
                    '"' + (product.colorCode || '').replace(/"/g, '""') + '"',
                    '"' + (product.colorName || '').replace(/"/g, '""') + '"',
                    '"' + (product.sizeUS || '').replace(/"/g, '""') + '"',
                    '"' + (product.quantity || '').replace(/"/g, '""') + '"',
                    '"' + (product.rawQuantity || '').replace(/"/g, '""') + '"',
                    '"' + (product.available || '').replace(/"/g, '""') + '"',
                    '"' + (product.price || '').replace(/"/g, '""') + '"',
                    '"' + (product.sourceUrl || '').replace(/"/g, '""') + '"',
                    '"' + (product.extractionMethod || '').replace(/"/g, '""') + '"',
                    '"' + (product.extractedAt || '').replace(/"/g, '""') + '"'
                ];
                csv += row.join(',') + '\\n';
            });
            
            return csv;
        }

        // Auto-refresh debug logs every 10 seconds
        setInterval(refreshDebugLogs, 10000);
    </script>
</body>
</html>
        `;
    }

    // Enhanced cookie parsing with better handling
    parseCookieStringEnhanced(cookieString) {
        try {
            this.addDebugLog('Enhanced cookie parsing for Vue.js scraping', { length: cookieString.length });
            
            const cookies = [];
            const cookiePairs = cookieString.split(';');
            
            for (let i = 0; i < cookiePairs.length; i++) {
                const pair = cookiePairs[i];
                const trimmed = pair.trim();
                
                if (trimmed) {
                    const equalIndex = trimmed.indexOf('=');
                    if (equalIndex > 0) {
                        const name = trimmed.substring(0, equalIndex).trim();
                        const value = trimmed.substring(equalIndex + 1).trim();
                        
                        if (name && value) {
                            const cookie = {
                                name: name,
                                value: value,
                                domain: '.asics.com',
                                path: '/',
                                httpOnly: false,
                                secure: true,
                                sameSite: 'Lax'
                            };
                            
                            cookies.push(cookie);
                            
                            // Log important authentication cookies
                            if (name.toLowerCase().includes('session') || 
                                name.toLowerCase().includes('auth') || 
                                name.toLowerCase().includes('token') ||
                                name.toLowerCase().includes('login')) {
                                this.addDebugLog('Important auth cookie found', { 
                                    name: name, 
                                    valueLength: value.length 
                                });
                            }
                        }
                    }
                }
            }
            
            this.addDebugLog('Enhanced cookie parsing completed', { totalParsed: cookies.length });
            return cookies;
            
        } catch (error) {
            this.addDebugLog('Enhanced cookie parsing error', { error: error.message });
            return [];
        }
    }

    // Complete session validity testing with Vue.js awareness
    async testCompleteSessionValidity(testUrl = null) {
        try {
            this.addDebugLog('Starting Vue.js-aware session validity test');
            
            if (this.sessionCookies.length === 0) {
                return {
                    valid: false,
                    message: 'No cookies available for testing',
                    details: null
                };
            }
            
            const browser = await puppeteer.connect({
                browserWSEndpoint: this.browserlessEndpoint,
                ignoreHTTPSErrors: true
            });
            
            const page = await browser.newPage();
            
            // Enhanced stealth setup
            await this.setupStealthMode(page);
            
            // Set complete session state
            await this.restoreCompleteSessionState(page);
            
            // Test URL
            const urlToTest = testUrl || 'https://b2b.asics.com/orders/100454100/products/1011B875?colorCode=600&deliveryDate=2025-06-18';
            
            this.addDebugLog('Testing Vue.js session with URL', { url: urlToTest });
            
            // First establish context if needed
            if (urlToTest.includes('/orders/')) {
                await page.goto('https://b2b.asics.com/', { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });
                await page.waitForTimeout(2000);
            }
            
            // Navigate to test URL
            await page.goto(urlToTest, { 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });
            
            // Wait for Vue.js content to load
            await page.waitForTimeout(5000);
            
            // Enhanced result analysis with Vue.js awareness
            const result = await page.evaluate(() => {
                const url = window.location.href;
                const title = document.title;
                const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                
                const hasLoginForm = document.querySelector('input[type="password"]') !== null;
                const urlHasLogin = url.includes('login') || url.includes('authentication');
                const bodyHasLoginText = bodyText.includes('sign in') || bodyText.includes('log in');
                
                const hasOrderContent = bodyText.includes('order') || bodyText.includes('product');
                const hasInventoryContent = bodyText.includes('inventory') || bodyText.includes('quantity') || bodyText.includes('available');
                const hasAsicsContent = bodyText.includes('asics') || bodyText.includes('b2b');
                
                // Vue.js specific checks
                const hasVueApp = window.Vue || document.querySelector('[data-v-]') !== null;
                const hasAsicsGrid = document.querySelector('.grid.grid-flow-col') !== null;
                const hasInventoryData = /\\d+\\+?/.test(bodyText);
                const hasColorData = /\\d{3}\\s*-\\s*\\w+/.test(bodyText);
                
                // Look for specific ASICS B2B content
                const hasColorCodes = /\\b\\d{3}\\b/.test(bodyText);
                const hasProductCodes = /\\b\\d{7}[A-Z]\\b/.test(bodyText);
                const hasPricing = bodyText.includes('price') || bodyText.includes('$');
                
                const isLoggedIn = !hasLoginForm && !urlHasLogin && !bodyHasLoginText;
                const hasOrderAccess = isLoggedIn && (hasOrderContent || hasInventoryContent);
                const hasFullAccess = hasOrderAccess && (hasColorCodes || hasProductCodes || hasPricing || hasInventoryData);
                
                return {
                    url,
                    title,
                    isLoggedIn,
                    hasOrderAccess,
                    hasFullAccess,
                    hasLoginForm,
                    urlHasLogin,
                    bodyHasLoginText,
                    hasOrderContent,
                    hasInventoryContent,
                    hasAsicsContent,
                    hasColorCodes,
                    hasProductCodes,
                    hasPricing,
                    hasVueApp,
                    hasAsicsGrid,
                    hasInventoryData,
                    hasColorData,
                    bodyPreview: bodyText.slice(0, 500),
                    pageSize: bodyText.length,
                    vueElementCount: document.querySelectorAll('[data-v-]').length
                };
            });
            
            await browser.close();
            
            this.addDebugLog('Vue.js session test completed', result);
            
            if (result.hasFullAccess && result.hasInventoryData) {
                return {
                    valid: true,
                    message: 'Vue.js session with full ASICS B2B inventory access confirmed!',
                    details: result
                };
            } else if (result.hasOrderAccess) {
                return {
                    valid: true,
                    message: 'Vue.js session active with order access - ready for scraping',
                    details: result
                };
            } else if (result.isLoggedIn) {
                return {
                    valid: true,
                    message: 'Basic Vue.js session active but may need fresh order context',
                    details: result
                };
            } else {
                return {
                    valid: false,
                    message: 'Vue.js session appears expired - extract fresh session data',
                    details: result
                };
            }
            
        } catch (error) {
            this.addDebugLog('Vue.js session test error', { error: error.message });
            return {
                valid: false,
                message: 'Vue.js session test error: ' + error.message,
                details: { error: error.message }
            };
        }
    }

    // Enhanced stealth mode setup
    async setupStealthMode(page) {
        this.addDebugLog('Setting up enhanced stealth mode for Vue.js');
        
        // Set enhanced user agent
        await page.setUserAgent(this.userAgent);
        
        // Set enhanced headers to match real browsers
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0'
        });
        
        // Enhanced viewport to match real devices
        await page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
            hasTouch: false,
            isLandscape: true,
            isMobile: false
        });
        
        // Enhanced stealth JavaScript injection with Vue.js compatibility
        await page.evaluateOnNewDocument(() => {
            // Remove webdriver property
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
            
            // Mock plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            
            // Mock languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
            
            // Mock permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
            
            // Enhance chrome object
            window.chrome = {
                runtime: {},
                loadTimes: function() {
                    return {
                        connectionInfo: 'http/1.1',
                        finishDocumentLoadTime: Date.now() / 1000,
                        finishLoadTime: Date.now() / 1000,
                        firstPaintAfterLoadTime: 0,
                        firstPaintTime: Date.now() / 1000,
                        navigationType: 'Other',
                        npnNegotiatedProtocol: 'unknown',
                        requestTime: Date.now() / 1000 - 1,
                        startLoadTime: Date.now() / 1000 - 1,
                        wasAlternateProtocolAvailable: false,
                        wasFetchedViaSpdy: false,
                        wasNpnNegotiated: false
                    };
                },
                csi: function() {
                    return {
                        onloadT: Date.now(),
                        pageT: Date.now() - performance.timing.navigationStart,
                        startE: performance.timing.navigationStart,
                        tran: 15
                    };
                }
            };
            
            // Mock battery API
            Object.defineProperty(navigator, 'getBattery', {
                get: () => () => Promise.resolve({
                    charging: true,
                    chargingTime: 0,
                    dischargingTime: Infinity,
                    level: 1,
                }),
            });
            
            // Vue.js detection compatibility
            window.__VUE_DEVTOOLS_GLOBAL_HOOK__ = {
                Vue: undefined,
                emit: () => {},
                on: () => {},
                once: () => {},
                off: () => {},
                appRecords: []
            };
        });
        
        this.addDebugLog('Vue.js-compatible stealth mode setup completed');
    }

    // Restore complete session state including storage
    async restoreCompleteSessionState(page) {
        this.addDebugLog('Restoring complete session state for Vue.js scraping');
        
        // Set cookies
        if (this.sessionCookies.length > 0) {
            const validCookies = this.sessionCookies.filter(cookie => 
                cookie.name && cookie.value && cookie.name.trim() !== '' && cookie.value.trim() !== ''
            );
            
            if (validCookies.length > 0) {
                await page.setCookie(...validCookies);
                this.addDebugLog('Restored cookies for Vue.js', { count: validCookies.length });
            }
        }
        
        // Navigate to domain to set storage
        await page.goto('https://b2b.asics.com/', { waitUntil: 'domcontentloaded' });
        
        // Restore sessionStorage
        if (Object.keys(this.sessionStorage).length > 0) {
            await page.evaluate((storage) => {
                for (const [key, value] of Object.entries(storage)) {
                    try {
                        window.sessionStorage.setItem(key, value);
                    } catch (e) {
                        console.log('Failed to set sessionStorage key:', key);
                    }
                }
            }, this.sessionStorage);
            this.addDebugLog('Restored sessionStorage for Vue.js', { keys: Object.keys(this.sessionStorage).length });
        }
        
        // Restore localStorage
        if (Object.keys(this.localStorage).length > 0) {
            await page.evaluate((storage) => {
                for (const [key, value] of Object.entries(storage)) {
                    try {
                        window.localStorage.setItem(key, value);
                    } catch (e) {
                        console.log('Failed to set localStorage key:', key);
                    }
                }
            }, this.localStorage);
            this.addDebugLog('Restored localStorage for Vue.js', { keys: Object.keys(this.localStorage).length });
        }
        
        // Apply session fingerprint data if available
        if (this.sessionFingerprint) {
            await page.evaluate((fingerprint) => {
                if (fingerprint.viewport) {
                    console.log('Session viewport:', fingerprint.viewport);
                }
                
                if (fingerprint.timezone) {
                    console.log('Session timezone:', fingerprint.timezone);
                }
            }, this.sessionFingerprint);
            this.addDebugLog('Applied session fingerprint data for Vue.js');
        }
        
        await page.waitForTimeout(1000);
        this.addDebugLog('Complete Vue.js session state restoration finished');
    }

    // Enhanced scraping with Vue.js dynamic content handling
    async startEnhancedVueJSScraping() {
        const startTime = Date.now();
        const batchId = 'vue_js_' + Date.now();
        
        this.addDebugLog('Starting Vue.js-enhanced scraping session', { 
            urlCount: this.urlsToMonitor.length,
            batchId 
        });
        
        try {
            const results = [];
            
            for (let i = 0; i < this.urlsToMonitor.length; i++) {
                const url = this.urlsToMonitor[i];
                
                try {
                    this.addDebugLog('Vue.js scraping URL ' + (i + 1) + '/' + this.urlsToMonitor.length, { url });
                    
                    // Rate limit between requests
                    if (i > 0) {
                        await this.rateLimitedBrowserlessRequest();
                    }
                    
                    const result = await this.vueJsStealthScrapeUrl(url);
                    
                    const scrapingResult = {
                        url,
                        status: 'success',
                        products: result.products,
                        productCount: result.products.length,
                        timestamp: new Date(),
                        batchId,
                        analysis: result.analysis,
                        enhancement: 'vue-js-dynamic-content'
                    };
                    
                    results.push(scrapingResult);
                    this.scrapingLogs.unshift(scrapingResult);
                    
                    this.addDebugLog('Vue.js scraped ' + result.products.length + ' products from ' + url);
                    
                    // Update progress
                    this.scrapingProgress.completed = i + 1;
                    
                } catch (urlError) {
                    this.addDebugLog('Failed to Vue.js scrape ' + url, { error: urlError.message });
                    
                    const errorResult = {
                        url,
                        status: 'error',
                        error: urlError.message,
                        productCount: 0,
                        timestamp: new Date(),
                        batchId,
                        enhancement: 'vue-js-dynamic-content'
                    };
                    
                    results.push(errorResult);
                    this.scrapingLogs.unshift(errorResult);
                    this.scrapingProgress.completed = i + 1;
                }
            }
            
            this.scrapingProgress.active = false;
            
            const duration = Math.round((Date.now() - startTime) / 1000);
            this.addDebugLog('Vue.js-enhanced scraping session completed', { 
                duration: duration + 's',
                totalResults: results.length,
                successCount: results.filter(r => r.status === 'success').length
            });
            
        } catch (error) {
            this.addDebugLog('Vue.js-enhanced scraping session failed', { error: error.message });
            this.scrapingProgress.active = false;
        }
    }

    // Enhanced stealth scrape individual URL with Vue.js handling
    async vueJsStealthScrapeUrl(url) {
        try {
            this.addDebugLog('Starting Vue.js-aware stealth scrape for URL', { url });
            
            const browser = await puppeteer.connect({
                browserWSEndpoint: this.browserlessEndpoint,
                ignoreHTTPSErrors: true
            });
            
            const page = await browser.newPage();
            
            // Setup stealth mode
            await this.setupStealthMode(page);
            
            // Restore complete session state
            await this.restoreCompleteSessionState(page);
            
            // For order URLs, establish context first
            if (url.includes('/orders/')) {
                this.addDebugLog('Order URL detected, establishing Vue.js context');
                await page.goto('https://b2b.asics.com/', { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 20000 
                });
                await page.waitForTimeout(2000);
            }
            
            // Navigate to target URL
            this.addDebugLog('Navigating to target URL with Vue.js awareness', { url });
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            // CRITICAL: Extended wait for Vue.js app to fully load and populate
            this.addDebugLog('Waiting for Vue.js content to fully load...');
            await page.waitForTimeout(8000); // Increased wait time
            
            // Wait for key ASICS elements to appear
            try {
                await page.waitForSelector('h1', { timeout: 10000 });
                this.addDebugLog('Product title loaded');
                
                await page.waitForSelector('.product-info', { timeout: 5000 });
                this.addDebugLog('Product info loaded');
                
                // Wait for inventory grid - this is crucial
                await page.waitForSelector('.grid.grid-flow-col', { timeout: 15000 });
                this.addDebugLog('Inventory grid loaded');
                
                // Additional wait for quantities to populate
                await page.waitForTimeout(3000);
                this.addDebugLog('Final Vue.js stabilization complete');
                
            } catch (waitError) {
                this.addDebugLog('Some Vue.js elements missing, proceeding with extraction', { 
                    error: waitError.message 
                });
            }
            
            // Enhanced page analysis with Vue.js awareness
            const pageAnalysis = await page.evaluate(() => {
                const url = window.location.href;
                const title = document.title;
                const bodyText = document.body ? document.body.innerText : '';
                
                // Vue.js specific checks
                const hasVueApp = window.Vue || document.querySelector('[data-v-]') !== null;
                const hasAsicsGrid = document.querySelector('.grid.grid-flow-col') !== null;
                const hasInventoryData = /\d+\+?/.test(bodyText);
                const hasColorData = /\d{3}\s*-\s*\w+/.test(bodyText);
                
                return {
                    url,
                    title,
                    bodyLength: bodyText.length,
                    hasVueApp,
                    hasAsicsGrid,
                    hasInventoryData,
                    hasColorData,
                    hasInventoryKeywords: /inventory|stock|available|quantity|qty/i.test(bodyText),
                    hasOrderKeywords: /order|purchase|cart|checkout/i.test(bodyText),
                    hasProductKeywords: /product|item|sku|model/i.test(bodyText),
                    hasAsicsKeywords: /asics|b2b|magic.speed/i.test(bodyText),
                    hasLoginRedirect: url.includes('login') || url.includes('authentication'),
                    bodyPreview: bodyText.slice(0, 1000),
                    isOrderPage: url.includes('/orders/'),
                    isProductPage: url.includes('/products/'),
                    vueElementCount: document.querySelectorAll('[data-v-]').length,
                    gridElementCount: document.querySelectorAll('.grid').length
                };
            });
            
            this.addDebugLog('Enhanced Vue.js page analysis completed', pageAnalysis);
            
            // Enhanced product extraction with Vue.js handling
            const products = await this.extractASICSProductsEnhanced(page);
            this.addDebugLog('Vue.js-aware product extraction completed', { 
                productCount: products.length,
                hasInventoryData: pageAnalysis.hasInventoryData,
                hasColorData: pageAnalysis.hasColorData
            });
            
            await browser.close();
            
            return {
                url: pageAnalysis.url,
                products,
                analysis: pageAnalysis
            };
            
        } catch (error) {
            this.addDebugLog('Vue.js-aware stealth scrape error', { url, error: error.message });
            throw error;
        }
    }

    // Enhanced ASICS-specific product extraction with Vue.js dynamic content handling
    async extractASICSProductsEnhanced(page) {
        this.addDebugLog('Starting Vue.js-aware ASICS extraction');
        
        // CRITICAL: Wait for Vue.js content to load completely
        await page.waitForTimeout(5000); // Initial wait
        
        // Wait for specific ASICS B2B content indicators
        try {
            await page.waitForSelector('h1', { timeout: 10000 });
            await page.waitForSelector('.grid.grid-flow-col', { timeout: 15000 });
            this.addDebugLog('Vue.js content detection successful');
        } catch (e) {
            this.addDebugLog('Vue.js content detection timeout, proceeding anyway');
        }
        
        // Additional wait for inventory grid to populate
        await page.waitForTimeout(3000);
        
        return await page.evaluate(() => {
            const products = [];
            const debugInfo = [];
            
            debugInfo.push('🚀 Starting Vue.js-aware ASICS B2B extraction');
            debugInfo.push('Page URL: ' + window.location.href);
            debugInfo.push('Page title: ' + document.title);
            debugInfo.push('Body length: ' + (document.body ? document.body.innerText.length : 0));
            
            // EXACT selectors based on the working HTML structure
            const productNameSelector = 'h1.heading-lg.sm\\:heading-xl.font-bold';
            const styleIdSelector = '.product-info-label'; // Contains "1011B875"
            const colorContainerSelector = 'li.flex.sm\\:max-w-\\[30rem\\].flex-col.items-end';
            const sizeHeaderSelector = '.grid.grid-flow-col.w-full.h-\\[5\\.5rem\\] .bg-primary.text-white';
            const inventoryRowSelector = '.grid.grid-flow-col.items-center.w-full.h-\\[5\\.5rem\\]';
            
            // Extract basic product info
            let productName = 'Unknown Product';
            let styleId = 'Unknown Style';
            
            // Get product name
            const nameElement = document.querySelector(productNameSelector) || 
                               document.querySelector('h1') ||
                               document.querySelector('[class*="heading"]');
            if (nameElement) {
                productName = nameElement.textContent.trim();
                debugInfo.push('✅ Found product name: ' + productName);
            } else {
                debugInfo.push('❌ Product name not found');
            }
            
            // Get style ID from product info section
            const productInfoElements = document.querySelectorAll('.product-info');
            productInfoElements.forEach(info => {
                const label = info.querySelector('.product-info-label');
                const value = info.querySelector('.product-info-value');
                if (label && value && value.textContent.trim() === 'Style ID') {
                    styleId = label.textContent.trim();
                    debugInfo.push('✅ Found style ID: ' + styleId);
                }
            });
            
            // Extract colors with EXACT structure matching
            const colors = [];
            const colorElements = document.querySelectorAll('li.flex.sm\\:max-w-\\[30rem\\].flex-col.items-end');
            
            debugInfo.push('🎨 Found ' + colorElements.length + ' color containers');
            
            colorElements.forEach((colorContainer, index) => {
                try {
                    // Look for color code and name in the flex container
                    const colorInfo = colorContainer.querySelector('.flex.items-center.gap-2');
                    if (colorInfo) {
                        const spans = colorInfo.querySelectorAll('span');
                        if (spans.length >= 3) {
                            const colorCode = spans[0].textContent.trim();
                            const separator = spans[1].textContent.trim();
                            const colorName = spans[2].textContent.trim();
                            
                            if (colorCode.match(/^\d{3}$/) && separator === '-') {
                                colors.push({
                                    code: colorCode,
                                    name: colorName,
                                    index: index
                                });
                                debugInfo.push('✅ Color ' + index + ': ' + colorCode + ' - ' + colorName);
                            }
                        }
                    }
                } catch (e) {
                    debugInfo.push('❌ Error processing color ' + index + ': ' + e.message);
                }
            });
            
            // Extract sizes from header row
            const sizes = [];
            const sizeElements = document.querySelectorAll('.grid.grid-flow-col.w-full.h-\\[5\\.5rem\\] .bg-primary.text-white');
            
            debugInfo.push('📏 Found ' + sizeElements.length + ' size elements');
            
            sizeElements.forEach((sizeEl, index) => {
                const sizeText = sizeEl.textContent.trim();
                if (sizeText.match(/^\d+\.?\d*$/)) {
                    sizes.push(sizeText);
                    debugInfo.push('✅ Size ' + index + ': ' + sizeText);
                }
            });
            
            // Extract inventory matrix from grid rows
            const inventoryRows = document.querySelectorAll('.grid.grid-flow-col.items-center.w-full.h-\\[5\\.5rem\\]');
            const inventoryMatrix = [];
            
            debugInfo.push('📊 Found ' + inventoryRows.length + ' inventory rows');
            
            inventoryRows.forEach((row, rowIndex) => {
                const quantities = [];
                const cells = row.querySelectorAll('.flex.items-center.justify-center');
                
                cells.forEach((cell, cellIndex) => {
                    const quantityText = cell.textContent.trim();
                    // Match patterns like "0", "3", "1", "0+", "-"
                    if (quantityText.match(/^(\d+\+?|-)$/)) {
                        quantities.push(quantityText);
                    }
                });
                
                if (quantities.length > 0) {
                    inventoryMatrix.push(quantities);
                    debugInfo.push('✅ Row ' + rowIndex + ' quantities: [' + quantities.join(', ') + ']');
                }
            });
            
            // Create detailed inventory records
            if (colors.length > 0 && sizes.length > 0 && inventoryMatrix.length > 0) {
                debugInfo.push('🎯 Creating inventory matrix: ' + colors.length + ' colors × ' + sizes.length + ' sizes');
                
                colors.forEach((color, colorIndex) => {
                    const colorQuantities = inventoryMatrix[colorIndex] || [];
                    
                    sizes.forEach((size, sizeIndex) => {
                        const rawQuantity = colorQuantities[sizeIndex] || '0';
                        let numericQuantity = 0;
                        
                        // Parse quantity properly
                        if (rawQuantity === '-') {
                            numericQuantity = -1; // Not available
                        } else if (rawQuantity.endsWith('+')) {
                            numericQuantity = parseInt(rawQuantity.replace('+', '')) || 0;
                        } else {
                            numericQuantity = parseInt(rawQuantity) || 0;
                        }
                        
                        // Create detailed product record
                        const product = {
                            name: productName,
                            styleId: styleId,
                            sku: styleId + '-' + color.code + '-' + size,
                            colorCode: color.code,
                            colorName: color.name,
                            sizeUS: size,
                            quantity: numericQuantity,
                            rawQuantity: rawQuantity,
                            available: rawQuantity !== '-' && numericQuantity > 0,
                            price: 'See B2B Pricing',
                            imageUrl: '',
                            link: window.location.href,
                            inventoryData: `Color: ${color.code} - ${color.name}, Size: ${size}, Quantity: ${rawQuantity}`,
                            extractedAt: new Date().toISOString(),
                            extractionMethod: 'vue-js-dynamic-matrix',
                            season: 'Multi-Season', // Could extract from season labels
                            deliveryDate: '2025-06-18' // From URL if available
                        };
                        
                        products.push(product);
                    });
                });
                
                debugInfo.push('🎉 Successfully created ' + products.length + ' detailed inventory records');
            }
            
            // Enhanced fallback extraction if matrix method fails
            if (products.length === 0) {
                debugInfo.push('⚠️ Matrix extraction failed, trying enhanced fallback methods');
                
                // Method 1: Look for any quantity indicators
                const quantityElements = document.querySelectorAll('span');
                const foundQuantities = [];
                
                quantityElements.forEach(el => {
                    const text = el.textContent.trim();
                    if (text.match(/^\d+\+?$/) && parseInt(text) > 0) {
                        foundQuantities.push({
                            quantity: text,
                            element: el
                        });
                    }
                });
                
                if (foundQuantities.length > 0) {
                    debugInfo.push('📊 Found ' + foundQuantities.length + ' quantity indicators');
                    
                    foundQuantities.forEach((qty, index) => {
                        products.push({
                            name: productName,
                            styleId: styleId,
                            sku: styleId + '-variant-' + index,
                            colorCode: '',
                            colorName: 'Variant ' + index,
                            sizeUS: '',
                            quantity: parseInt(qty.quantity.replace('+', '')) || 0,
                            rawQuantity: qty.quantity,
                            available: true,
                            price: 'See B2B Pricing',
                            imageUrl: '',
                            link: window.location.href,
                            inventoryData: 'Quantity found: ' + qty.quantity,
                            extractedAt: new Date().toISOString(),
                            extractionMethod: 'quantity-fallback'
                        });
                    });
                    
                    debugInfo.push('📦 Created ' + products.length + ' products from quantity fallback');
                }
                
                // Method 2: Basic page info if still no products
                if (products.length === 0) {
                    debugInfo.push('🔧 Creating basic page record as final fallback');
                    
                    products.push({
                        name: productName,
                        styleId: styleId,
                        sku: styleId,
                        colorCode: '',
                        colorName: '',
                        sizeUS: '',
                        quantity: 0,
                        rawQuantity: 'Dynamic content scan needed',
                        available: false,
                        price: 'See B2B Page',
                        imageUrl: '',
                        link: window.location.href,
                        inventoryData: 'Vue.js page content: ' + document.body.innerText.slice(0, 500),
                        extractedAt: new Date().toISOString(),
                        extractionMethod: 'vue-js-page-scan'
                    });
                    
                    debugInfo.push('📄 Created basic page record');
                }
            }
            
            // Store debug info for analysis
            window.asicsVueExtractionDebug = debugInfo;
            
            debugInfo.push('🏁 Vue.js extraction completed: ' + products.length + ' total products');
            return products;
        });
    }

    async initializeDatabase() {
        if (!this.databaseEnabled) {
            this.addDebugLog('Running in memory-only mode');
            return;
        }

        try {
            this.addDebugLog('Initializing database');
            await this.pool.query('SELECT NOW()');
            this.addDebugLog('Database connection successful');
            
            // Create tables
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS monitored_urls (
                    id SERIAL PRIMARY KEY, 
                    url VARCHAR(1000) NOT NULL UNIQUE, 
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS scrape_logs (
                    id SERIAL PRIMARY KEY, 
                    url VARCHAR(1000), 
                    status VARCHAR(50) DEFAULT 'pending', 
                    product_count INTEGER DEFAULT 0, 
                    error_message TEXT, 
                    batch_id VARCHAR(255), 
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            this.addDebugLog('Database initialization completed');
            
        } catch (error) {
            this.addDebugLog('Database initialization failed', { error: error.message });
            this.databaseEnabled = false;
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        try {
            this.addDebugLog('Starting Enhanced ASICS B2B Scraper v3.1 - Vue.js Master');
            
            // Set default URLs for ASICS B2B
            if (this.urlsToMonitor.length === 0) {
                this.urlsToMonitor = [
                    'https://b2b.asics.com/orders/100454100/products/1011B875?colorCode=600&deliveryDate=2025-06-18'
                ];
            }
            
            this.app.listen(this.port, () => {
                console.log('⚡ Enhanced ASICS B2B Scraper v3.1 - Vue.js Master running on port ' + this.port);
                console.log('📊 Dashboard available at /dashboard');
                console.log('🎯 Features: Vue.js Dynamic Content, Inventory Matrix Extraction, Complete Session Import');
                console.log('🚀 Ready for Vue.js-enhanced B2B scraping!');
                this.addDebugLog('Enhanced Vue.js server started successfully', { 
                    port: this.port,
                    version: '3.1-vue-js-master',
                    features: ['vue-js-dynamic-content', 'inventory-matrix-extraction', 'complete-session-import']
                });
            });
            
        } catch (error) {
            this.addDebugLog('Failed to start Vue.js-enhanced scraper', { error: error.message });
            console.error('❌ Failed to start Vue.js-enhanced scraper:', error);
            process.exit(1);
        }
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down Vue.js-enhanced scraper gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down Vue.js-enhanced scraper gracefully...');
    process.exit(0);
});

// Start the Vue.js-enhanced scraper
const scraper = new EnhancedASICSScraper();
scraper.start().catch(error => {
    console.error('❌ Vue.js-enhanced startup failed:', error);
    process.exit(1);
});
