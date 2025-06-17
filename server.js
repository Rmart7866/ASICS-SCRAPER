const express = require('express');
const puppeteer = require('puppeteer-core');
const { Pool } = require('pg');
const cron = require('node-cron');

class CookieBasedScraper {
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

        // Browserless configuration
        this.browserlessToken = process.env.BROWSERLESS_TOKEN;
        if (this.browserlessToken) {
            this.browserlessEndpoint = `wss://production-sfo.browserless.io?token=${this.browserlessToken}`;
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

    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static('public'));
    }

    setupRoutes() {
        // Health check
        this.app.get('/', (req, res) => {
            res.json({
                status: 'Cookie-Based Scraper Active',
                uptime: process.uptime(),
                urlCount: this.urlsToMonitor.length,
                sessionValid: this.sessionValid,
                cookieCount: this.sessionCookies.length
            });
        });

        // Dashboard
        this.app.get('/dashboard', (req, res) => {
            res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cookie-Based ASICS Scraper</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { background: white; padding: 30px; border-radius: 10px; margin-bottom: 30px; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .card { background: white; padding: 25px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
        .danger { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        .btn { background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 5px; cursor: pointer; margin: 5px; font-size: 14px; }
        .btn:hover { background: #0056b3; }
        .btn.success { background: #28a745; }
        .btn.success:hover { background: #218838; }
        .btn.danger { background: #dc3545; }
        .btn.danger:hover { background: #c82333; }
        .btn.large { padding: 16px 32px; font-size: 16px; }
        .input-group { margin: 15px 0; }
        .input-group label { display: block; margin-bottom: 5px; font-weight: bold; }
        .input-group textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-family: monospace; font-size: 12px; }
        .input-group input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
        .logs { max-height: 400px; overflow-y: auto; background: #f8f9fa; padding: 15px; border-radius: 5px; font-family: monospace; font-size: 12px; }
        .url-list { list-style: none; }
        .url-item { background: #f8f9fa; padding: 10px; margin: 5px 0; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
        .step { margin: 15px 0; padding: 15px; background: #e7f3ff; border-radius: 8px; border-left: 4px solid #007bff; }
        .step-number { background: #007bff; color: white; border-radius: 50%; width: 25px; height: 25px; display: inline-flex; align-items: center; justify-content: center; margin-right: 10px; font-weight: bold; }
        .code { background: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 12px; margin: 10px 0; }
        .hidden { display: none; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🍪 Cookie-Based ASICS Scraper</h1>
            <p>Reliable authentication using session cookies</p>
            <div style="margin-top: 15px;">
                <span class="btn ${this.sessionValid ? 'success' : 'danger'}" style="cursor: default;">
                    ${this.sessionValid ? '✅ Session Active' : '❌ No Session'}
                </span>
                <span class="btn" style="background: #6c757d; cursor: default;">
                    ${this.urlsToMonitor.length} URLs
                </span>
            </div>
        </div>

        <div class="card ${this.sessionValid ? 'success' : 'warning'}">
            <h3>${this.sessionValid ? '✅ Ready to Scrape!' : '🔐 Authentication Required'}</h3>
            <p>${this.sessionValid ? 
                'Session is active and ready for scraping.' : 
                'Please set up your session cookies to start scraping.'
            }</p>
        </div>

        <div class="card">
            <h3>🎯 How Cookie Authentication Works</h3>
            <p style="margin-bottom: 20px;">This method is much more reliable than automated login because it works with any authentication system (2FA, CAPTCHA, etc.).</p>
            
            <div class="step">
                <div style="display: flex; align-items: center; margin-bottom: 10px;">
                    <span class="step-number">1</span>
                    <strong>Login Manually</strong>
                </div>
                <p>Open ASICS B2B in your browser and log in normally</p>
                <button onclick="openAsicsLogin()" class="btn">🔗 Open ASICS B2B</button>
            </div>

            <div class="step">
                <div style="display: flex; align-items: center; margin-bottom: 10px;">
                    <span class="step-number">2</span>
                    <strong>Extract Cookies</strong>
                </div>
                <p>After logging in, press F12 → Console → Paste this code:</p>
                <div class="code">
document.cookie.split(';').map(c => c.trim()).join('; ')
                </div>
                <button onclick="copyCodeToClipboard()" class="btn">📋 Copy Code</button>
            </div>

            <div class="step">
                <div style="display: flex; align-items: center; margin-bottom: 10px;">
                    <span class="step-number">3</span>
                    <strong>Set Session</strong>
                </div>
                <p>Copy the result from step 2 and paste it below:</p>
                <div class="input-group">
                    <label for="cookieString">Session Cookies:</label>
                    <textarea id="cookieString" rows="4" placeholder="Paste your cookies here..."></textarea>
                </div>
                <button onclick="setSessionCookies()" class="btn success">🍪 Set Session</button>
                <button onclick="testSession()" class="btn">🧪 Test Session</button>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <h3>🔗 URL Management</h3>
                <div class="input-group">
                    <label for="newUrl">Add ASICS B2B URL:</label>
                    <input type="url" id="newUrl" placeholder="https://b2b.asics.com/us/en-us/...">
                </div>
                <button onclick="addUrl()" class="btn">➕ Add URL</button>
                
                <h4 style="margin-top: 20px;">Current URLs (${this.urlsToMonitor.length}):</h4>
                <ul id="urlList" class="url-list">
                    ${this.urlsToMonitor.map((url, index) => `
                        <li class="url-item">
                            <span style="word-break: break-all; font-size: 12px;">${url}</span>
                            <button onclick="removeUrl(${index})" class="btn danger">❌</button>
                        </li>
                    `).join('')}
                </ul>
            </div>

            <div class="card">
                <h3>🚀 Scraping Controls</h3>
                <button onclick="startScraping()" class="btn success large" ${this.sessionValid ? '' : 'disabled style="opacity: 0.5;"'}>
                    ▶️ Start Scraping
                </button>
                <button onclick="clearSession()" class="btn danger">🗑️ Clear Session</button>
                
                <div id="scrapingStatus" style="margin-top: 20px;"></div>
                <div id="progressBar" style="margin-top: 10px;"></div>
            </div>
        </div>

        <div class="card">
            <h3>📊 Recent Logs</h3>
            <button onclick="refreshLogs()" class="btn">🔄 Refresh</button>
            <div id="logs" class="logs">
                Click refresh to load recent activity...
            </div>
        </div>
    </div>

    <script>
        function openAsicsLogin() {
            window.open('https://b2b.asics.com/authentication/login', '_blank');
        }

        function copyCodeToClipboard() {
            const code = "document.cookie.split(';').map(c => c.trim()).join('; ')";
            navigator.clipboard.writeText(code).then(() => {
                alert('✅ Code copied to clipboard! Paste it in the ASICS browser console.');
            });
        }

        async function setSessionCookies() {
            const cookieString = document.getElementById('cookieString').value.trim();
            
            if (!cookieString) {
                alert('Please paste your cookies first!');
                return;
            }

            try {
                const response = await fetch('/api/set-cookies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookies: cookieString })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    alert('✅ Session cookies set successfully!');
                    location.reload();
                } else {
                    alert('❌ Failed to set cookies: ' + result.error);
                }
            } catch (error) {
                alert('❌ Error: ' + error.message);
            }
        }

        async function testSession() {
            try {
                const response = await fetch('/api/test-session');
                const result = await response.json();
                
                if (result.success) {
                    alert('✅ Session is valid! Ready to scrape.');
                } else {
                    alert('❌ Session test failed: ' + result.error);
                }
            } catch (error) {
                alert('❌ Error testing session: ' + error.message);
            }
        }

        async function clearSession() {
            if (!confirm('Clear current session?')) return;
            
            try {
                const response = await fetch('/api/clear-session', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    alert('✅ Session cleared!');
                    location.reload();
                }
            } catch (error) {
                alert('❌ Error: ' + error.message);
            }
        }

        async function startScraping() {
            try {
                document.getElementById('scrapingStatus').innerHTML = 
                    '<div style="color: blue; padding: 10px; background: #e7f3ff; border-radius: 4px;">🚀 Starting scraping...</div>';
                
                const response = await fetch('/api/start-scraping', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    document.getElementById('scrapingStatus').innerHTML = 
                        '<div style="color: green; padding: 10px; background: #d4edda; border-radius: 4px;">✅ Scraping started!</div>';
                    
                    pollProgress();
                } else {
                    document.getElementById('scrapingStatus').innerHTML = 
                        '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px;">❌ Failed: ' + result.error + '</div>';
                }
            } catch (error) {
                document.getElementById('scrapingStatus').innerHTML = 
                    '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px;">❌ Error: ' + error.message + '</div>';
            }
        }

        async function pollProgress() {
            try {
                const response = await fetch('/api/scraping-progress');
                const data = await response.json();
                
                if (data.active) {
                    const progress = (data.completed / data.total) * 100;
                    document.getElementById('progressBar').innerHTML = \`
                        <div style="background: #f0f0f0; border-radius: 4px; padding: 5px; margin-top: 10px;">
                            <div style="background: #28a745; height: 20px; width: \${progress}%; border-radius: 4px; transition: width 0.3s;"></div>
                            <div style="text-align: center; margin-top: 5px; font-size: 12px;">
                                \${data.completed} of \${data.total} URLs completed (\${Math.round(progress)}%)
                            </div>
                        </div>
                    \`;
                    
                    if (data.completed < data.total) {
                        setTimeout(pollProgress, 2000);
                    } else {
                        document.getElementById('scrapingStatus').innerHTML = 
                            '<div style="color: green; padding: 10px; background: #d4edda; border-radius: 4px;">🎉 Scraping completed!</div>';
                    }
                }
            } catch (error) {
                console.error('Error polling progress:', error);
            }
        }

        // URL Management
        async function addUrl() {
            const url = document.getElementById('newUrl').value.trim();
            if (!url) {
                alert('Please enter a URL');
                return;
            }

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
                const response = await fetch(\`/api/urls/\${index}\`, { method: 'DELETE' });
                const result = await response.json();
                if (result.success) {
                    location.reload();
                } else {
                    alert('❌ Error: ' + result.error);
                }
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
                    logsContainer.innerHTML = logs.map(log => \`
                        <div style="margin: 5px 0; padding: 8px; border-left: 3px solid \${log.status === 'success' ? '#28a745' : '#dc3545'}; background: \${log.status === 'success' ? '#d4edda' : '#f8d7da'};">
                            <strong>\${new Date(log.timestamp).toLocaleString()}:</strong> \${log.url}<br>
                            <span style="font-size: 11px;">Status: \${log.status} | Products: \${log.productCount || 0}\${log.error ? ' | Error: ' + log.error : ''}</span>
                        </div>
                    \`).join('');
                } else {
                    logsContainer.innerHTML = '<div style="color: #666; font-style: italic;">No logs available yet.</div>';
                }
            } catch (error) {
                document.getElementById('logs').innerHTML = '<div style="color: red;">Error loading logs: ' + error.message + '</div>';
            }
        }

        // Auto-refresh status every 30 seconds
        setInterval(() => {
            fetch('/').then(r => r.json()).then(data => {
                // Could update session status without full reload
            }).catch(() => {});
        }, 30000);
    </script>
</body>
</html>
            `);
        });

        // API Routes
        this.app.post('/api/set-cookies', async (req, res) => {
            try {
                const { cookies } = req.body;
                
                if (!cookies || typeof cookies !== 'string') {
                    return res.json({ success: false, error: 'Invalid cookies provided' });
                }

                // Parse cookies from string format
                this.sessionCookies = this.parseCookieString(cookies);
                
                if (this.sessionCookies.length === 0) {
                    return res.json({ success: false, error: 'No valid cookies found' });
                }

                console.log(`🍪 Set ${this.sessionCookies.length} session cookies`);
                
                // Test the session immediately
                const testResult = await this.testSessionValidity();
                this.sessionValid = testResult.valid;
                
                res.json({ 
                    success: true, 
                    cookieCount: this.sessionCookies.length,
                    sessionValid: this.sessionValid,
                    testResult: testResult.message
                });
                
            } catch (error) {
                console.error('❌ Error setting cookies:', error.message);
                res.json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/test-session', async (req, res) => {
            try {
                const result = await this.testSessionValidity();
                this.sessionValid = result.valid;
                
                res.json({
                    success: result.valid,
                    message: result.message,
                    details: result.details
                });
                
            } catch (error) {
                console.error('❌ Error testing session:', error.message);
                res.json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/clear-session', (req, res) => {
            this.sessionCookies = [];
            this.sessionValid = false;
            console.log('🗑️ Session cleared');
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

                console.log('🚀 Starting cookie-based scraping...');
                
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
                console.error('❌ Error starting scraping:', error.message);
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
                
                console.log(`➕ Added URL: ${url}`);
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
                
                console.log(`🗑️ Deleted URL: ${deletedUrl}`);
                res.json({ success: true });
                
            } catch (error) {
                res.json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/logs', (req, res) => {
            res.json(this.scrapingLogs.slice(-20)); // Return last 20 logs
        });
    }

    parseCookieString(cookieString) {
        try {
            const cookies = [];
            const cookiePairs = cookieString.split(';');
            
            for (const pair of cookiePairs) {
                const trimmed = pair.trim();
                if (trimmed) {
                    const [name, ...valueParts] = trimmed.split('=');
                    const value = valueParts.join('=');
                    
                    if (name && value) {
                        cookies.push({
                            name: name.trim(),
                            value: value.trim(),
                            domain: '.asics.com',
                            path: '/',
                            httpOnly: false,
                            secure: true
                        });
                    }
                }
            }
            
            return cookies;
            
        } catch (error) {
            console.error('❌ Error parsing cookies:', error.message);
            return [];
        }
    }

    async testSessionValidity() {
        try {
            console.log('🧪 Testing session validity...');
            
            const browser = await puppeteer.connect({
                browserWSEndpoint: this.browserlessEndpoint
            });
            
            const page = await browser.newPage();
            
            // Set cookies
            await page.setCookie(...this.sessionCookies);
            
            // Test by accessing a protected ASICS page
            await page.goto('https://b2b.asics.com/us/en-us', { 
                waitUntil: 'networkidle0', 
                timeout: 30000 
            });
            
            const result = await page.evaluate(() => {
                const url = window.location.href;
                const title = document.title;
                const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                
                // Check if we're logged in (not redirected to login)
                const isLoggedIn = !url.includes('login') && 
                                 !url.includes('authentication') && 
                                 !bodyText.includes('sign in') &&
                                 !bodyText.includes('log in');
                
                return {
                    url,
                    title,
                    isLoggedIn,
                    bodyPreview: bodyText.slice(0, 200)
                };
            });
            
            await browser.close();
            
            if (result.isLoggedIn) {
                console.log('✅ Session is valid!');
                return {
                    valid: true,
                    message: 'Session is active and working',
                    details: result
                };
            } else {
                console.log('❌ Session is invalid or expired');
                return {
                    valid: false,
                    message: 'Session appears to be expired or invalid',
                    details: result
                };
            }
            
        } catch (error) {
            console.error('❌ Session test failed:', error.message);
            return {
                valid: false,
                message: 'Session test failed: ' + error.message,
                details: null
            };
        }
    }

    async startScraping() {
        const startTime = Date.now();
        const batchId = `cookie_${Date.now()}`;
        
        console.log(`🚀 Starting cookie-based scraping: ${this.urlsToMonitor.length} URLs`);
        
        try {
            const browser = await puppeteer.connect({
                browserWSEndpoint: this.browserlessEndpoint
            });
            
            const results = [];
            
            for (let i = 0; i < this.urlsToMonitor.length; i++) {
                const url = this.urlsToMonitor[i];
                
                try {
                    console.log(`🔍 Scraping (${i + 1}/${this.urlsToMonitor.length}): ${url}`);
                    
                    const page = await browser.newPage();
                    
                    // Set session cookies
                    await page.setCookie(...this.sessionCookies);
                    
                    // Navigate to URL
                    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
                    
                    // Extract products
                    const products = await this.extractProducts(page);
                    
                    const result = {
                        url,
                        status: 'success',
                        products,
                        productCount: products.length,
                        timestamp: new Date(),
                        batchId
                    };
                    
                    results.push(result);
                    this.scrapingLogs.unshift(result);
                    
                    console.log(`✅ Scraped ${products.length} products from ${url}`);
                    
                    await page.close();
                    
                    // Update progress
                    this.scrapingProgress.completed = i + 1;
                    
                    // Delay between requests
                    if (i < this.urlsToMonitor.length - 1) {
                        await this.delay(3000);
                    }
                    
                } catch (urlError) {
                    console.error(`❌ Failed to scrape ${url}:`, urlError.message);
                    
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
            
            await browser.close();
            
            // Save results to database
            await this.saveResults(results);
            
            this.scrapingProgress.active = false;
            
            const duration = Math.round((Date.now() - startTime) / 1000);
            console.log(`✅ Cookie-based scraping completed in ${duration} seconds`);
            
        } catch (error) {
            console.error(`❌ Scraping failed:`, error.message);
            this.scrapingProgress.active = false;
        }
    }

    async extractProducts(page) {
        return await page.evaluate(() => {
            const products = [];
            
            // Look for product elements with various selectors
            const productSelectors = [
                '.product-item',
                '.product-card',
                '.product-tile',
                '.product',
                '[data-product-id]',
                '.grid-item'
            ];
            
            let productElements = [];
            for (const selector of productSelectors) {
                productElements = document.querySelectorAll(selector);
                if (productElements.length > 0) break;
            }
            
            productElements.forEach((element, index) => {
                try {
                    const name = element.querySelector([
                        '.product-name',
                        '.product-title',
                        'h1', 'h2', 'h3', 'h4',
                        '.title',
                        '.name'
                    ].join(', '))?.textContent?.trim();
                    
                    const price = element.querySelector([
                        '.price',
                        '.product-price',
                        '.cost',
                        '.amount'
                    ].join(', '))?.textContent?.trim();
                    
                    const sku = element.querySelector([
                        '.sku',
                        '.product-id',
                        '.style-number'
                    ].join(', '))?.textContent?.trim() || 
                    element.getAttribute('data-sku') ||
                    element.getAttribute('data-product-id');
                    
                    const imageUrl = element.querySelector('img')?.src;
                    const link = element.querySelector('a')?.href;
                    
                    if (name || sku) {
                        products.push({
                            name: name || 'Unknown Product',
                            price: price || 'Price not available',
                            sku: sku || `product-${index}`,
                            imageUrl: imageUrl || '',
                            link: link || '',
                            extractedAt: new Date().toISOString()
                        });
                    }
                } catch (productError) {
                    console.log('Error processing product:', productError);
                }
            });
            
            return products;
        });
    }

    async saveResults(results) {
        if (!this.databaseEnabled || !this.pool) {
            console.log('📊 Results saved to memory only (no database)');
            return;
        }

        try {
            for (const result of results) {
                await this.pool.query(`
                    INSERT INTO scrape_logs (batch_id, url, status, product_count, error_message, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    result.batchId,
                    result.url,
                    result.status,
                    result.productCount,
                    result.error || null,
                    result.timestamp
                ]);
            }
            
            console.log(`💾 Saved ${results.length} results to database`);
            
        } catch (error) {
            console.error('⚠️ Failed to save results to database:', error.message);
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
            const result = await this.pool.query('SELECT url FROM monitored_urls ORDER BY created_at DESC');
            
            if (result.rows.length > 0) {
                this.urlsToMonitor = result.rows.map(row => row.url);
                console.log(`📋 Loaded ${this.urlsToMonitor.length} URLs from database`);
            } else {
                this.setDefaultUrls();
            }
            
        } catch (error) {
            console.error('⚠️ Could not load URLs from database:', error.message);
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
            await this.pool.query('SELECT NOW()');
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

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        try {
            console.log('🚀 Starting Cookie-Based ASICS Scraper...');
            
            this.app.listen(this.port, () => {
                console.log(`🍪 Cookie-Based Scraper running on port ${this.port}`);
                console.log('📊 Dashboard available at /dashboard');
                console.log('🎯 Ready for cookie-based authentication!');
            });
            
        } catch (error) {
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

const scraper = new CookieBasedScraper();
scraper.start().catch(error => {
    console.error('❌ Startup failed:', error);
    process.exit(1);
});
