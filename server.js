const express = require('express');
const puppeteer = require('puppeteer-core');
const { Pool } = require('pg');
const cron = require('node-cron');

class FullyUpdatedScraper {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 10000;
        
        console.log('🔍 Environment Variables Check:');
        console.log('   NODE_ENV:', process.env.NODE_ENV);
        console.log('   DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
        console.log('   BROWSERLESS_TOKEN:', process.env.BROWSERLESS_TOKEN ? 'SET' : 'NOT SET');
        
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

        // Browserless configuration with rate limiting
        this.browserlessToken = process.env.BROWSERLESS_TOKEN;
        if (this.browserlessToken) {
            this.browserlessEndpoint = 'wss://production-sfo.browserless.io?token=' + this.browserlessToken;
        } else {
            this.browserlessEndpoint = 'ws://browserless:3000';
        }
        
        this.isSelfHosted = !this.browserlessEndpoint.includes('browserless.io');

        // Session storage
        this.sessionCookies = [];
        this.sessionValid = false;
        this.urlsToMonitor = [];
        this.scrapingLogs = [];
        this.scrapingProgress = { active: false, total: 0, completed: 0 };
        this.debugLogs = [];
        
        // Rate limiting for Browserless
        this.lastBrowserlessRequest = 0;
        this.minRequestInterval = 3000; // 3 seconds between requests
        
        this.setupMiddleware();
        this.setupRoutes();
        
        this.initializeDatabase().then(() => {
            this.loadUrlsToMonitor();
        }).catch(error => {
            console.error('⚠️ Database initialization failed:', error.message);
            this.databaseEnabled = false;
            this.setDefaultUrls();
        });
    }

    setDefaultUrls() {
        this.urlsToMonitor = [
            'https://b2b.asics.com/us/en-us/mens-running-shoes',
            'https://b2b.asics.com/us/en-us/womens-running-shoes'
        ];
    }

