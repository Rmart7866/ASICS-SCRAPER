async function exportDebugLogs() {
            try {
                const response = await fetch('/api/debug-logs');
                const logs = await response.json();
                
                const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'asics-scraper-debug-logs.json';
                a.click();
                URL.revokeObjectURL(url);
            } catch (error) {
                alert('Error exporting logs: ' + error.message);
            }
        }

        async function exportResults() {
            try {
                const response = await fetch('/api/export-results');
                const data = await response.json();
                
                if (data.success && data.products.length > 0) {
                    // Convert to CSV
                    const csvContent = convertToCSV(data.products);
                    
                    // Download CSV
                    const blob = new Blob([csvContent], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'asics-scraper-results-' + new Date().toISOString().split('T')[0] + '.csv';
                    a.click();
                    URL.revokeObjectURL(url);
                    
                    alert('✅ CSV exported with ' + data.products.length + ' products!');
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
                    html += '<h4>All Scraped Products (' + data.products.length + '):</h4>';
                    
                    data.products.forEach((product, index) => {
                        html += '<div style="margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">';
                        html += '<strong>' + (index + 1) + '. ' + product.name + '</strong><br>';
                        html += 'SKU: ' + product.sku + '<br>';
                        html += 'Price: ' + product.price + '<br>';
                        html += 'URL: ' + product.sourceUrl + '<br>';
                        if (product.link) html += 'Product Link: ' + product.link + '<br>';
                        html += 'Scraped: ' + new Date(product.extractedAt).toLocaleString() + '<br>';
                        html += '</div>';
                    });
                    
                    html += '</div>';
                    
                    // Show in a modal-style overlay
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
            const headers = ['Name', 'SKU', 'Price', 'Source URL', 'Product Link', 'Image URL', 'Scraped At'];
            let csv = headers.join(',') + '\\n';
            
            products.forEach(product => {
                const row = [
                    '"' + (product.name || '').replace(/"/g, '""') + '"',
                    '"' + (product.sku || '').replace(/"/g, '""') + '"',
                    '"' + (product.price || '').replace(/"/g, '""') + '"',
                    '"' + (product.sourceUrl || '').replace(/"/g, '""') + '"',
                    '"' + (product.link || '').replace(/"/g, '""') + '"',
                    '"' + (product.imageUrl || '').replace(/"/g, '""') + '"',
                    '"' + (product.extractedAt || '').replace(/"/g, '""') + '"'
                ];
                csv += row.join(',') + '\\n';
            });
            
            return csv;
        }const express = require('express');
const puppeteer = require('puppeteer-core');
const { Pool } = require('pg');
const cron = require('node-cron');

class CleanDebugScraper {
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
                status: 'Clean Debug Scraper Active',
                uptime: process.uptime(),
                urlCount: this.urlsToMonitor.length,
                sessionValid: this.sessionValid,
                cookieCount: this.sessionCookies.length,
                debugLogCount: this.debugLogs.length
            });
        });

        // Dashboard
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
    <title>Clean Debug ASICS Scraper</title>
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
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🐛 Clean Debug ASICS Scraper</h1>
            <p>Cookie-based authentication with extensive debugging</p>
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
            <div class="card">
                <h3>🍪 Session Management</h3>
                <div class="input-group">
                    <label for="cookieString">Session Cookies:</label>
                    <textarea id="cookieString" rows="3" placeholder="Paste your cookies here..."></textarea>
                </div>
                <button onclick="setSessionCookies()" class="btn success">🍪 Set Session</button>
                <button onclick="testSession()" class="btn">🧪 Test Session</button>
                <button onclick="clearSession()" class="btn danger">🗑️ Clear</button>
                <div id="sessionResult" style="margin-top: 10px;"></div>
            </div>

            <div class="card">
                <h3>🔗 URL Management</h3>
                <div class="input-group">
                    <input type="url" id="newUrl" placeholder="https://b2b.asics.com/...">
                </div>
                <button onclick="addUrl()" class="btn">➕ Add URL</button>
                <button onclick="testSingleUrl()" class="btn info">🧪 Test Single URL</button>
                
                <h4 style="margin-top: 15px;">URLs (${this.urlsToMonitor.length}):</h4>
                <ul id="urlList" class="url-list">
                    ${urlListHtml}
                </ul>
            </div>

            <div class="card">
                <h3>🚀 Scraping Controls</h3>
                <button onclick="startScraping()" class="btn success large" ${this.sessionValid ? '' : 'disabled'}>
                    ▶️ Start Scraping
                </button>
                <button onclick="debugSinglePage()" class="btn info">🐛 Debug Single Page</button>
                <button onclick="exportDebugLogs()" class="btn">📋 Export Debug Logs</button>
                <button onclick="exportResults()" class="btn">📄 Export Results CSV</button>
                <button onclick="viewAllResults()" class="btn">👁️ View All Results</button>
                
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

            <div class="card">
                <h3>🐛 Debug Logs</h3>
                <button onclick="refreshDebugLogs()" class="btn">🔄 Refresh Debug</button>
                <button onclick="clearDebugLogs()" class="btn danger">🗑️ Clear Debug</button>
                <div id="debugLogs" class="debug-logs">
                    Click refresh to load debug information...
                </div>
            </div>
        </div>

        <div class="card info">
            <h3>💡 Debug Information</h3>
            <p><strong>Common Issues:</strong></p>
            <ul style="margin: 10px 0 10px 20px;">
                <li><strong>429 errors:</strong> Browserless rate limiting - wait between requests</li>
                <li><strong>0 products found:</strong> Page selectors may need adjustment</li>
                <li><strong>Session invalid:</strong> Cookies may have expired</li>
                <li><strong>Database errors:</strong> Schema may need updating</li>
            </ul>
            
            <div class="code">
                <strong>Quick Cookie Extract:</strong><br>
                document.cookie.split(';').map(c => c.trim()).join('; ')
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
                statusDiv.innerHTML = '<div class="info" style="padding: 10px;">🐛 Debugging single page...</div>';
                
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
                statusDiv.innerHTML = '<div class="info" style="padding: 10px;">🚀 Starting scraping...</div>';
                
                const response = await fetch('/api/start-scraping', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    statusDiv.innerHTML = '<div class="success" style="padding: 10px;">✅ Scraping started!</div>';
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
                            '<div class="success" style="padding: 10px;">🎉 Scraping completed!</div>';
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
                
                // Auto-scroll to bottom
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
                    // Convert to CSV
                    const csvContent = convertToCSV(data.products);
                    
                    // Download CSV
                    const blob = new Blob([csvContent], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'asics-scraper-results-' + new Date().toISOString().split('T')[0] + '.csv';
                    a.click();
                    URL.revokeObjectURL(url);
                    
                    alert('✅ CSV exported with ' + data.products.length + ' products!');
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
                    html += '<h4>All Scraped Products (' + data.products.length + '):</h4>';
                    
                    data.products.forEach((product, index) => {
                        html += '<div style="margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">';
                        html += '<strong>' + (index + 1) + '. ' + product.name + '</strong><br>';
                        html += 'SKU: ' + product.sku + '<br>';
                        html += 'Price: ' + product.price + '<br>';
                        html += 'URL: ' + product.sourceUrl + '<br>';
                        if (product.link) html += 'Product Link: ' + product.link + '<br>';
                        html += 'Scraped: ' + new Date(product.extractedAt).toLocaleString() + '<br>';
                        html += '</div>';
                    });
                    
                    html += '</div>';
                    
                    // Show in a modal-style overlay
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
            const headers = ['Name', 'SKU', 'Price', 'Source URL', 'Product Link', 'Image URL', 'Scraped At'];
            let csv = headers.join(',') + '\\n';
            
            products.forEach(product => {
                const row = [
                    '"' + (product.name || '').replace(/"/g, '""') + '"',
                    '"' + (product.sku || '').replace(/"/g, '""') + '"',
                    '"' + (product.price || '').replace(/"/g, '""') + '"',
                    '"' + (product.sourceUrl || '').replace(/"/g, '""') + '"',
                    '"' + (product.link || '').replace(/"/g, '""') + '"',
                    '"' + (product.imageUrl || '').replace(/"/g, '""') + '"',
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
            
            res.send(dashboardHtml);
        });

        // API Routes
        this.app.post('/api/set-cookies', async (req, res) => {
            try {
                this.addDebugLog('API: Setting cookies');
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

                // Parse cookies from string format
                this.sessionCookies = this.parseCookieString(cookies);
                
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
                
                // Test the session immediately
                this.addDebugLog('Auto-testing session after setting cookies');
                const testResult = await this.testSessionValidity();
                this.sessionValid = testResult.valid;
                
                this.addDebugLog('Auto-test completed', { valid: testResult.valid, message: testResult.message });
                
                res.json({ 
                    success: true, 
                    cookieCount: this.sessionCookies.length,
                    sessionValid: this.sessionValid,
                    testResult: testResult.message,
                    autoTestPassed: testResult.valid
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
                this.addDebugLog('API: Testing session');
                
                if (!this.sessionCookies || this.sessionCookies.length === 0) {
                    this.addDebugLog('No cookies available for testing');
                    return res.json({
                        success: false,
                        error: 'No cookies set. Please set session cookies first.',
                        cookieCount: 0
                    });
                }
                
                await this.rateLimitedBrowserlessRequest();
                
                const result = await this.testSessionValidity();
                this.sessionValid = result.valid;
                
                this.addDebugLog('Session test completed', { valid: result.valid, message: result.message });
                
                res.json({
                    success: result.valid,
                    message: result.message,
                    details: result.details,
                    cookieCount: this.sessionCookies.length
                });
                
            } catch (error) {
                this.addDebugLog('API error testing session', { error: error.message });
                res.json({ 
                    success: false, 
                    error: 'API error: ' + error.message
                });
            }
        });

        this.app.post('/api/debug-page', async (req, res) => {
            try {
                const { url } = req.body;
                this.addDebugLog('Starting single page debug', { url });
                
                if (!this.sessionValid || this.sessionCookies.length === 0) {
                    return res.json({ success: false, error: 'No valid session. Please set cookies first.' });
                }

                await this.rateLimitedBrowserlessRequest();
                
                const result = await this.debugSinglePage(url);
                
                res.json({
                    success: true,
                    productCount: result.products.length,
                    message: 'Debug completed. Check debug logs for details.'
                });
                
            } catch (error) {
                this.addDebugLog('Debug page error', { error: error.message });
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

                this.addDebugLog('Starting scraping session', { urlCount: this.urlsToMonitor.length });
                
                this.scrapingProgress = {
                    active: true,
                    total: this.urlsToMonitor.length,
                    completed: 0,
                    results: []
                };
                
                // Start scraping in background
                setTimeout(() => this.startScraping(), 1000);
                
                res.json({ success: true, message: 'Scraping started', urlCount: this.urlsToMonitor.length });
                
            } catch (error) {
                this.addDebugLog('Error starting scraping', { error: error.message });
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
            res.json(this.debugLogs.slice(0, 50)); // Return last 50 debug logs
        });

        this.app.delete('/api/debug-logs', (req, res) => {
            this.debugLogs = [];
            res.json({ success: true });
        });

        this.app.get('/api/logs', (req, res) => {
            res.json(this.scrapingLogs.slice(-20)); // Return last 20 logs
        });

        // Export results endpoint
        this.app.get('/api/export-results', (req, res) => {
            try {
                // Collect all products from scraping logs
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
                
                this.addDebugLog('Export results requested', { productCount: allProducts.length });
                
                res.json({
                    success: true,
                    products: allProducts,
                    totalProducts: allProducts.length,
                    exportedAt: new Date().toISOString()
                });
                
            } catch (error) {
                this.addDebugLog('Export results error', { error: error.message });
                res.json({
                    success: false,
                    error: error.message,
                    products: []
                });
            }
        });
    }

    parseCookieString(cookieString) {
        try {
            this.addDebugLog('Parsing cookie string', { length: cookieString.length });
            
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
                        } else {
                            this.addDebugLog('Skipped invalid cookie pair', { index: i, pair: trimmed.slice(0, 50) });
                        }
                    }
                }
            }
            
            this.addDebugLog('Cookie parsing completed', { totalParsed: cookies.length });
            return cookies;
            
        } catch (error) {
            this.addDebugLog('Cookie parsing error', { error: error.message });
            return [];
        }
    }

    async testSessionValidity() {
        try {
            this.addDebugLog('Starting session validity test');
            
            if (this.sessionCookies.length === 0) {
                this.addDebugLog('No cookies available for testing');
                return {
                    valid: false,
                    message: 'No cookies set. Please set session cookies first.',
                    details: null
                };
            }
            
            // Connect to browser
            this.addDebugLog('Connecting to Browserless', { endpoint: this.browserlessEndpoint });
            const browser = await puppeteer.connect({
                browserWSEndpoint: this.browserlessEndpoint,
                ignoreHTTPSErrors: true
            });
            
            this.addDebugLog('Browser connected, creating new page');
            const page = await browser.newPage();
            
            // Set user agent to match what works with the extension
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Set additional headers that might be needed for B2B access
            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            });
            
            // Validate and set cookies
            this.addDebugLog('Setting cookies', { count: this.sessionCookies.length });
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
            this.addDebugLog('Cookies set successfully', { validCount: validCookies.length });
            
            // First, navigate to the main B2B portal to establish context
            this.addDebugLog('Establishing B2B session context');
            await page.goto('https://b2b.asics.com/', { 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });
            
            await page.waitForTimeout(2000);
            
            // Now test with a similar order URL to what you provided
            this.addDebugLog('Testing order page access');
            const testOrderUrl = 'https://b2b.asics.com/orders/100454100/products/1011B875?colorCode=600&deliveryDate=2025-06-18';
            
            try {
                await page.goto(testOrderUrl, { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });
                
                await page.waitForTimeout(3000);
                
                // Analyze the result
                const result = await page.evaluate(() => {
                    const url = window.location.href;
                    const title = document.title;
                    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                    
                    const hasLoginForm = document.querySelector('input[type="password"]') !== null;
                    const urlHasLogin = url.includes('login') || url.includes('authentication');
                    const bodyHasLoginText = bodyText.includes('sign in') || bodyText.includes('log in') || bodyText.includes('password');
                    
                    // Check for order/product specific content
                    const hasOrderContent = bodyText.includes('order') || bodyText.includes('product') || bodyText.includes('inventory');
                    const hasQuantityInfo = bodyText.includes('quantity') || bodyText.includes('available') || bodyText.includes('stock');
                    
                    const isLoggedIn = !hasLoginForm && !urlHasLogin && !bodyHasLoginText;
                    const hasOrderAccess = isLoggedIn && (hasOrderContent || hasQuantityInfo);
                    
                    return {
                        url,
                        title,
                        isLoggedIn,
                        hasOrderAccess,
                        hasLoginForm,
                        urlHasLogin,
                        bodyHasLoginText,
                        hasOrderContent,
                        hasQuantityInfo,
                        bodyPreview: bodyText.slice(0, 500)
                    };
                });
                
                await browser.close();
                
                this.addDebugLog('Order page test completed', result);
                
                if (result.isLoggedIn && result.hasOrderAccess) {
                    this.addDebugLog('Session validation: SUCCESS - Order access confirmed');
                    return {
                        valid: true,
                        message: 'Session is active with order access! Ready to scrape order pages.',
                        details: result
                    };
                } else if (result.isLoggedIn) {
                    this.addDebugLog('Session validation: PARTIAL - Logged in but no order access');
                    return {
                        valid: true,
                        message: 'Session is active but may need order context. Try fresh order URLs.',
                        details: result
                    };
                } else {
                    this.addDebugLog('Session validation: FAILED', result);
                    return {
                        valid: false,
                        message: 'Session appears expired or invalid. Please get fresh cookies.',
                        details: result
                    };
                }
                
            } catch (orderError) {
                this.addDebugLog('Order URL test failed, trying basic B2B access', { error: orderError.message });
                
                // Fallback to basic test
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
                        message: 'Basic session active, but order URLs may need fresh context.',
                        details: basicResult
                    };
                } else {
                    return {
                        valid: false,
                        message: 'Session test failed. Please get fresh cookies.',
                        details: basicResult
                    };
                }
            }
            
        } catch (error) {
            this.addDebugLog('Session test error', { error: error.message, stack: error.stack });
            return {
                valid: false,
                message: 'Session test error: ' + error.message,
                details: { error: error.message }
            };
        }
    }

    async debugSinglePage(url) {
        try {
            this.addDebugLog('Debug single page started', { url });
            
            await this.rateLimitedBrowserlessRequest();
            
            const browser = await puppeteer.connect({
                browserWSEndpoint: this.browserlessEndpoint,
                ignoreHTTPSErrors: true
            });
            
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Set additional headers for B2B access
            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'no-cache'
            });
            
            // Set session cookies
            await page.setCookie(...this.sessionCookies);
            this.addDebugLog('Cookies set successfully for page debug');
            
            // If this is an order URL, first establish session context
            if (url.includes('/orders/')) {
                this.addDebugLog('Order URL detected, establishing session context');
                
                try {
                    // First visit the main B2B portal
                    await page.goto('https://b2b.asics.com/', { 
                        waitUntil: 'domcontentloaded', 
                        timeout: 20000 
                    });
                    await page.waitForTimeout(2000);
                    
                    this.addDebugLog('Main portal visited, checking session state');
                    
                    // Check if we're properly logged in
                    const sessionCheck = await page.evaluate(() => {
                        const url = window.location.href;
                        const hasLogin = url.includes('login') || url.includes('authentication');
                        const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                        const hasLoginText = bodyText.includes('sign in') || bodyText.includes('log in');
                        
                        return {
                            url,
                            hasLogin,
                            hasLoginText,
                            isLoggedIn: !hasLogin && !hasLoginText
                        };
                    });
                    
                    this.addDebugLog('Session state check', sessionCheck);
                    
                    if (!sessionCheck.isLoggedIn) {
                        this.addDebugLog('Session context not established, may affect order page access');
                    }
                    
                } catch (contextError) {
                    this.addDebugLog('Failed to establish session context', { error: contextError.message });
                }
            }
            
            this.addDebugLog('Navigating to debug URL', { url });
            
            // Navigate to target URL
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            
            // Get basic page information
            this.addDebugLog('Getting basic page information');
            const basicInfo = await page.evaluate(() => {
                return {
                    url: window.location.href,
                    title: document.title,
                    bodyLength: document.body ? document.body.innerText.length : 0,
                    hasBody: !!document.body,
                    readyState: document.readyState
                };
            });
            
            this.addDebugLog('Basic page info retrieved', basicInfo);
            
            // Wait for any dynamic content to load
            this.addDebugLog('Waiting for page to stabilize');
            await page.waitForTimeout(3000);
            
            // Enhanced page analysis for order pages
            this.addDebugLog('Starting page structure analysis');
            const pageAnalysis = await page.evaluate(() => {
                const url = window.location.href;
                const title = document.title;
                const bodyText = document.body ? document.body.innerText : '';
                
                // Count different element types
                const elementCounts = {
                    divs: document.querySelectorAll('div').length,
                    spans: document.querySelectorAll('span').length,
                    products: document.querySelectorAll('[class*="product"], [data-product]').length,
                    images: document.querySelectorAll('img').length,
                    links: document.querySelectorAll('a').length,
                    forms: document.querySelectorAll('form').length,
                    grids: document.querySelectorAll('[class*="grid"], table').length
                };
                
                // Look for ASICS B2B specific elements
                const asicsElements = {
                    colorElements: document.querySelectorAll('[class*="color"], [data-color]').length,
                    sizeElements: document.querySelectorAll('[class*="size"], [data-size]').length,
                    quantityRows: document.querySelectorAll('tr, [class*="quantity"]').length
                };
                
                // Look for inventory-related text patterns
                const textPatterns = {
                    colorCodes: (bodyText.match(/color[:\s]*[A-Z0-9]{3,}/gi) || []).slice(0, 5),
                    quantities: (bodyText.match(/\d+\s*(qty|quantity|available|stock|units)/gi) || []).slice(0, 5),
                    hasOrderText: bodyText.toLowerCase().includes('order'),
                    hasProductText: bodyText.toLowerCase().includes('product'),
                    hasInventoryText: bodyText.toLowerCase().includes('inventory') || bodyText.toLowerCase().includes('available')
                };
                
                return {
                    url,
                    title,
                    bodyLength: bodyText.length,
                    elementCounts,
                    asicsElements,
                    textPatterns,
                    hasLoginRedirect: url.includes('login') || url.includes('authentication'),
                    bodyPreview: bodyText.slice(0, 500)
                };
            });
            
            this.addDebugLog('Page analysis completed', pageAnalysis);
            
            // Extract products using enhanced selectors
            this.addDebugLog('Starting product extraction');
            const products = await this.extractProductsWithDebugging(page);
            this.addDebugLog('Product extraction completed', { productCount: products.length });
            
            // Get extraction debug info
            const extractionDebug = await page.evaluate(() => {
                return window.extractionDebugInfo || [];
            });
            
            if (extractionDebug.length > 0) {
                this.addDebugLog('Product extraction debug info', { debugMessages: extractionDebug });
            }
            
            this.addDebugLog('Browser closed successfully');
            await browser.close();
            
            this.addDebugLog('Debug single page completed', { 
                productCount: products.length,
                url: pageAnalysis.url,
                title: pageAnalysis.title
            });
            
            return {
                url: pageAnalysis.url,
                products,
                analysis: pageAnalysis,
                extractionDebug
            };
            
        } catch (error) {
            this.addDebugLog('Debug single page error', { url, error: error.message });
            throw error;
        }
    }

    async extractProductsWithDebugging(page) {
        return await page.evaluate(() => {
            const products = [];
            const debugInfo = [];
            
            // Enhanced selectors specifically for ASICS B2B order pages
            const productSelectors = [
                '.product-item',
                '.product-card',
                '.product-tile',
                '.product',
                '[data-product-id]',
                '[data-product]',
                '.grid-item',
                '.item',
                '[class*="product"]',
                // ASICS B2B specific selectors
                '.order-item',
                '.inventory-item',
                '[class*="order"]',
                '[class*="inventory"]',
                'tr[data-product]',
                'tbody tr',
                '.product-row'
            ];
            
            const nameSelectors = [
                '.product-name',
                '.product-title',
                '.name',
                '.title',
                'h1', 'h2', 'h3', 'h4',
                '[class*="name"]',
                '[class*="title"]',
                // ASICS specific
                '.item-name',
                '.model-name',
                '[data-product-name]'
            ];
            
            const priceSelectors = [
                '.price',
                '.product-price',
                '.cost',
                '.amount',
                '.msrp',
                '[class*="price"]',
                '[class*="cost"]',
                // ASICS specific
                '.unit-price',
                '.wholesale-price',
                '[data-price]'
            ];
            
            const skuSelectors = [
                '.sku',
                '.product-id',
                '.style-number',
                '[data-sku]',
                '[data-product-id]',
                '[class*="sku"]',
                // ASICS specific
                '.model-number',
                '.style-code',
                '[data-model]'
            ];
            
            // Inventory-specific selectors
            const quantitySelectors = [
                '.quantity',
                '.stock',
                '.available',
                '.inventory',
                '[class*="quantity"]',
                '[class*="stock"]',
                '[class*="available"]',
                '[data-quantity]',
                'input[type="number"]'
            ];
            
            const colorSelectors = [
                '.color',
                '.colorway',
                '[class*="color"]',
                '[data-color]',
                '.variant'
            ];
            
            const sizeSelectors = [
                '.size',
                '[class*="size"]',
                '[data-size]',
                '.dimension'
            ];
            
            // Try each product selector
            let productElements = [];
            for (const selector of productSelectors) {
                const elements = document.querySelectorAll(selector);
                debugInfo.push('Selector "' + selector + '": ' + elements.length + ' elements');
                if (elements.length > 0 && productElements.length === 0) {
                    productElements = Array.from(elements);
                    debugInfo.push('Using selector: ' + selector);
                    break;
                }
            }
            
            debugInfo.push('Total product elements found: ' + productElements.length);
            
            // If no product containers found, try to extract from the entire page
            if (productElements.length === 0) {
                debugInfo.push('No product containers found, analyzing entire page');
                
                // Look for inventory tables or forms
                const tables = document.querySelectorAll('table');
                const forms = document.querySelectorAll('form');
                
                debugInfo.push('Tables found: ' + tables.length);
                debugInfo.push('Forms found: ' + forms.length);
                
                // Try to extract from table rows
                const rows = document.querySelectorAll('tr');
                if (rows.length > 1) {
                    productElements = Array.from(rows).slice(1); // Skip header row
                    debugInfo.push('Using table rows: ' + productElements.length);
                }
            }
            
            // Extract data from each product element
            productElements.forEach((element, index) => {
                try {
                    let name = '';
                    let price = '';
                    let sku = '';
                    let quantity = '';
                    let color = '';
                    let size = '';
                    
                    // Try to find name
                    for (const selector of nameSelectors) {
                        const nameEl = element.querySelector(selector);
                        if (nameEl && nameEl.textContent?.trim()) {
                            name = nameEl.textContent.trim();
                            break;
                        }
                    }
                    
                    // Try to find price
                    for (const selector of priceSelectors) {
                        const priceEl = element.querySelector(selector);
                        if (priceEl && priceEl.textContent?.trim()) {
                            price = priceEl.textContent.trim();
                            break;
                        }
                    }
                    
                    // Try to find SKU
                    for (const selector of skuSelectors) {
                        const skuEl = element.querySelector(selector);
                        if (skuEl && skuEl.textContent?.trim()) {
                            sku = skuEl.textContent.trim();
                            break;
                        } else if (skuEl && skuEl.getAttribute && skuEl.getAttribute('data-sku')) {
                            sku = skuEl.getAttribute('data-sku');
                            break;
                        }
                    }
                    
                    // Try to find quantity/inventory
                    for (const selector of quantitySelectors) {
                        const qtyEl = element.querySelector(selector);
                        if (qtyEl) {
                            if (qtyEl.value) {
                                quantity = qtyEl.value;
                            } else if (qtyEl.textContent?.trim()) {
                                quantity = qtyEl.textContent.trim();
                            }
                            if (quantity) break;
                        }
                    }
                    
                    // Try to find color
                    for (const selector of colorSelectors) {
                        const colorEl = element.querySelector(selector);
                        if (colorEl && colorEl.textContent?.trim()) {
                            color = colorEl.textContent.trim();
                            break;
                        }
                    }
                    
                    // Try to find size
                    for (const selector of sizeSelectors) {
                        const sizeEl = element.querySelector(selector);
                        if (sizeEl && sizeEl.textContent?.trim()) {
                            size = sizeEl.textContent.trim();
                            break;
                        }
                    }
                    
                    // Get additional data
                    const imageUrl = element.querySelector('img')?.src || '';
                    const link = element.querySelector('a')?.href || '';
                    
                    // Extract any text that might contain inventory info
                    const fullText = element.textContent || '';
                    const inventoryKeywords = ['available', 'stock', 'inventory', 'qty', 'quantity', 'units'];
                    const hasInventoryText = inventoryKeywords.some(keyword => 
                        fullText.toLowerCase().includes(keyword)
                    );
                    
                    if (name || sku || price || quantity || hasInventoryText) {
                        products.push({
                            name: name || 'Product ' + (index + 1),
                            price: price || 'Price not available',
                            sku: sku || 'product-' + index,
                            quantity: quantity || 'Quantity not found',
                            color: color || '',
                            size: size || '',
                            imageUrl,
                            link,
                            inventoryData: hasInventoryText ? fullText.slice(0, 200) : '',
                            extractedAt: new Date().toISOString()
                        });
                        
                        debugInfo.push('Product ' + (index + 1) + ': name="' + name + '" sku="' + sku + '" price="' + price + '" qty="' + quantity + '"');
                    }
                } catch (productError) {
                    debugInfo.push('Error processing product ' + index + ': ' + productError.message);
                }
            });
            
            // If still no products found, try page-level extraction with inventory focus
            if (products.length === 0) {
                debugInfo.push('No products found with standard selectors, trying page-level inventory extraction');
                
                const pageTitle = document.title;
                const bodyText = document.body ? document.body.innerText : '';
                const url = window.location.href;
                
                // Extract SKU from URL if present
                const skuMatch = url.match(/\/products\/([A-Z0-9]+)/i);
                const colorMatch = url.match(/colorCode=([^&]+)/i);
                
                if (skuMatch || pageTitle.includes('Product') || bodyText.includes('inventory')) {
                    products.push({
                        name: pageTitle || 'Order Page Product',
                        price: 'See order details',
                        sku: skuMatch ? skuMatch[1] : 'extracted-from-url',
                        quantity: 'Check page for inventory',
                        color: colorMatch ? colorMatch[1] : '',
                        size: '',
                        imageUrl: '',
                        link: url,
                        inventoryData: bodyText.slice(0, 500),
                        extractedAt: new Date().toISOString()
                    });
                    debugInfo.push('Added page-level product with URL extraction');
                }
            }
            
            // Store debug info in global for access
            window.extractionDebugInfo = debugInfo;
            
            return products;
        });
    }

    async startScraping() {
        const startTime = Date.now();
        const batchId = 'clean_' + Date.now();
        
        this.addDebugLog('Starting clean scraping session', { 
            urlCount: this.urlsToMonitor.length,
            batchId 
        });
        
        try {
            const results = [];
            
            for (let i = 0; i < this.urlsToMonitor.length; i++) {
                const url = this.urlsToMonitor[i];
                
                try {
                    this.addDebugLog('Scraping URL ' + (i + 1) + '/' + this.urlsToMonitor.length, { url });
                    
                    // Rate limit between requests
                    if (i > 0) {
                        await this.rateLimitedBrowserlessRequest();
                    }
                    
                    const result = await this.debugSinglePage(url);
                    
                    const scrapingResult = {
                        url,
                        status: 'success',
                        products: result.products,
                        productCount: result.products.length,
                        timestamp: new Date(),
                        batchId,
                        analysis: result.analysis
                    };
                    
                    results.push(scrapingResult);
                    this.scrapingLogs.unshift(scrapingResult);
                    
                    this.addDebugLog('Scraped ' + result.products.length + ' products from ' + url);
                    
                    // Update progress
                    this.scrapingProgress.completed = i + 1;
                    
                } catch (urlError) {
                    this.addDebugLog('Failed to scrape ' + url, { error: urlError.message });
                    
                    const errorResult = {
                        url,
                        status: 'error',
                        error: urlError.message,
                        productCount: 0,
                        timestamp: new Date(),
                        batchId
                    };
                    
                    results.push(errorResult);
                    this.scrapingLogs.unshift(errorResult);
                    this.scrapingProgress.completed = i + 1;
                }
            }
            
            // Save results
            await this.saveResults(results);
            
            this.scrapingProgress.active = false;
            
            const duration = Math.round((Date.now() - startTime) / 1000);
            this.addDebugLog('Scraping session completed', { 
                duration: duration + 's',
                totalResults: results.length,
                successCount: results.filter(r => r.status === 'success').length
            });
            
        } catch (error) {
            this.addDebugLog('Scraping session failed', { error: error.message });
            this.scrapingProgress.active = false;
        }
    }

    async saveResults(results) {
        if (!this.databaseEnabled || !this.pool) {
            this.addDebugLog('Results saved to memory only (no database)');
            return;
        }

        try {
            this.addDebugLog('Saving results to database', { count: results.length });
            
            for (const result of results) {
                try {
                    await this.pool.query(
                        'INSERT INTO scrape_logs (batch_id, url, status, product_count, error_message, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
                        [
                            result.batchId,
                            result.url,
                            result.status,
                            result.productCount,
                            result.error || null,
                            result.timestamp
                        ]
                    );
                } catch (dbError) {
                    if (dbError.message.includes('column') && dbError.message.includes('does not exist')) {
                        this.addDebugLog('Database schema issue - updating table');
                        await this.updateDatabaseSchema();
                        // Retry the insert
                        await this.pool.query(
                            'INSERT INTO scrape_logs (batch_id, url, status, product_count, error_message, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
                            [
                                result.batchId,
                                result.url,
                                result.status,
                                result.productCount,
                                result.error || null,
                                result.timestamp
                            ]
                        );
                    } else {
                        throw dbError;
                    }
                }
            }
            
            this.addDebugLog('Results saved to database successfully', { count: results.length });
            
        } catch (error) {
            this.addDebugLog('Failed to save results to database', { error: error.message });
        }
    }

    async updateDatabaseSchema() {
        try {
            this.addDebugLog('Updating database schema');
            
            // Add missing columns
            await this.pool.query('ALTER TABLE scrape_logs ADD COLUMN IF NOT EXISTS url VARCHAR(1000)');
            await this.pool.query('ALTER TABLE scrape_logs ADD COLUMN IF NOT EXISTS batch_id VARCHAR(255)');
            await this.pool.query('ALTER TABLE scrape_logs ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT \'pending\'');
            await this.pool.query('ALTER TABLE scrape_logs ADD COLUMN IF NOT EXISTS product_count INTEGER DEFAULT 0');
            await this.pool.query('ALTER TABLE scrape_logs ADD COLUMN IF NOT EXISTS error_message TEXT');
            await this.pool.query('ALTER TABLE scrape_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
            
            this.addDebugLog('Database schema updated successfully');
            
        } catch (error) {
            this.addDebugLog('Failed to update database schema', { error: error.message });
        }
    }

    async saveUrlsToDatabase() {
        if (!this.databaseEnabled || !this.pool) return;

        try {
            await this.pool.query('DELETE FROM monitored_urls');
            
            for (const url of this.urlsToMonitor) {
                await this.pool.query(
                    'INSERT INTO monitored_urls (url, created_at) VALUES ($1, $2)',
                    [url, new Date()]
                );
            }
            
            this.addDebugLog('URLs saved to database', { count: this.urlsToMonitor.length });
            
        } catch (error) {
            this.addDebugLog('Failed to save URLs to database', { error: error.message });
        }
    }

    async loadUrlsToMonitor() {
        if (!this.databaseEnabled || !this.pool) {
            this.setDefaultUrls();
            return;
        }

        try {
            const result = await this.pool.query('SELECT url FROM monitored_urls ORDER BY created_at DESC');
            
            if (result.rows.length > 0) {
                this.urlsToMonitor = result.rows.map(row => row.url);
                this.addDebugLog('URLs loaded from database', { count: this.urlsToMonitor.length });
            } else {
                this.setDefaultUrls();
                this.addDebugLog('No URLs in database, using defaults');
            }
            
        } catch (error) {
            this.addDebugLog('Failed to load URLs from database', { error: error.message });
            this.setDefaultUrls();
        }
    }

    async initializeDatabase() {
        if (!this.databaseEnabled || !this.pool) {
            this.addDebugLog('Running in memory-only mode');
            return;
        }

        try {
            this.addDebugLog('Initializing database');
            await this.pool.query('SELECT NOW()');
            this.addDebugLog('Database connection successful');
            
            // Create tables with all necessary columns
            await this.pool.query(
                'CREATE TABLE IF NOT EXISTS monitored_urls (id SERIAL PRIMARY KEY, url VARCHAR(1000) NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
            );
            
            await this.pool.query(
                'CREATE TABLE IF NOT EXISTS scrape_logs (id SERIAL PRIMARY KEY, url VARCHAR(1000), status VARCHAR(50) DEFAULT \'pending\', product_count INTEGER DEFAULT 0, error_message TEXT, batch_id VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
            );

            this.addDebugLog('Database initialization completed');
            
        } catch (error) {
            this.addDebugLog('Database initialization failed', { error: error.message });
            this.databaseEnabled = false;
            throw error;
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        try {
            this.addDebugLog('Starting Clean Debug ASICS Scraper');
            
            this.app.listen(this.port, () => {
                console.log('🐛 Clean Debug Scraper running on port ' + this.port);
                console.log('📊 Dashboard available at /dashboard');
                console.log('🎯 Ready for extensive debugging!');
                this.addDebugLog('Server started successfully', { port: this.port });
            });
            
        } catch (error) {
            this.addDebugLog('Failed to start scraper', { error: error.message });
            console.error('❌ Failed to start scraper:', error);
            process.exit(1);
        }
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

const scraper = new CleanDebugScraper();
scraper.start().catch(error => {
    console.error('❌ Startup failed:', error);
    process.exit(1);
});
