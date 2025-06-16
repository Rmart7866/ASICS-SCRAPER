const express = require('express');
const puppeteer = require('puppeteer-core');
const { Pool } = require('pg');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;

class ASICSWeeklyBatchScraper {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 10000;
        
        // Debug environment variables first
        console.log('🔍 Environment Variables Check:');
        console.log('   NODE_ENV:', process.env.NODE_ENV);
        console.log('   DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
        console.log('   ASICS_USERNAME:', process.env.ASICS_USERNAME ? 'SET' : 'NOT SET');
        console.log('   ASICS_PASSWORD:', process.env.ASICS_PASSWORD ? 'SET' : 'NOT SET');
        console.log('   BROWSERLESS_TOKEN:', process.env.BROWSERLESS_TOKEN ? 'SET' : 'NOT SET');
        console.log('   BROWSERLESS_ENDPOINT:', process.env.BROWSERLESS_ENDPOINT || 'NOT SET');
        
        // Database configuration
        if (process.env.DATABASE_URL) {
            console.log('🗄️ Using DATABASE_URL for connection');
            this.pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                max: 10,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 10000,
            });
            this.databaseEnabled = true;
        } else {
            console.log('⚠️ No database configuration - running in memory mode');
            this.pool = null;
            this.databaseEnabled = false;
        }

        // ASICS credentials
        this.credentials = {
            username: process.env.ASICS_USERNAME,
            password: process.env.ASICS_PASSWORD
        };

        // Browserless Cloud configuration
        this.browserlessToken = process.env.BROWSERLESS_TOKEN;
        
        if (process.env.BROWSERLESS_ENDPOINT) {
            this.browserlessEndpoint = process.env.BROWSERLESS_ENDPOINT;
            // If it's a cloud endpoint but doesn't have a token, add it
            if (this.browserlessEndpoint.includes('browserless.io') && this.browserlessToken && !this.browserlessEndpoint.includes('token=')) {
                this.browserlessEndpoint += `?token=${this.browserlessToken}`;
            }
        } else if (this.browserlessToken) {
            // Build cloud endpoint with token
            this.browserlessEndpoint = `wss://chrome.browserless.io?token=${this.browserlessToken}`;
        } else {
            // Default to self-hosted
            this.browserlessEndpoint = 'ws://browserless:3000';
        }
        
        this.isSelfHosted = !this.browserlessEndpoint.includes('browserless.io');

        if (!this.credentials.username || !this.credentials.password) {
            console.warn('⚠️ ASICS credentials not set - authentication will fail');
        } else {
            console.log('✅ ASICS credentials configured');
        }

        if (this.isSelfHosted) {
            console.log('🐳 Using self-hosted Browserless at:', this.browserlessEndpoint);
        } else {
            console.log('☁️ Using Browserless cloud service at:', this.browserlessEndpoint);
            if (!this.browserlessToken) {
                console.warn('⚠️ BROWSERLESS_TOKEN not set - cloud service will fail');
            } else {
                console.log('✅ Browserless token configured');
            }
        }

        // Scraping configuration
        this.config = {
            batchSize: 5,
            delayBetweenRequests: 30000, // 30 seconds
            maxRetries: 3,
            timeout: 60000
        };

        // URLs to monitor
        this.urlsToMonitor = [];
        
        // In-memory storage for results
        this.inMemoryLogs = [];
        this.inMemoryProducts = [];
        
        this.setupMiddleware();
        this.setupRoutes();
        
        // Initialize database and load URLs
        this.initializeDatabase().then(() => {
            this.loadUrlsToMonitor();
        }).catch(error => {
            console.error('⚠️ Database initialization failed, using defaults:', error.message);
            this.databaseEnabled = false;
            this.setDefaultUrls();
        });
    }

    setDefaultUrls() {
        this.urlsToMonitor = [
            'https://b2b.asics.com/us/en-us/mens-running-shoes',
            'https://b2b.asics.com/us/en-us/womens-running-shoes'
        ];
        console.log('📋 Using default URLs');
    }

    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static('public'));
        
        this.app.use((req, res, next) => {
            if (Math.random() < 0.1) {
                const memUsage = process.memoryUsage();
                const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;
                console.log('💾 Memory usage:', {
                    heapUsed: formatMB(memUsage.heapUsed),
                    rss: formatMB(memUsage.rss)
                });
            }
            next();
        });
    }

    setupRoutes() {
        // Health check
        this.app.get('/', (req, res) => {
            res.json({
                status: 'ASICS Weekly Batch Scraper Active (Browserless Cloud)',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                config: this.config,
                urlCount: this.urlsToMonitor.length,
                databaseEnabled: this.databaseEnabled,
                browser: this.isSelfHosted ? 'Self-Hosted Browserless' : 'Browserless Cloud',
                browserlessEndpoint: this.browserlessEndpoint.replace(/token=[^&]+/, 'token=***'),
                environment: {
                    DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT SET',
                    ASICS_USERNAME: process.env.ASICS_USERNAME ? 'SET' : 'NOT SET',
                    ASICS_PASSWORD: process.env.ASICS_PASSWORD ? 'SET' : 'NOT SET',
                    BROWSERLESS_TOKEN: process.env.BROWSERLESS_TOKEN ? 'SET' : 'NOT SET',
                    BROWSERLESS_ENDPOINT: this.browserlessEndpoint.replace(/token=[^&]+/, 'token=***')
                }
            });
        });

        // Dashboard with URL management
        this.app.get('/dashboard', (req, res) => {
            const serviceType = this.isSelfHosted ? 'Self-Hosted Browserless' : 'Browserless Cloud';
            const serviceIcon = this.isSelfHosted ? '🐳' : '☁️';
            
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>ASICS Scraper Dashboard (${serviceType})</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
                        .container { max-width: 1200px; margin: 0 auto; }
                        .card { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                        .status { background: #f0f8ff; }
                        .success { background: #d4edda; border: 1px solid #c3e6cb; }
                        .warning { background: #fff3cd; border: 1px solid #ffeaa7; }
                        .cloud-service { background: #e8f4fd; border: 1px solid #2196f3; }
                        .self-hosted { background: #e8f5e8; border: 1px solid #4caf50; }
                        .url-list { max-height: 300px; overflow-y: auto; }
                        .url-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; border: 1px solid #ddd; margin: 5px 0; border-radius: 4px; background: #f9f9f9; }
                        .url-text { flex: 1; font-family: monospace; word-break: break-all; font-size: 12px; }
                        .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin-left: 5px; }
                        .btn-primary { background: #007bff; color: white; }
                        .btn-success { background: #28a745; color: white; }
                        .btn-danger { background: #dc3545; color: white; }
                        .btn-warning { background: #ffc107; color: black; }
                        .form-group { margin: 10px 0; }
                        .form-control { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
                        .logs { max-height: 300px; overflow-y: auto; background: #f8f9fa; padding: 10px; border-radius: 5px; font-family: monospace; font-size: 12px; }
                        .flex { display: flex; gap: 10px; align-items: center; }
                        .hidden { display: none; }
                        .examples { background: #e7f3ff; padding: 15px; border-radius: 5px; margin: 15px 0; }
                        .examples ul { margin: 10px 0; }
                        .examples li { margin: 5px 0; font-family: monospace; font-size: 12px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🚀 ASICS B2B Scraper Dashboard (${serviceType})</h1>
                        
                        <div class="card status">
                            <h2>Status: Active ✅</h2>
                            <p>Uptime: ${Math.floor(process.uptime() / 60)} minutes</p>
                            <p>Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB</p>
                            <p>Database: ${this.databaseEnabled ? '✅ Connected' : '⚠️ Memory-only mode'}</p>
                            <p>ASICS Credentials: ${this.credentials.username ? '✅ Configured' : '⚠️ Missing'}</p>
                            <p>Browser: ${serviceIcon} ${serviceType}</p>
                            <p>Browserless Token: ${this.browserlessToken ? '✅ Configured' : '⚠️ Missing'}</p>
                        </div>
                        
                        <div class="card ${this.isSelfHosted ? 'self-hosted' : 'cloud-service'}">
                            <h3>${serviceIcon} ${serviceType} Active!</h3>
                            ${this.isSelfHosted ? `
                                <p><strong>✅ FREE forever</strong> - no subscription fees or API limits</p>
                                <p><strong>✅ Full control</strong> - your own browser infrastructure</p>
                                <p><strong>✅ No deployment issues</strong> - containers handle everything</p>
                                <p><strong>✅ Privacy & security</strong> - data never leaves your servers</p>
                            ` : `
                                <p><strong>✅ FREE tier</strong> - 1,000 units per month included</p>
                                <p><strong>✅ Managed infrastructure</strong> - no server maintenance</p>
                                <p><strong>✅ Global availability</strong> - fast worldwide access</p>
                                <p><strong>✅ Automatic scaling</strong> - handles traffic spikes</p>
                            `}
                            <p><strong>Endpoint:</strong> <code>${this.browserlessEndpoint.replace(/token=[^&]+/, 'token=***')}</code></p>
                        </div>
                        
                        ${this.credentials.username && (this.browserlessToken || this.isSelfHosted) ? `
                        <div class="card success">
                            <h3>✅ Ready to Scrape ASICS B2B!</h3>
                            <p>ASICS credentials configured and Browserless ready.</p>
                        </div>
                        ` : `
                        <div class="card warning">
                            <h3>⚠️ Configuration Needed</h3>
                            <p>Make sure these environment variables are set:</p>
                            <ul>
                                <li>ASICS_USERNAME ${this.credentials.username ? '✅' : '❌'}</li>
                                <li>ASICS_PASSWORD ${this.credentials.password ? '✅' : '❌'}</li>
                                <li>BROWSERLESS_TOKEN ${this.browserlessToken ? '✅' : '❌'} ${this.isSelfHosted ? '(not needed for self-hosted)' : ''}</li>
                            </ul>
                        </div>
                        `}
                        
                        <div class="card">
                            <h3>📋 URL Management</h3>
                            <div class="form-group">
                                <label for="newUrl">Add New URL:</label>
                                <div class="flex">
                                    <input type="url" id="newUrl" class="form-control" placeholder="https://b2b.asics.com/orders/123/products/1013A142?colorCode=401" />
                                    <button onclick="addUrl()" class="btn btn-success">➕ Add URL</button>
                                </div>
                            </div>
                            
                            <div class="examples">
                                <h4>📝 Example ASICS B2B URLs:</h4>
                                <p><strong>Individual Product Pages:</strong></p>
                                <ul>
                                    <li>https://b2b.asics.com/orders/[ORDER-ID]/products/[SKU]?colorCode=[COLOR]</li>
                                    <li>https://b2b.asics.com/us/en-us/product/[SKU]</li>
                                </ul>
                                <p><strong>Category Pages:</strong></p>
                                <ul>
                                    <li>https://b2b.asics.com/us/en-us/mens-running-shoes</li>
                                    <li>https://b2b.asics.com/us/en-us/womens-running-shoes</li>
                                </ul>
                                <p><strong>Note:</strong> Individual product URLs require being logged into ASICS B2B.</p>
                            </div>
                            
                            <h4>Current URLs (${this.urlsToMonitor.length}):</h4>
                            <div id="urlList" class="url-list">
                                ${this.urlsToMonitor.map((url, index) => `
                                    <div class="url-item" data-index="${index}">
                                        <span class="url-text">${url}</span>
                                        <div>
                                            <button onclick="editUrl(${index})" class="btn btn-warning">✏️ Edit</button>
                                            <button onclick="deleteUrl(${index})" class="btn btn-danger">🗑️ Delete</button>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                            
                            ${this.urlsToMonitor.length === 0 ? `
                            <div class="warning" style="padding: 15px; margin: 10px 0;">
                                <p><strong>No URLs configured!</strong> Add some ASICS B2B URLs above.</p>
                            </div>
                            ` : ''}
                        </div>
                        
                        <div class="card">
                            <h3>🎯 Quick Actions</h3>
                            <button onclick="triggerBatch()" class="btn btn-primary">
                                ${serviceIcon} Trigger ${serviceType} Batch
                            </button>
                            <button onclick="viewLogs()" class="btn btn-success">
                                📋 View Recent Logs
                            </button>
                            <button onclick="testBrowserless()" class="btn btn-warning">
                                🧪 Test Browserless Connection
                            </button>
                            <div id="result" style="margin-top: 10px;"></div>
                            <div id="logs" class="logs hidden"></div>
                        </div>
                    </div>
                    
                    <script>
                        async function addUrl() {
                            const urlInput = document.getElementById('newUrl');
                            const url = urlInput.value.trim();
                            
                            if (!url) {
                                alert('Please enter a URL');
                                return;
                            }
                            
                            if (!url.startsWith('http')) {
                                alert('URL must start with http:// or https://');
                                return;
                            }
                            
                            try {
                                const response = await fetch('/urls', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ url })
                                });
                                
                                const data = await response.json();
                                
                                if (data.success) {
                                    urlInput.value = '';
                                    location.reload();
                                } else {
                                    alert('Error: ' + data.error);
                                }
                            } catch (error) {
                                alert('Error adding URL: ' + error.message);
                            }
                        }
                        
                        async function deleteUrl(index) {
                            if (!confirm('Are you sure you want to delete this URL?')) {
                                return;
                            }
                            
                            try {
                                const response = await fetch(\`/urls/\${index}\`, {
                                    method: 'DELETE'
                                });
                                
                                const data = await response.json();
                                
                                if (data.success) {
                                    location.reload();
                                } else {
                                    alert('Error: ' + data.error);
                                }
                            } catch (error) {
                                alert('Error deleting URL: ' + error.message);
                            }
                        }
                        
                        async function editUrl(index) {
                            const currentUrl = document.querySelector(\`[data-index="\${index}"] .url-text\`).textContent;
                            const newUrl = prompt('Edit URL:', currentUrl);
                            
                            if (!newUrl || newUrl === currentUrl) {
                                return;
                            }
                            
                            if (!newUrl.startsWith('http')) {
                                alert('URL must start with http:// or https://');
                                return;
                            }
                            
                            try {
                                const response = await fetch(\`/urls/\${index}\`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ url: newUrl })
                                });
                                
                                const data = await response.json();
                                
                                if (data.success) {
                                    location.reload();
                                } else {
                                    alert('Error: ' + data.error);
                                }
                            } catch (error) {
                                alert('Error updating URL: ' + error.message);
                            }
                        }
                        
                        async function triggerBatch() {
                            const button = event.target;
                            const result = document.getElementById('result');
                            
                            button.disabled = true;
                            button.textContent = '⏳ Starting batch...';
                            result.innerHTML = '';
                            
                            try {
                                const response = await fetch('/trigger', {method: 'POST'});
                                const data = await response.json();
                                
                                if (data.success) {
                                    result.innerHTML = '<div style="color: green; padding: 10px; background: #d4edda; border-radius: 4px; margin: 10px 0;">✅ Batch started! Check logs for progress.</div>';
                                } else {
                                    result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px; margin: 10px 0;">❌ ' + data.error + '</div>';
                                }
                            } catch (error) {
                                result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px; margin: 10px 0;">❌ ' + error.message + '</div>';
                            }
                            
                            button.disabled = false;
                            button.textContent = '${serviceIcon} Trigger ${serviceType} Batch';
                        }
                        
                        async function testBrowserless() {
                            const result = document.getElementById('result');
                            result.innerHTML = '<div style="color: blue; padding: 10px; background: #e7f3ff; border-radius: 4px; margin: 10px 0;">🧪 Testing Browserless connection...</div>';
                            
                            try {
                                const response = await fetch('/test-browserless');
                                const data = await response.json();
                                
                                if (data.success) {
                                    result.innerHTML = '<div style="color: green; padding: 10px; background: #d4edda; border-radius: 4px; margin: 10px 0;">✅ Browserless connection successful!</div>';
                                } else {
                                    result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px; margin: 10px 0;">❌ Browserless test failed: ' + data.error + '</div>';
                                }
                            } catch (error) {
                                result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px; margin: 10px 0;">❌ Test failed: ' + error.message + '</div>';
                            }
                        }
                        
                        async function viewLogs() {
                            const logs = document.getElementById('logs');
                            logs.classList.remove('hidden');
                            logs.innerHTML = 'Loading...';
                            
                            try {
                                const response = await fetch('/logs');
                                const data = await response.json();
                                
                                if (Array.isArray(data) && data.length > 0) {
                                    logs.innerHTML = data.map(log => 
                                        \`<div style="margin: 5px 0; padding: 5px; border-left: 3px solid #007bff;"><strong>\${log.created_at || log.timestamp || 'Unknown time'}:</strong> \${log.url} - \${log.status} (\${log.product_count || 0} products)\${log.error_message ? ' - ' + log.error_message : ''}</div>\`
                                    ).join('');
                                } else {
                                    logs.innerHTML = '<div style="color: #666; font-style: italic;">No logs available yet. Try running a batch first.</div>';
                                }
                            } catch (error) {
                                logs.innerHTML = '<div style="color: red;">Error loading logs: ' + error.message + '</div>';
                            }
                        }
                        
                        document.getElementById('newUrl').addEventListener('keypress', function(e) {
                            if (e.key === 'Enter') {
                                addUrl();
                            }
                        });
                    </script>
                </body>
                </html>
            `);
        });

        // Test Browserless connection endpoint with detailed debugging
        this.app.get('/test-browserless', async (req, res) => {
            try {
                const serviceType = this.isSelfHosted ? 'self-hosted' : 'cloud';
                console.log(`🧪 Testing ${serviceType} Browserless connection...`);
                console.log(`🔗 Endpoint: ${this.browserlessEndpoint.replace(/token=[^&]+/, 'token=***')}`);
                console.log(`🔑 Token present: ${this.browserlessToken ? 'YES' : 'NO'}`);
                
                // First, test the REST API to see if token works
                if (!this.isSelfHosted && this.browserlessToken) {
                    console.log('🔍 Testing REST API first...');
                    try {
                        const fetch = require('https').get;
                        const testResponse = await new Promise((resolve, reject) => {
                            const req = require('https').get(
                                `https://production-sfo.browserless.io/json/version?token=${this.browserlessToken}`,
                                (res) => {
                                    let data = '';
                                    res.on('data', (chunk) => data += chunk);
                                    res.on('end', () => resolve({ status: res.statusCode, data }));
                                }
                            );
                            req.on('error', reject);
                            req.setTimeout(10000, () => reject(new Error('Timeout')));
                        });
                        
                        console.log(`📊 REST API response: ${testResponse.status}`);
                        if (testResponse.status !== 200) {
                            return res.json({
                                success: false,
                                error: `REST API failed with status ${testResponse.status}`,
                                details: testResponse.data
                            });
                        }
                    } catch (restError) {
                        console.error('❌ REST API test failed:', restError.message);
                        return res.json({
                            success: false,
                            error: `REST API test failed: ${restError.message}`
                        });
                    }
                }
                
                console.log('🔌 Testing WebSocket connection...');
                const browser = await puppeteer.connect({
                    browserWSEndpoint: this.browserlessEndpoint
                });
                
                const page = await browser.newPage();
                await page.goto('data:text/html,<h1>Browserless Test</h1>');
                const title = await page.title();
                await browser.close();
                
                console.log(`✅ ${serviceType} Browserless connection successful!`);
                res.json({ 
                    success: true, 
                    message: `${serviceType} Browserless connection successful`, 
                    title,
                    endpoint: this.browserlessEndpoint.replace(/token=[^&]+/, 'token=***')
                });
                
            } catch (error) {
                console.error(`❌ Browserless connection failed:`, error.message);
                console.error(`🔗 Failed endpoint: ${this.browserlessEndpoint.replace(/token=[^&]+/, 'token=***')}`);
                res.json({ 
                    success: false, 
                    error: error.message,
                    endpoint: this.browserlessEndpoint.replace(/token=[^&]+/, 'token=***'),
                    tokenPresent: !!this.browserlessToken
                });
            }
        });

        // URL Management APIs
        this.app.get('/urls', (req, res) => {
            res.json({
                success: true,
                urls: this.urlsToMonitor,
                count: this.urlsToMonitor.length
            });
        });

        this.app.post('/urls', async (req, res) => {
            try {
                const { url } = req.body;
                
                if (!url || !url.startsWith('http')) {
                    return res.status(400).json({
                        success: false,
                        error: 'Valid URL required'
                    });
                }
                
                if (this.urlsToMonitor.includes(url)) {
                    return res.status(400).json({
                        success: false,
                        error: 'URL already exists'
                    });
                }
                
                this.urlsToMonitor.push(url);
                await this.saveUrlsToDatabase();
                
                console.log(`➕ Added URL: ${url}`);
                res.json({
                    success: true,
                    message: 'URL added successfully',
                    urls: this.urlsToMonitor
                });
                
            } catch (error) {
                console.error('Error adding URL:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        this.app.put('/urls/:index', async (req, res) => {
            try {
                const index = parseInt(req.params.index);
                const { url } = req.body;
                
                if (index < 0 || index >= this.urlsToMonitor.length) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid URL index'
                    });
                }
                
                if (!url || !url.startsWith('http')) {
                    return res.status(400).json({
                        success: false,
                        error: 'Valid URL required'
                    });
                }
                
                const oldUrl = this.urlsToMonitor[index];
                this.urlsToMonitor[index] = url;
                await this.saveUrlsToDatabase();
                
                console.log(`✏️ Updated URL: ${oldUrl} -> ${url}`);
                res.json({
                    success: true,
                    message: 'URL updated successfully',
                    urls: this.urlsToMonitor
                });
                
            } catch (error) {
                console.error('Error updating URL:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        this.app.delete('/urls/:index', async (req, res) => {
            try {
                const index = parseInt(req.params.index);
                
                if (index < 0 || index >= this.urlsToMonitor.length) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid URL index'
                    });
                }
                
                const deletedUrl = this.urlsToMonitor.splice(index, 1)[0];
                await this.saveUrlsToDatabase();
                
                console.log(`🗑️ Deleted URL: ${deletedUrl}`);
                res.json({
                    success: true,
                    message: 'URL deleted successfully',
                    deletedUrl,
                    urls: this.urlsToMonitor
                });
                
            } catch (error) {
                console.error('Error deleting URL:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        this.app.post('/trigger', async (req, res) => {
            try {
                if (this.urlsToMonitor.length === 0) {
                    return res.status(400).json({
                        success: false,
                        error: 'No URLs configured. Add some URLs first!'
                    });
                }
                
                const serviceType = this.isSelfHosted ? 'self-hosted' : 'cloud';
                console.log(`🎯 Manual ${serviceType} batch trigger received`);
                const batchId = `manual_${Date.now()}`;
                
                setTimeout(() => this.startWeeklyBatch(batchId), 1000);
                
                res.json({ 
                    success: true, 
                    message: `${serviceType} batch started in background`, 
                    batchId,
                    urlCount: this.urlsToMonitor.length,
                    browser: this.isSelfHosted ? 'Self-Hosted Browserless' : 'Browserless Cloud'
                });
            } catch (error) {
                console.error('❌ Manual trigger failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.get('/logs', (req, res) => {
            try {
                if (this.databaseEnabled && this.pool) {
                    this.pool.query(`
                        SELECT * FROM scrape_logs 
                        ORDER BY created_at DESC 
                        LIMIT 50
                    `).then(result => {
                        res.json(result.rows);
                    }).catch(error => {
                        console.error('Database query failed, returning memory logs:', error.message);
                        res.json(this.inMemoryLogs.slice(-50));
                    });
                } else {
                    res.json(this.inMemoryLogs.slice(-50));
                }
            } catch (error) {
                res.json(this.inMemoryLogs.slice(-50));
            }
        });
    }

    async saveUrlsToDatabase() {
        if (!this.databaseEnabled || !this.pool) {
            console.log('📊 URLs saved to memory only (no database)');
            return;
        }

        try {
            await this.pool.query('DELETE FROM monitored_urls');
            
            for (const url of this.urlsToMonitor) {
                await this.pool.query(
                    'INSERT INTO monitored_urls (url, created_at) VALUES ($1, $2)',
                    [url, new Date()]
                );
            }
            
            console.log(`💾 Saved ${this.urlsToMonitor.length} URLs to database`);
            
        } catch (error) {
            console.error('⚠️ Could not save URLs to database:', error.message);
        }
    }

    async loadUrlsToMonitor() {
        if (!this.databaseEnabled || !this.pool) {
            this.setDefaultUrls();
            return;
        }

        try {
            const result = await this.pool.query(`
                SELECT url FROM monitored_urls 
                ORDER BY created_at DESC
            `);
            
            if (result.rows.length > 0) {
                this.urlsToMonitor = result.rows.map(row => row.url);
                console.log(`📋 Loaded ${this.urlsToMonitor.length} URLs from database`);
            } else {
                this.setDefaultUrls();
            }
            
        } catch (error) {
            console.error('⚠️ Could not load URLs from database, using defaults:', error.message);
            this.setDefaultUrls();
        }
    }

    async initializeDatabase() {
        if (!this.databaseEnabled || !this.pool) {
            console.log('📊 Running in memory-only mode');
            return;
        }

        try {
            console.log('🗄️ Initializing database...');
            const testResult = await this.pool.query('SELECT NOW() as current_time');
            console.log('✅ Database connection successful!');
            
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
                    url VARCHAR(1000) NOT NULL,
                    status VARCHAR(50) DEFAULT 'pending',
                    product_count INTEGER DEFAULT 0,
                    error_message TEXT,
                    batch_id VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            console.log('✅ Database initialization completed');
            
        } catch (error) {
            console.error('⚠️ Database initialization failed:', error.message);
            this.databaseEnabled = false;
            throw error;
        }
    }

    setupScheduler() {
        cron.schedule('0 2 * * 0', async () => {
            const serviceType = this.isSelfHosted ? 'self-hosted' : 'cloud';
            console.log(`📅 Weekly scheduled ${serviceType} batch starting...`);
            const batchId = `scheduled_${Date.now()}`;
            await this.startWeeklyBatch(batchId);
        }, {
            timezone: "America/New_York"
        });
        
        console.log('📅 Starting weekly scheduler - every Sunday at 2:00 AM');
    }

    async startWeeklyBatch(batchId) {
        const startTime = Date.now();
        console.log(`🚀 Starting weekly batch ${batchId}: ${this.urlsToMonitor.length} URLs`);
        
        if (this.urlsToMonitor.length === 0) {
            console.log('⚠️ No URLs configured - skipping batch');
            return;
        }
        
        try {
            const batches = [];
            for (let i = 0; i < this.urlsToMonitor.length; i += this.config.batchSize) {
                batches.push(this.urlsToMonitor.slice(i, i + this.config.batchSize));
            }
            
            const allResults = [];
            
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                console.log(`📦 Mini-batch ${i + 1}/${batches.length}: ${batch.length} URLs`);
                
                try {
                    const batchResults = await this.processBatch(batch, batchId);
                    allResults.push(...batchResults);
                    
                    if (i < batches.length - 1) {
                        console.log(`⏳ Waiting ${this.config.delayBetweenRequests / 1000}s before next batch...`);
                        await this.delay(this.config.delayBetweenRequests);
                    }
                    
                } catch (batchError) {
                    console.error(`❌ Mini-batch ${i + 1} failed:`, batchError.message);
                }
            }
            
            await this.processResults(allResults, batchId);
            
            const duration = Math.round((Date.now() - startTime) / 1000);
            console.log(`✅ Weekly batch ${batchId} completed in ${duration} seconds`);
            
        } catch (error) {
            console.error(`❌ Weekly batch ${batchId} failed:`, error.message);
        }
    }

    async processBatch(urls, batchId) {
        const results = [];
        let browser = null;
        let page = null;
        
        try {
            const authResult = await this.getAuthenticatedBrowser();
            browser = authResult.browser;
            page = authResult.page;
            
            for (const url of urls) {
                try {
                    console.log(`🔍 Scraping: ${url}`);
                    const result = await this.scrapeUrl(page, url);
                    result.batchId = batchId;
                    results.push(result);
                    
                } catch (urlError) {
                    console.error(`❌ Failed to scrape ${url}:`, urlError.message);
                    results.push({
                        url,
                        status: 'error',
                        error: urlError.message,
                        batchId,
                        products: []
                    });
                }
                
                await this.delay(2000);
            }
            
        } catch (batchError) {
            console.error('❌ Batch authentication error:', batchError);
            throw batchError;
            
        } finally {
            if (browser) {
                await browser.close();
            }
        }
        
        return results;
    }

    // Cloud or Self-hosted Browserless authentication
    async getAuthenticatedBrowser() {
        const serviceType = this.isSelfHosted ? 'SELF-HOSTED' : 'CLOUD';
        console.log(`🌐 Using ${serviceType} Browserless for ASICS B2B authentication...`);
        
        // Connect to Browserless (cloud or self-hosted)
        const browser = await puppeteer.connect({
            browserWSEndpoint: this.browserlessEndpoint
        });

        try {
            const page = await browser.newPage();
            
            // Set realistic user agent and viewport
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1366, height: 768 });
            
            console.log(`🚀 [${serviceType}] Navigating to ASICS B2B login...`);
            await page.goto('https://b2b.asics.com/authentication/login', { 
                waitUntil: 'networkidle0',
                timeout: 30000 
            });

            const currentUrl = page.url();
            const title = await page.title();
            console.log(`📋 [${serviceType}] Current URL: ${currentUrl}`);
            console.log(`📋 [${serviceType}] Page title: ${title}`);

            // Check page content
            const pageState = await page.evaluate(() => {
                const bodyText = document.body ? document.body.innerText.slice(0, 500) : '';
                const hasCountrySelection = bodyText.includes('Please Select The Region') || 
                                          bodyText.includes('Americas') || 
                                          bodyText.includes('United States');
                const hasLoginForm = document.querySelector('input[type="password"]') !== null;
                
                return {
                    title: document.title,
                    url: window.location.href,
                    bodyText,
                    hasCountrySelection,
                    hasLoginForm
                };
            });

            console.log(`📊 [${serviceType}] Page content check:`, pageState);

            // Handle country selection
            if (pageState.hasCountrySelection && !pageState.hasLoginForm) {
                console.log(`🌍 [${serviceType}] Country selection detected, clicking United States...`);
                
                try {
                    await page.click('text=United States');
                    console.log(`⏳ [${serviceType}] Waiting for login form...`);
                    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
                    console.log(`✅ [${serviceType}] Login form appeared`);
                    
                    // Debug: Let's see what inputs are available now
                    const availableInputs = await page.evaluate(() => {
                        const inputs = Array.from(document.querySelectorAll('input'));
                        return inputs.map(input => ({
                            type: input.type,
                            name: input.name,
                            id: input.id,
                            placeholder: input.placeholder,
                            className: input.className
                        }));
                    });
                    console.log(`🔍 [${serviceType}] Available inputs:`, availableInputs);
                    
                } catch (e) {
                    throw new Error('Login form did not appear after country selection');
                }
            }

            // Find and fill login fields using the discovered selectors
            const usernameSelector = '#username';
            const passwordSelector = '#password';

            console.log(`🔍 [${serviceType}] Looking for username field...`);
            await page.waitForSelector(usernameSelector, { timeout: 15000 });
            console.log(`🔍 [${serviceType}] Looking for password field...`);
            await page.waitForSelector(passwordSelector, { timeout: 10000 });

            console.log(`📝 [${serviceType}] Filling in credentials...`);
            await page.type(usernameSelector, this.credentials.username);
            await page.type(passwordSelector, this.credentials.password);

            console.log(`🔐 [${serviceType}] Submitting login form...`);
            
            // More robust form submission - don't wait for navigation
            try {
                // Try to find and click submit button
                const submitButton = await page.$('button[type="submit"], input[type="submit"], button');
                if (submitButton) {
                    console.log(`🔘 [${serviceType}] Found submit button, clicking...`);
                    await submitButton.click();
                } else {
                    console.log(`⌨️ [${serviceType}] No submit button found, trying Enter key...`);
                    await page.keyboard.press('Enter');
                }
                
                // Wait a bit for the submission to process
                await page.waitForTimeout(5000);
                
                // Check if we're still on the login page or redirected
                const currentUrl = page.url();
                console.log(`🔍 [${serviceType}] After login attempt, current URL: ${currentUrl}`);
                
                // If we're still on login page, login likely failed
                if (currentUrl.includes('login') || currentUrl.includes('authentication')) {
                    // Check for error messages
                    const errorMsg = await page.evaluate(() => {
                        const errorElements = document.querySelectorAll('.error, .alert, [class*="error"], [class*="alert"]');
                        return Array.from(errorElements).map(el => el.textContent.trim()).join('; ');
                    });
                    
                    if (errorMsg) {
                        throw new Error(`Login failed with error: ${errorMsg}`);
                    } else {
                        throw new Error('Still on login page after submission - credentials may be incorrect');
                    }
                }
                
            } catch (submitError) {
                console.error(`❌ [${serviceType}] Form submission error:`, submitError.message);
                
                // Try one more approach - direct navigation wait
                try {
                    console.log(`🔄 [${serviceType}] Trying alternative navigation approach...`);
                    await page.waitForFunction(
                        () => !window.location.href.includes('login') && !window.location.href.includes('authentication'),
                        { timeout: 15000 }
                    );
                    console.log(`✅ [${serviceType}] Successfully navigated away from login`);
                } catch (navError) {
                    throw new Error(`Login failed: ${submitError.message}`);
                }
            }

            const finalUrl = page.url();
            console.log(`✅ [${serviceType}] Authentication complete. Final URL: ${finalUrl}`);

            if (finalUrl.includes('login') || finalUrl.includes('authentication')) {
                throw new Error('Authentication failed - still on login page');
            }

            return { browser, page };

        } catch (error) {
            console.error(`❌ [${serviceType}] Authentication failed:`, error.message);
            await browser.close();
            throw error;
        }
    }

    async scrapeUrl(page, url) {
        const startTime = Date.now();
        
        try {
            console.log(`🔍 Navigating to: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle0', timeout: this.config.timeout });
            
            await page.waitForTimeout(3000);
            
            // Enhanced product scraping
            const products = await page.evaluate(() => {
                const productElements = document.querySelectorAll([
                    '.product-item',
                    '.product-card', 
                    '.product-tile',
                    '.product',
                    '[data-product-id]',
                    '.grid-item',
                    '.product-details'
                ].join(', '));
                
                const products = [];
                
                productElements.forEach((element, index) => {
                    try {
                        const name = element.querySelector([
                            '.product-name',
                            '.product-title', 
                            '.name',
                            'h1', 'h2', 'h3',
                            '.title'
                        ].join(', '))?.textContent?.trim();
                        
                        const price = element.querySelector([
                            '.price',
                            '.product-price',
                            '[class*="price"]',
                            '.msrp'
                        ].join(', '))?.textContent?.trim();
                        
                        const sku = element.querySelector([
                            '.sku',
                            '.product-id',
                            '[data-sku]',
                            '.style-number'
                        ].join(', '))?.textContent?.trim() || 
                        element.getAttribute('data-sku');
                        
                        const imageUrl = element.querySelector('img')?.src;
                        const link = element.querySelector('a')?.href;
                        
                        if (name || sku || price) {
                            products.push({
                                name: name || '',
                                price: price || '',
                                sku: sku || `auto-${index}`,
                                imageUrl: imageUrl || '',
                                link: link || '',
                                description: ''
                            });
                        }
                    } catch (productError) {
                        console.log('Error processing product:', productError);
                    }
                });
                
                // Fallback for product pages
                if (products.length === 0) {
                    const pageTitle = document.title;
                    const bodyText = document.body ? document.body.innerText : '';
                    
                    if (pageTitle && (bodyText.includes('SKU') || bodyText.includes('Price') || window.location.href.includes('product'))) {
                        products.push({
                            name: pageTitle,
                            price: 'See page for pricing',
                            sku: 'page-detected',
                            imageUrl: '',
                            link: window.location.href,
                            description: 'Product page detected'
                        });
                    }
                }
                
                return products;
            });
            
            const duration = Date.now() - startTime;
            console.log(`✅ Scraped ${products.length} products from ${url} in ${duration}ms`);
            
            return {
                url,
                status: 'success',
                products,
                productCount: products.length,
                duration,
                timestamp: new Date()
            };
            
        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`❌ Failed to scrape ${url}:`, error.message);
            
            return {
                url,
                status: 'error',
                error: error.message,
                products: [],
                productCount: 0,
                duration,
                timestamp: new Date()
            };
        }
    }

    async logScrapeResults(results, batchId = null) {
        if (!results || results.length === 0) {
            console.log('📊 No results to log');
            return;
        }

        this.inMemoryLogs.push(...results.map(r => ({
            ...r,
            batch_id: batchId,
            created_at: new Date().toISOString()
        })));

        if (this.inMemoryLogs.length > 1000) {
            this.inMemoryLogs = this.inMemoryLogs.slice(-1000);
        }

        console.log(`📊 Logged ${results.length} results to memory`);

        if (this.databaseEnabled && this.pool) {
            try {
                const insertQuery = `
                    INSERT INTO scrape_logs (batch_id, url, status, product_count, error_message, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `;
                
                for (const result of results) {
                    await this.pool.query(insertQuery, [
                        batchId,
                        result.url,
                        result.status || 'completed',
                        result.productCount || result.products?.length || 0,
                        result.error || null,
                        new Date()
                    ]);
                }

                console.log(`✅ Also logged ${results.length} results to database`);
                
            } catch (error) {
                console.error('⚠️ Database logging failed:', error.message);
            }
        }
    }

    async processResults(results, batchId) {
        console.log(`📊 Processing batch ${batchId} results: ${results.length} total records`);
        
        if (results.length === 0) {
            console.log('⚠️ No results to process');
            return;
        }

        try {
            await this.logScrapeResults(results, batchId);
            
            const successfulResults = results.filter(r => r.status === 'success' && r.products?.length > 0);
            const failedResults = results.filter(r => r.status === 'error' || !r.products || r.products.length === 0);
            
            console.log(`✅ Successful scrapes: ${successfulResults.length}`);
            console.log(`❌ Failed scrapes: ${failedResults.length}`);
            
            let totalProducts = 0;
            successfulResults.forEach(result => {
                totalProducts += result.products?.length || 0;
            });
            
            console.log(`🛍️ Total products scraped: ${totalProducts}`);
            
        } catch (error) {
            console.error('❌ Error processing results:', error.message);
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        try {
            const serviceType = this.isSelfHosted ? 'Self-Hosted Browserless' : 'Browserless Cloud';
            console.log(`🚀 Initializing ASICS Weekly Batch Scraper with ${serviceType}...`);
            console.log(`${this.isSelfHosted ? '🐳' : '☁️'} Using ${serviceType.toLowerCase()} - ${this.isSelfHosted ? 'no external dependencies' : 'managed infrastructure'}!`);
            
            const memUsage = process.memoryUsage();
            const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;
            console.log('💾 Memory available:', {
                heapUsed: formatMB(memUsage.heapUsed),
                rss: formatMB(memUsage.rss)
            });

            this.app.listen(this.port, () => {
                console.log(`🚀 ASICS Weekly Batch Scraper running on port ${this.port}`);
                console.log('📊 Dashboard available at /dashboard');
            });

            this.setupScheduler();
            
            console.log(`✅ Weekly batch scraper initialized with ${this.urlsToMonitor.length} URLs`);
            console.log(`${this.isSelfHosted ? '🐳' : '☁️'} Browser: ${serviceType}`);

        } catch (error) {
            console.error('❌ Failed to start scraper:', error);
            process.exit(1);
        }
    }
}

process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

const scraper = new ASICSWeeklyBatchScraper();
scraper.start().catch(error => {
    console.error('❌ Startup failed:', error);
    process.exit(1);
});