    addDebugLog(message, data = null) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            message,
            data
        };
        this.debugLogs.unshift(logEntry);
        console.log('🐛 DEBUG: ' + message, data ? JSON.stringify(data, null, 2) : '');
        
        // Keep only last 100 debug logs
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
        this.app.use(express.json());
        this.app.use(express.static('public'));
    }

    setupRoutes() {
        // Health check
        this.app.get('/', (req, res) => {
            res.json({
                status: 'Fully Updated ASICS Scraper Active',
                uptime: process.uptime(),
                urlCount: this.urlsToMonitor.length,
                sessionValid: this.sessionValid,
                cookieCount: this.sessionCookies.length,
                debugLogCount: this.debugLogs.length,
                version: '2.0-enhanced'
            });
        });

        // Enhanced Dashboard with all new features
        this.app.get('/dashboard', (req, res) => {
            const sessionStatusClass = this.sessionValid ? 'success' : 'danger';
            const sessionStatusText = this.sessionValid ? '✅ Session Valid' : '❌ No Session';
            
            const urlListHtml = this.urlsToMonitor.map((url, index) => {
                return '<li class="url-item"><span style="word-break: break-all; font-size: 11px;">' + 
                       url + '</span><button onclick="removeUrl(' + index + 
                       ')" class="btn danger">❌</button></li>';
            }).join('');

            const dashboardHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enhanced ASICS Scraper v2.0</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        .header { background: white; padding: 30px; border-radius: 10px; margin-bottom: 30px; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .card { background: white; padding: 25px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
        .danger { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        .info { background: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460; }
        .btn { background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 5px; cursor: pointer; margin: 5px; font-size: 14px; }
        .btn:hover { background: #0056b3; }
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
        .code { background: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 12px; margin: 10px 0; }
        .new-feature { border: 2px solid #28a745 !important; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Enhanced ASICS Scraper v2.0</h1>
            <p>Cookie-based authentication with advanced debugging & real-time testing</p>
            <div style="margin-top: 15px;">
                <span class="btn ${sessionStatusClass}" style="cursor: default;">
                    ${sessionStatusText}
                </span>
                <span class="btn" style="background: #6c757d; cursor: default;">
                    ${this.sessionCookies.length} Cookies
                </span>
                <span class="btn" style="background: #6c757d; cursor: default;">
                    ${this.urlsToMonitor.length} URLs
                </span>
            </div>
        </div>

        <div class="grid-3">
            <div class="card new-feature">
                <h3>🍪 Enhanced Session Management</h3>
                <div class="input-group">
                    <label for="cookieString">Session Cookies:</label>
                    <textarea id="cookieString" rows="3" placeholder="Paste your cookies here..."></textarea>
                </div>
                <button onclick="setSessionCookies()" class="btn success">🍪 Set Session</button>
                <button onclick="testSession()" class="btn">🧪 Test Session</button>
                <button onclick="clearSession()" class="btn danger">🗑️ Clear</button>
                <div id="sessionResult" style="margin-top: 10px;"></div>
            </div>

            <div class="card new-feature">
                <h3>🔗 Advanced URL Testing</h3>
                <div class="input-group">
                    <input type="url" id="newUrl" placeholder="https://b2b.asics.com/orders/...">
                </div>
                <button onclick="addUrl()" class="btn">➕ Add URL</button>
                <button onclick="testSpecificUrl()" class="btn warning">⚡ Test URL Now</button>
                <button onclick="debugSinglePage()" class="btn info">🐛 Deep Debug</button>
                
                <h4 style="margin-top: 15px;">URLs (${this.urlsToMonitor.length}):</h4>
                <ul id="urlList" class="url-list">
                    ${urlListHtml}
                </ul>
            </div>

            <div class="card">
                <h3>🚀 Scraping & Export</h3>
                <button onclick="startScraping()" class="btn success large" ${this.sessionValid ? '' : 'disabled'}>
                    ▶️ Start Scraping
                </button>
                <button onclick="exportResults()" class="btn">📄 Export Results CSV</button>
                <button onclick="viewAllResults()" class="btn">👁️ View All Results</button>
                <button onclick="exportDebugLogs()" class="btn">📋 Export Debug Logs</button>
                
                <div id="scrapingStatus" style="margin-top: 15px;"></div>
                <div id="progressBar" style="margin-top: 10px;"></div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <h3>📊 Scraping Logs</h3>
                <button onclick="refreshLogs()" class="btn">🔄 Refresh</button>
                <div id="logs" class="logs">
                    Click refresh to load recent activity...
                </div>
            </div>

            <div class="card new-feature">
                <h3>🐛 Enhanced Debug Logs</h3>
                <button onclick="refreshDebugLogs()" class="btn">🔄 Refresh Debug</button>
                <button onclick="clearDebugLogs()" class="btn danger">🗑️ Clear Debug</button>
                <div id="debugLogs" class="debug-logs">
                    Click refresh to load debug information...
                </div>
            </div>
        </div>

        <div class="card info new-feature">
            <h3>🍪 Real-Time Cookie Extraction Guide</h3>
            <p><strong>For best results with order pages:</strong></p>
            
            <div style="margin: 15px 0; padding: 15px; background: #e7f3ff; border-radius: 8px;">
                <h4>🚀 Quick Method (Recommended)</h4>
                <ol style="margin: 10px 0 10px 20px; line-height: 1.6;">
                    <li><strong>Open ASICS B2B</strong> in a new tab</li>
                    <li><strong>Log in and navigate</strong> to your working order page</li>
                    <li><strong>Verify page loads</strong> with inventory data visible</li>
                    <li><strong>Extract cookies immediately</strong> using F12 → Console</li>
                    <li><strong>Paste here and test</strong> within 60 seconds</li>
                </ol>
            </div>
            
            <div class="code">
                <strong>Cookie Extract Code:</strong><br>
                document.cookie.split(';').map(c => c.trim()).join('; ')
            </div>
            
            <div style="margin: 15px 0; padding: 15px; background: #fff3cd; border-radius: 8px;">
                <h4>⚡ Immediate Testing</h4>
                <p>Use <strong>"⚡ Test URL Now"</strong> to verify your exact order URLs work before full scraping.</p>
            </div>
        </div>
    </div>

    <script>
        async function setSessionCookies() {
            const cookieString = document.getElementById('cookieString').value.trim();
            const resultDiv = document.getElementById('sessionResult');
            
            if (!cookieString) {
                resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">Please paste cookies first!</div>';
                return;
            }

            try {
                resultDiv.innerHTML = '<div class="info" style="padding: 10px; margin-top: 10px;">Setting cookies...</div>';
                
                const response = await fetch('/api/set-cookies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookies: cookieString })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    resultDiv.innerHTML = '<div class="success" style="padding: 10px; margin-top: 10px;">✅ Set ' + result.cookieCount + ' cookies<br>Session valid: ' + (result.sessionValid ? 'Yes' : 'No') + '<br><small>' + result.testResult + '</small></div>';
                    
                    if (result.sessionValid) {
                        setTimeout(() => location.reload(), 2000);
                    }
                } else {
                    resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ Failed: ' + result.error + '<br><small>Check debug logs for details</small></div>';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ Error: ' + error.message + '</div>';
            }
        }

        async function testSession() {
            const resultDiv = document.getElementById('sessionResult');
            resultDiv.innerHTML = '<div class="info" style="padding: 10px; margin-top: 10px;">Testing session...</div>';
            
            try {
                const response = await fetch('/api/test-session');
                const result = await response.json();
                
                resultDiv.innerHTML = '<div class="' + (result.success ? 'success' : 'danger') + '" style="padding: 10px; margin-top: 10px;">' + (result.success ? '✅' : '❌') + ' ' + result.message + '<br><small>Cookies: ' + (result.cookieCount || 0) + '</small></div>';
            } catch (error) {
                resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ Error: ' + error.message + '</div>';
            }
        }

        async function testSpecificUrl() {
            const url = document.getElementById('newUrl').value.trim();
            if (!url) {
                alert('Please enter a URL to test');
                return;
            }
            
            const resultDiv = document.getElementById('sessionResult');
            resultDiv.innerHTML = '<div class="info" style="padding: 10px; margin-top: 10px;">⚡ Testing URL immediately...</div>';
            
            try {
                const response = await fetch('/api/test-specific-url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    resultDiv.innerHTML = '<div class="success" style="padding: 10px; margin-top: 10px;">✅ URL accessible! No redirect to login.<br><strong>Title:</strong> ' + result.details.title + '<br><strong>Page Size:</strong> ' + result.details.pageSize + ' chars</div>';
                } else {
                    resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ URL failed: ' + result.message + '<br><strong>Redirected to:</strong> ' + result.details.finalUrl + '<br><strong>Title:</strong> ' + result.details.title + '</div>';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div class="danger" style="padding: 10px; margin-top: 10px;">❌ Error: ' + error.message + '</div>';
            }
        }

        async function clearSession() {
            if (!confirm('Clear current session?')) return;
            
            try {
                await fetch('/api/clear-session', { method: 'POST' });
                document.getElementById('cookieString').value = '';
                document.getElementById('sessionResult').innerHTML = '<div class="info" style="padding: 10px; margin-top: 10px;">Session cleared</div>';
                setTimeout(() => location.reload(), 1000);
            } catch (error) {
                console.error('Error clearing session:', error);
            }
        }

        async function debugSinglePage() {
            const url = document.getElementById('newUrl').value.trim() || 'https://b2b.asics.com/us/en-us';
            const statusDiv = document.getElementById('scrapingStatus');
            
            try {
                statusDiv.innerHTML = '<div class="info" style="padding: 10px;">🐛 Deep debugging page...</div>';
                
                const response = await fetch('/api/debug-page', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    statusDiv.innerHTML = '<div class="success" style="padding: 10px;">✅ Debug completed<br><small>Found ' + result.productCount + ' products. Check debug logs for details.</small></div>';
                    refreshDebugLogs();
                } else {
                    statusDiv.innerHTML = '<div class="danger" style="padding: 10px;">❌ Debug failed: ' + result.error + '</div>';
                }
            } catch (error) {
                statusDiv.innerHTML = '<div class="danger" style="padding: 10px;">❌ Error: ' + error.message + '</div>';
            }
        }

        async function startScraping() {
            const statusDiv = document.getElementById('scrapingStatus');
            
            try {
                statusDiv.innerHTML = '<div class="info" style="padding: 10px;">🚀 Starting enhanced scraping...</div>';
                
                const response = await fetch('/api/start-scraping', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    statusDiv.innerHTML = '<div class="success" style="padding: 10px;">✅ Enhanced scraping started!</div>';
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
                    document.getElementById('progressBar').innerHTML = '<div style="background: #f0f0f0; border-radius: 4px; padding: 5px;"><div style="background: #28a745; height: 20px; width: ' + progress + '%; border-radius: 4px; transition: width 0.3s;"></div><div style="text-align: center; margin-top: 5px; font-size: 12px;">' + data.completed + ' of ' + data.total + ' URLs (' + Math.round(progress) + '%)</div></div>';
                    
                    if (data.completed < data.total) {
                        setTimeout(pollProgress, 3000);
                    } else {
                        document.getElementById('scrapingStatus').innerHTML = 
                            '<div class="success" style="padding: 10px;">🎉 Enhanced scraping completed!</div>';
                        refreshLogs();
                        refreshDebugLogs();
                    }
                }
            } catch (error) {
                console.error('Error polling progress:', error);
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
                    a.download = 'asics-enhanced-results-' + new Date().toISOString().split('T')[0] + '.csv';
                    a.click();
                    URL.revokeObjectURL(url);
                    
                    alert('✅ Enhanced CSV exported with ' + data.products.length + ' products!');
                } else {
                    alert('❌ No results to export. Run a scraping session first.');
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
                    html += '<h4>Enhanced Results (' + data.products.length + ' products):</h4>';
                    
                    data.products.forEach((product, index) => {
                        html += '<div style="margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">';
                        html += '<strong>' + (index + 1) + '. ' + product.name + '</strong><br>';
                        html += 'SKU: ' + product.sku + '<br>';
                        html += 'Price: ' + product.price + '<br>';
                        if (product.quantity) html += 'Quantity: ' + product.quantity + '<br>';
                        if (product.color) html += 'Color: ' + product.color + '<br>';
                        if (product.size) html += 'Size: ' + product.size + '<br>';
                        html += 'Source: ' + product.sourceUrl + '<br>';
                        html += 'Scraped: ' + new Date(product.extractedAt).toLocaleString() + '<br>';
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
                    alert('❌ No results to view. Run a scraping session first.');
                }
            } catch (error) {
                alert('Error viewing results: ' + error.message);
            }
        }

        function convertToCSV(products) {
            const headers = ['Name', 'SKU', 'Price', 'Quantity', 'Color', 'Size', 'Source URL', 'Product Link', 'Image URL', 'Inventory Data', 'Scraped At'];
            let csv = headers.join(',') + '\\n';
            
            products.forEach(product => {
                const row = [
                    '"' + (product.name || '').replace(/"/g, '""') + '"',
                    '"' + (product.sku || '').replace(/"/g, '""') + '"',
                    '"' + (product.price || '').replace(/"/g, '""') + '"',
                    '"' + (product.quantity || '').replace(/"/g, '""') + '"',
                    '"' + (product.color || '').replace(/"/g, '""') + '"',
                    '"' + (product.size || '').replace(/"/g, '""') + '"',
                    '"' + (product.sourceUrl || '').replace(/"/g, '""') + '"',
                    '"' + (product.link || '').replace(/"/g, '""') + '"',
                    '"' + (product.imageUrl || '').replace(/"/g, '""') + '"',
                    '"' + (product.inventoryData || '').replace(/"/g, '""') + '"',
                    '"' + (product.extractedAt || '').replace(/"/g, '""') + '"'
                ];
                csv += row.join(',') + '\\n';
            });
            
            return csv;
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
                    logsContainer.innerHTML = logs.map(log => '<div style="margin: 5px 0; padding: 8px; border-left: 3px solid ' + (log.status === 'success' ? '#28a745' : '#dc3545') + ';"><strong>' + new Date(log.timestamp).toLocaleString() + ':</strong><br>URL: ' + log.url + '<br>Status: ' + log.status + ' | Products: ' + (log.productCount || 0) + '<br>' + (log.error ? 'Error: ' + log.error : '') + '</div>').join('');
                } else {
                    logsContainer.innerHTML = '<div style="color: #666;">No logs available yet.</div>';
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
                    debugContainer.innerHTML = logs.map(log => '<div style="margin: 3px 0; padding: 5px; border-left: 2px solid #007bff;"><strong>' + new Date(log.timestamp).toLocaleString() + ':</strong> ' + log.message + '<br>' + (log.data ? '<pre style="font-size: 9px; margin: 3px 0;">' + JSON.stringify(log.data, null, 2) + '</pre>' : '') + '</div>').join('');
                } else {
                    debugContainer.innerHTML = '<div style="color: #666;">No debug logs available.</div>';
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

        async function exportDebugLogs() {
            try {
                const response = await fetch('/api/debug-logs');
                const logs = await response.json();
                
                const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'asics-enhanced-debug-logs.json';
                a.click();
                URL.revokeObjectURL(url);
            } catch (error) {
                alert('Error exporting logs: ' + error.message);
            }
        }

        // Auto-refresh debug logs every 10 seconds
        setInterval(refreshDebugLogs, 10000);
    </script>
</body>
</html>
            `;
            
            res.send(dashboardHtml);
        });

        // Enhanced API Routes
        this.app.post('/api/set-cookies', async (req, res) => {
            try {
                this.addDebugLog('API: Setting cookies with enhanced processing');
                const { cookies } = req.body;
                
                if (!cookies || typeof cookies !== 'string') {
                    this.addDebugLog('Invalid cookies provided', { type: typeof cookies, length: cookies?.length });
                    return res.json({ 
                        success: false, 
                        error: 'Invalid cookies provided. Expected a string.',
                        received: typeof cookies
                    });
                }

                this.addDebugLog('Raw cookie string received', { length: cookies.length, preview: cookies.slice(0, 100) });

                // Enhanced cookie parsing
                this.sessionCookies = this.parseCookieStringEnhanced(cookies);
                
                if (this.sessionCookies.length === 0) {
                    this.addDebugLog('No valid cookies parsed');
                    return res.json({ 
                        success: false, 
                        error: 'No valid cookies found in the provided string.',
                        originalLength: cookies.length
                    });
                }

                this.addDebugLog('Cookies parsed successfully', { count: this.sessionCookies.length });
                
                // Rate limit before testing
                await this.rateLimitedBrowserlessRequest();
                
                // Enhanced session testing
                this.addDebugLog('Auto-testing session with enhanced validation');
                const testResult = await this.testSessionValidityEnhanced();
                this.sessionValid = testResult.valid;
                
                this.addDebugLog('Enhanced auto-test completed', { valid: testResult.valid, message: testResult.message });
                
                res.json({ 
                    success: true, 
                    cookieCount: this.sessionCookies.length,
                    sessionValid: this.sessionValid,
                    testResult: testResult.message,
                    autoTestPassed: testResult.valid,
                    enhancement: 'v2.0'
                });
                
            } catch (error) {
                this.addDebugLog('Error setting cookies', { error: error.message, stack: error.stack });
                res.json({ 
                    success: false, 
                    error: 'Failed to set cookies: ' + error.message
                });
            }
        });

        this.app.get('/api/test-session', async (req, res) => {
            try {
                this.addDebugLog('API: Testing session with enhanced validation');
                
                if (!this.sessionCookies || this.sessionCookies.length === 0) {
                    this.addDebugLog('No cookies available for testing');
                    return res.json({
                        success: false,
                        error: 'No cookies set. Please set session cookies first.',
                        cookieCount: 0
                    });
                }
                
                await this.rateLimitedBrowserlessRequest();
                
                const result = await this.testSessionValidityEnhanced();
                this.sessionValid = result.valid;
                
                this.addDebugLog('Enhanced session test completed', { valid: result.valid, message: result.message });
                
                res.json({
                    success: result.valid,
                    message: result.message,
                    details: result.details,
                    cookieCount: this.sessionCookies.length,
                    enhancement: 'v2.0'
                });
                
            } catch (error) {
                this.addDebugLog('API error testing session', { error: error.message });
                res.json({ 
                    success: false, 
                    error: 'API error: ' + error.message
                });
            }
        });

        // NEW: Immediate URL testing endpoint
        this.app.post('/api/test-specific-url', async (req, res) => {
            try {
                const { url } = req.body;
                this.addDebugLog('Testing specific URL immediately', { url });
                
                if (!this.sessionCookies || this.sessionCookies.length === 0) {
                    return res.json({
                        success: false,
                        error: 'No cookies set. Please set session cookies first.',
                        cookieCount: 0
                    });
                }
                
                await this.rateLimitedBrowserlessRequest();
                
                const browser = await puppeteer.connect({
                    browserWSEndpoint: this.browserlessEndpoint,
                    ignoreHTTPSErrors: true
                });
                
                const page = await browser.newPage();
                
                // Enhanced headers for better compatibility
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.setExtraHTTPHeaders({
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Cache-Control': 'no-cache'
                });
                
                // Set cookies
                await page.setCookie(...this.sessionCookies);
                
                // Navigate directly to the URL
                await page.goto(url, { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });
                
                await page.waitForTimeout(3000);
                
                // Enhanced page analysis
                const result = await page.evaluate(() => {
                    const currentUrl = window.location.href;
                    const title = document.title;
                    const bodyText = document.body ? document.body.innerText : '';
                    
                    return {
                        requestedUrl: window.location.href,
                        finalUrl: currentUrl,
                        title: title,
                        wasRedirected: currentUrl !== window.location.href,
                        hasLoginForm: document.querySelector('input[type="password"]') !== null,
                        urlHasLogin: currentUrl.includes('login') || currentUrl.includes('authentication'),
                        bodyHasLoginText: bodyText.toLowerCase().includes('sign in') || bodyText.toLowerCase().includes('log in'),
                        bodyPreview: bodyText.slice(0, 300),
                        pageSize: bodyText.length,
                        elementCount: document.querySelectorAll('*').length,
                        hasOrderContent: bodyText.toLowerCase().includes('order') || bodyText.toLowerCase().includes('product'),
                        hasInventoryContent: bodyText.toLowerCase().includes('inventory') || bodyText.toLowerCase().includes('quantity')
                    };
                });
                
                await browser.close();
                
                const isWorking = !result.hasLoginForm && !result.urlHasLogin && !result.bodyHasLoginText;
                
                this.addDebugLog('Specific URL test completed', { 
                    url, 
                    finalUrl: result.finalUrl,
                    isWorking,
                    title: result.title,
                    hasOrderContent: result.hasOrderContent
                });
                
                res.json({
                    success: isWorking,
                    message: isWorking ? 'URL accessible!' : 'URL redirected to login or has authentication issues',
                    details: result,
                    cookieCount: this.sessionCookies.length,
                    enhancement: 'immediate-test-v2.0'
                });
                
            } catch (error) {
                this.addDebugLog('Specific URL test error', { error: error.message });
                res.json({ 
                    success: false, 
                    error: 'Test failed: ' + error.message
                });
            }
        });

        this.app.post('/api/debug-page', async (req, res) => {
            try {
                const { url } = req.body;
                this.addDebugLog('Starting enhanced single page debug', { url });
                
                if (!this.sessionValid || this.sessionCookies.length === 0) {
                    return res.json({ success: false, error: 'No valid session. Please set cookies first.' });
                }

                await this.rateLimitedBrowserlessRequest();
                
                const result = await this.debugSinglePageEnhanced(url);
                
                res.json({
                    success: true,
                    productCount: result.products.length,
                    message: 'Enhanced debug completed. Check debug logs for details.',
                    enhancement: 'deep-debug-v2.0'
                });
                
            } catch (error) {
                this.addDebugLog('Enhanced debug page error', { error: error.message });
                res.json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/clear-session', (req, res) => {
            this.sessionCookies = [];
            this.sessionValid = false;
            this.addDebugLog('Session cleared');
            res.json({ success: true });
        });

        this.app.post('/api/start-scraping', async (req, res) => {
            try {
                if (!this.sessionValid || this.sessionCookies.length === 0) {
                    return res.json({ success: false, error: 'No valid session. Please set cookies first.' });
                }
                
                if (this.urlsToMonitor.length === 0) {
                    return res.json({ success: false, error: 'No URLs to scrape. Add some URLs first.' });
                }

                this.addDebugLog('Starting enhanced scraping session', { urlCount: this.urlsToMonitor.length });
                
                this.scrapingProgress = {
                    active: true,
                    total: this.urlsToMonitor.length,
                    completed: 0,
                    results: []
                };
                
                // Start enhanced scraping in background
                setTimeout(() => this.startEnhancedScraping(), 1000);
                
                res.json({ success: true, message: 'Enhanced scraping started', urlCount: this.urlsToMonitor.length, enhancement: 'v2.0' });
                
            } catch (error) {
                this.addDebugLog('Error starting enhanced scraping', { error: error.message });
                res.json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/scraping-progress', (req, res) => {
            res.json(this.scrapingProgress || { active: false, total: 0, completed: 0 });
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
                await this.saveUrlsToDatabase();
                
                this.addDebugLog('URL added', { url });
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
                await this.saveUrlsToDatabase();
                
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

        // Enhanced export results endpoint
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
                
                this.addDebugLog('Enhanced export results requested', { productCount: allProducts.length });
                
                res.json({
                    success: true,
                    products: allProducts,
                    totalProducts: allProducts.length,
                    exportedAt: new Date().toISOString(),
                    enhancement: 'v2.0'
                });
                
            } catch (error) {
                this.addDebugLog('Enhanced export results error', { error: error.message });
                res.json({
                    success: false,
                    error: error.message,
                    products: []
                });
            }
        });
    }

    // Enhanced cookie parsing
    parseCookieStringEnhanced(cookieString) {
        try {
            this.addDebugLog('Enhanced cookie parsing started', { length: cookieString.length });
            
            const cookies = [];
            const cookiePairs = cookieString.split(';');
            
            this.addDebugLog('Cookie pairs found', { count: cookiePairs.length });
            
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
                            
                            // Log important cookies
                            if (name.includes('session') || name.includes('auth') || name.includes('token')) {
                                this.addDebugLog('Important cookie found', { name: name, valueLength: value.length });
                            }
                        } else {
                            this.addDebugLog('Skipped invalid cookie pair', { index: i, pair: trimmed.slice(0, 50) });
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

    // Enhanced session validation
    async testSessionValidityEnhanced() {
        try {
            this.addDebugLog('Starting enhanced session validity test');
            
            if (this.sessionCookies.length === 0) {
                this.addDebugLog('No cookies available for testing');
                return {
                    valid: false,
                    message: 'No cookies set. Please set session cookies first.',
                    details: null
                };
            }
            
            const browser = await puppeteer.connect({
                browserWSEndpoint: this.browserlessEndpoint,
                ignoreHTTPSErrors: true
            });
            
            this.addDebugLog('Browser connected for enhanced testing');
            const page = await browser.newPage();
            
            // Enhanced browser setup
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            });
            
            const validCookies = this.sessionCookies.filter(cookie => 
                cookie.name && cookie.value && cookie.name.trim() !== '' && cookie.value.trim() !== ''
            );
            
            if (validCookies.length === 0) {
                await browser.close();
                this.addDebugLog('No valid cookies after filtering');
                return {
                    valid: false,
                    message: 'No valid cookies found after filtering',
                    details: { originalCount: this.sessionCookies.length, validCount: 0 }
                };
            }
            
            await page.setCookie(...validCookies);
            this.addDebugLog('Enhanced cookies set successfully', { validCount: validCookies.length });
            
            // First establish context by visiting main portal
            this.addDebugLog('Establishing B2B session context');
            await page.goto('https://b2b.asics.com/', { 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });
            
            await page.waitForTimeout(2000);
            
            // Now test with an order URL pattern
            this.addDebugLog('Testing order page access pattern');
            try {
                await page.goto('https://b2b.asics.com/orders/100454100/products/1011B875?colorCode=600&deliveryDate=2025-06-18', { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });
                
                await page.waitForTimeout(3000);
                
                const result = await page.evaluate(() => {
                    const url = window.location.href;
                    const title = document.title;
                    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                    
                    const hasLoginForm = document.querySelector('input[type="password"]') !== null;
                    const urlHasLogin = url.includes('login') || url.includes('authentication');
                    const bodyHasLoginText = bodyText.includes('sign in') || bodyText.includes('log in');
                    
                    const hasOrderContent = bodyText.includes('order') || bodyText.includes('product');
                    const hasInventoryContent = bodyText.includes('inventory') || bodyText.includes('quantity') || bodyText.includes('available');
                    
                    const isLoggedIn = !hasLoginForm && !urlHasLogin && !bodyHasLoginText;
                    const hasOrderAccess = isLoggedIn && (hasOrderContent || hasInventoryContent);
                    
                    return {
                        url,
                        title,
                        isLoggedIn,
                        hasOrderAccess,
                        hasLoginForm,
                        urlHasLogin,
                        bodyHasLoginText,
                        hasOrderContent,
                        hasInventoryContent,
                        bodyPreview: bodyText.slice(0, 500)
                    };
                });
                
                await browser.close();
                
                this.addDebugLog('Enhanced session test completed', result);
                
                if (result.isLoggedIn && result.hasOrderAccess) {
                    this.addDebugLog('Enhanced session validation: SUCCESS with order access');
                    return {
                        valid: true,
                        message: 'Enhanced session active with order access! Ready for inventory scraping.',
                        details: result
                    };
                } else if (result.isLoggedIn) {
                    this.addDebugLog('Enhanced session validation: PARTIAL - logged in but limited access');
                    return {
                        valid: true,
                        message: 'Session active but may need fresh order context for inventory data.',
                        details: result
                    };
                } else {
                    this.addDebugLog('Enhanced session validation: FAILED', result);
                    return {
                        valid: false,
                        message: 'Session appears expired. Please get fresh cookies from active ASICS session.',
                        details: result
                    };
                }
                
            } catch (orderError) {
                this.addDebugLog('Order URL test failed, trying basic test', { error: orderError.message });
                
                await page.goto('https://b2b.asics.com/us/en-us', { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });
                
                const basicResult = await page.evaluate(() => {
                    const url = window.location.href;
                    const title = document.title;
                    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                    
                    const hasLoginForm = document.querySelector('input[type="password"]') !== null;
                    const urlHasLogin = url.includes('login') || url.includes('authentication');
                    const bodyHasLoginText = bodyText.includes('sign in') || bodyText.includes('log in');
                    
                    const isLoggedIn = !hasLoginForm && !urlHasLogin && !bodyHasLoginText;
                    
                    return {
                        url,
                        title,
                        isLoggedIn,
                        bodyPreview: bodyText.slice(0, 300)
                    };
                });
                
                await browser.close();
                
                if (basicResult.isLoggedIn) {
                    return {
                        valid: true,
                        message: 'Basic session active. Order URLs may need fresh context or different approach.',
                        details: basicResult
                    };
                } else {
                    return {
                        valid: false,
                        message: 'Session test failed. Please extract fresh cookies from working ASICS session.',
                        details: basicResult
                    };
                }
            }
            
        } catch (error) {
            this.addDebugLog('Enhanced session test error', { error: error.message, stack: error.stack });
            return {
                valid: false,
                message: 'Enhanced session test error: ' + error.message,
                details: { error: error.message }
            };
        }
    }

    // Enhanced single page debugging
    async debugSinglePageEnhanced(url) {
        try {
            this.addDebugLog('Enhanced debug single page started', { url });
            
            await this.rateLimitedBrowserlessRequest();
            
            const browser = await puppeteer.connect({
                browserWSEndpoint: this.browserlessEndpoint,
                ignoreHTTPSErrors: true
            });
            
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Enhanced headers for order pages
            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'no-cache'
            });
            
            await page.setCookie(...this.sessionCookies);
            this.addDebugLog('Enhanced cookies set for debug session');
            
            // For order URLs, establish context first
            if (url.includes('/orders/')) {
                this.addDebugLog('Order URL detected, establishing enhanced context');
                
                try {
                    await page.goto('https://b2b.asics.com/', { 
                        waitUntil: 'domcontentloaded', 
                        timeout: 20000 
                    });
                    await page.waitForTimeout(2000);
                    
                    this.addDebugLog('Enhanced context established');
                } catch (contextError) {
                    this.addDebugLog('Enhanced context establishment failed', { error: contextError.message });
                }
            }
            
            this.addDebugLog('Navigating to enhanced debug URL', { url });
            
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            
            // Enhanced page analysis
            const pageAnalysis = await page.evaluate(() => {
                const url = window.location.href;
                const title = document.title;
                const bodyText = document.body ? document.body.innerText : '';
                
                // Enhanced element counting
                const elementCounts = {
                    divs: document.querySelectorAll('div').length,
                    spans: document.querySelectorAll('span').length,
                    tables: document.querySelectorAll('table').length,
                    forms: document.querySelectorAll('form').length,
                    inputs: document.querySelectorAll('input').length,
                    buttons: document.querySelectorAll('button').length,
                    images: document.querySelectorAll('img').length
                };
                
                // Enhanced ASICS-specific analysis
                const asicsAnalysis = {
                    hasOrderForm: document.querySelector('form[action*="order"]') !== null,
                    hasProductTable: document.querySelector('table') !== null,
                    hasQuantityInputs: document.querySelectorAll('input[type="number"]').length,
                    hasColorSelectors: document.querySelectorAll('[data-color], .color, .variant').length,
                    hasPriceElements: document.querySelectorAll('.price, .cost, .amount').length
                };
                
                // Enhanced text pattern analysis
                const textAnalysis = {
                    hasInventoryKeywords: /inventory|stock|available|quantity|qty/i.test(bodyText),
                    hasOrderKeywords: /order|purchase|cart|checkout/i.test(bodyText),
                    hasProductKeywords: /product|item|sku|model/i.test(bodyText),
                    colorCodes: (bodyText.match(/\b[A-Z0-9]{3}\b/g) || []).slice(0, 10),
                    numbers: (bodyText.match(/\b\d+\b/g) || []).slice(0, 20)
                };
                
                return {
                    url,
                    title,
                    bodyLength: bodyText.length,
                    elementCounts,
                    asicsAnalysis,
                    textAnalysis,
                    hasLoginRedirect: url.includes('login') || url.includes('authentication'),
                    bodyPreview: bodyText.slice(0, 1000),
                    isOrderPage: url.includes('/orders/'),
                    isProductPage: url.includes('/products/')
                };
            });
            
            this.addDebugLog('Enhanced page analysis completed', pageAnalysis);
            
            // Enhanced product extraction
            this.addDebugLog('Starting enhanced product extraction');
            const products = await this.extractProductsEnhanced(page);
            this.addDebugLog('Enhanced product extraction completed', { productCount: products.length });
            
            await browser.close();
            this.addDebugLog('Enhanced debug session completed', { 
                productCount: products.length,
                url: pageAnalysis.url,
                title: pageAnalysis.title
            });
            
            return {
                url: pageAnalysis.url,
                products,
                analysis: pageAnalysis
            };
            
        } catch (error) {
            this.addDebugLog('Enhanced debug single page error', { url, error: error.message });
            throw error;
        }
    }

    // Enhanced product extraction
    async extractProductsEnhanced(page) {
        return await page.evaluate(() => {
            const products = [];
            const debugInfo = [];
            
            // Enhanced selectors for ASICS B2B
            const containerSelectors = [
                'table tbody tr',
                '.order-item',
                '.product-row',
                '.inventory-item',
                '.line-item',
                '[data-product]',
                '[data-sku]',
                '.product',
                '.item'
            ];
            
            const nameSelectors = [
                '.product-name',
                '.item-name',
                '.name',
                '.description',
                't
