const express = require('express');
const puppeteer = require('puppeteer-core');
const { Pool } = require('pg');
const cron = require('node-cron');

class ASICSManualLoginScraper {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 10000;
        
        // Debug environment variables 
        console.log('🔍 Environment Variables Check:');
        console.log('   NODE_ENV:', process.env.NODE_ENV);
        console.log('   DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
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

        // Browserless configuration
        this.browserlessToken = process.env.BROWSERLESS_TOKEN;
        
        if (process.env.BROWSERLESS_ENDPOINT) {
            this.browserlessEndpoint = process.env.BROWSERLESS_ENDPOINT;
            if (this.browserlessEndpoint.includes('browserless.io') && this.browserlessToken && !this.browserlessEndpoint.includes('token=')) {
                this.browserlessEndpoint += `?token=${this.browserlessToken}`;
            }
        } else if (this.browserlessToken) {
            this.browserlessEndpoint = `wss://production-sfo.browserless.io?token=${this.browserlessToken}`;
        } else {
            this.browserlessEndpoint = 'ws://browserless:3000';
        }
        
        this.isSelfHosted = !this.browserlessEndpoint.includes('browserless.io');

        console.log(`${this.isSelfHosted ? '🐳' : '☁️'} Using ${this.isSelfHosted ? 'self-hosted' : 'cloud'} Browserless`);
        if (!this.isSelfHosted && !this.browserlessToken) {
            console.warn('⚠️ BROWSERLESS_TOKEN not set - cloud service will fail');
        }

        // Scraping configuration
        this.config = {
            batchSize: 5,
            delayBetweenRequests: 5000, // 5 seconds between URLs
            maxRetries: 3,
            timeout: 60000
        };

        // URLs to monitor
        this.urlsToMonitor = [];
        
        // In-memory storage for results
        this.inMemoryLogs = [];
        this.activeBrowser = null; // Store the authenticated browser session
        this.scrapingProgress = { active: false, total: 0, completed: 0 };
        
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
    }

    setupRoutes() {
        // Health check
        this.app.get('/', (req, res) => {
            res.json({
                status: 'ASICS Manual Login Scraper Active',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                config: this.config,
                urlCount: this.urlsToMonitor.length,
                databaseEnabled: this.databaseEnabled,
                browser: this.isSelfHosted ? 'Self-Hosted Browserless' : 'Browserless Cloud',
                authStatus: this.activeBrowser ? 'Logged In' : 'Not Logged In'
            });
        });

        // Enhanced Dashboard
        this.app.get('/dashboard', (req, res) => {
            const serviceType = this.isSelfHosted ? 'Self-Hosted Browserless' : 'Browserless Cloud';
            const serviceIcon = this.isSelfHosted ? '🐳' : '☁️';
            
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>ASICS Manual Login Scraper Dashboard</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
                        .container { max-width: 1200px; margin: 0 auto; }
                        .card { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                        .status { background: #f0f8ff; }
                        .success { background: #d4edda; border: 1px solid #c3e6cb; }
                        .warning { background: #fff3cd; border: 1px solid #ffeaa7; }
                        .info { background: #e7f3ff; border: 1px solid #2196f3; }
                        .url-list { max-height: 300px; overflow-y: auto; }
                        .url-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; border: 1px solid #ddd; margin: 5px 0; border-radius: 4px; background: #f9f9f9; }
                        .url-text { flex: 1; font-family: monospace; word-break: break-all; font-size: 12px; }
                        .btn { padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; margin: 5px; font-weight: bold; font-size: 14px; }
                        .btn-primary { background: #007bff; color: white; }
                        .btn-success { background: #28a745; color: white; }
                        .btn-danger { background: #dc3545; color: white; }
                        .btn-warning { background: #ffc107; color: black; }
                        .btn-large { padding: 16px 32px; font-size: 16px; }
                        .form-group { margin: 10px 0; }
                        .form-control { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
                        .logs { max-height: 300px; overflow-y: auto; background: #f8f9fa; padding: 10px; border-radius: 5px; font-family: monospace; font-size: 12px; }
                        .flex { display: flex; gap: 10px; align-items: center; }
                        .hidden { display: none; }
                        .auth-status { text-align: center; padding: 20px; }
                        .logged-in { background: #d4edda; color: #155724; }
                        .logged-out { background: #f8d7da; color: #721c24; }
                        .step-number { background: #007bff; color: white; border-radius: 50%; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; margin-right: 10px; }
                        .examples { background: #e7f3ff; padding: 15px; border-radius: 5px; margin: 15px 0; }
                        .examples ul { margin: 10px 0; }
                        .examples li { margin: 5px 0; font-family: monospace; font-size: 12px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🚀 ASICS Simple Authentication Scraper</h1>
                        
                        <div class="card status">
                            <h2>Status: Active ✅</h2>
                            <p>Uptime: ${Math.floor(process.uptime() / 60)} minutes</p>
                            <p>Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB</p>
                            <p>Database: ${this.databaseEnabled ? '✅ Connected' : '⚠️ Memory-only mode'}</p>
                            <p>Browser: ${serviceIcon} ${serviceType}</p>
                        </div>

                        <div class="card auth-status ${this.activeBrowser ? 'logged-in' : 'logged-out'}">
                            <h3>${this.activeBrowser ? '✅ ASICS B2B Session Active' : '❌ Not Logged Into ASICS B2B'}</h3>
                            <p>${this.activeBrowser ? 'You are logged in and ready to scrape!' : 'You need to authenticate first before scraping.'}</p>
                        </div>
                        
                        <div class="card info">
                            <h3>🎯 How Simple Authentication Works</h3>
                            <div style="display: flex; align-items: center; margin: 10px 0;">
                                <span class="step-number">1</span>
                                <span>Click "Login to ASICS B2B" below</span>
                            </div>
                            <div style="display: flex; align-items: center; margin: 10px 0;">
                                <span class="step-number">2</span>
                                <span>Enter your ASICS B2B credentials</span>
                            </div>
                            <div style="display: flex; align-items: center; margin: 10px 0;">
                                <span class="step-number">3</span>
                                <span>Scraper authenticates automatically</span>
                            </div>
                            <div style="display: flex; align-items: center; margin: 10px 0;">
                                <span class="step-number">4</span>
                                <span>Click "Start Auto Scraping" to scrape all URLs!</span>
                            </div>
                        </div>
                        
                        <div class="card">
                            <h3>🎯 Quick Actions</h3>
                            <div style="text-align: center;">
                                <button onclick="startLogin()" class="btn btn-primary btn-large">
                                    🔐 Login to ASICS B2B
                                </button>
                                <button onclick="startScraping()" class="btn btn-success btn-large" ${this.activeBrowser ? '' : 'disabled style="opacity: 0.5;"'}>
                                    🚀 Start Auto Scraping
                                </button>
                                <button onclick="logout()" class="btn btn-warning btn-large" ${this.activeBrowser ? '' : 'disabled style="opacity: 0.5;"'}>
                                    🚪 End Session
                                </button>
                            </div>
                            <div id="result" style="margin-top: 20px;"></div>
                            <div id="loginForm" class="hidden" style="margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 8px;">
                                <h4>🔐 ASICS B2B Authentication</h4>
                                <div class="form-group">
                                    <label>Username/Email:</label>
                                    <input type="text" id="asicsUsername" class="form-control" placeholder="your.email@company.com" />
                                </div>
                                <div class="form-group">
                                    <label>Password:</label>
                                    <input type="password" id="asicsPassword" class="form-control" placeholder="Your password" />
                                </div>
                                <button onclick="authenticate()" class="btn btn-success" style="width: 100%;">🔐 Authenticate</button>
                                <div style="font-size: 12px; color: #666; margin-top: 10px;">
                                    <strong>🔒 Secure:</strong> Credentials are only used once to authenticate, not stored.
                                </div>
                            </div>
                            <div id="progress" style="margin-top: 10px;"></div>
                        </div>
                        
                        <div class="card">
                            <h3>📋 URL Management</h3>
                            <div class="form-group">
                                <label for="newUrl">Add New URL:</label>
                                <div class="flex">
                                    <input type="url" id="newUrl" class="form-control" placeholder="https://b2b.asics.com/us/en-us/mens-running-shoes" />
                                    <button onclick="addUrl()" class="btn btn-success">➕ Add URL</button>
                                </div>
                            </div>
                            
                            <div class="examples">
                                <h4>📝 Example ASICS B2B URLs:</h4>
                                <p><strong>Category Pages:</strong></p>
                                <ul>
                                    <li>https://b2b.asics.com/us/en-us/mens-running-shoes</li>
                                    <li>https://b2b.asics.com/us/en-us/womens-running-shoes</li>
                                    <li>https://b2b.asics.com/us/en-us/kids-shoes</li>
                                </ul>
                                <p><strong>Product Pages:</strong></p>
                                <ul>
                                    <li>https://b2b.asics.com/us/en-us/product/[SKU]</li>
                                </ul>
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
                            <h3>📊 Recent Logs</h3>
                            <button onclick="viewLogs()" class="btn btn-primary">📋 Refresh Logs</button>
                            <div id="logs" class="logs" style="margin-top: 10px;">
                                Click "Refresh Logs" to see recent activity...
                            </div>
                        </div>
                    </div>
                    
                    <script>
                        function startLogin() {
                            const loginForm = document.getElementById('loginForm');
                            const result = document.getElementById('result');
                            
                            loginForm.classList.remove('hidden');
                            result.innerHTML = '<div style="color: blue; padding: 10px; background: #e7f3ff; border-radius: 4px;">Please enter your ASICS B2B credentials below.</div>';
                        }
                        
                        async function authenticate() {
                            const username = document.getElementById('asicsUsername').value.trim();
                            const password = document.getElementById('asicsPassword').value.trim();
                            const result = document.getElementById('result');
                            
                            if (!username || !password) {
                                alert('Please enter both username and password');
                                return;
                            }
                            
                            result.innerHTML = '<div style="color: blue; padding: 10px; background: #e7f3ff; border-radius: 4px;">🔐 Authenticating with ASICS B2B...</div>';
                            
                            try {
                                const response = await fetch('/authenticate', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ 
                                        username: username,
                                        password: password
                                    })
                                });
                                
                                const data = await response.json();
                                
                                if (data.success) {
                                    result.innerHTML = \`
                                        <div style="color: green; padding: 15px; background: #d4edda; border-radius: 4px;">
                                            ✅ Authentication successful! 
                                            <br><br>
                                            <strong>Logged into:</strong> \${data.details?.title || 'ASICS B2B'}
                                            <br><br>
                                            You can now start scraping!
                                        </div>
                                    \`;
                                    
                                    // Clear the password field and hide form
                                    document.getElementById('asicsPassword').value = '';
                                    document.getElementById('loginForm').classList.add('hidden');
                                    
                                    setTimeout(() => location.reload(), 2000);
                                } else {
                                    result.innerHTML = \`
                                        <div style="color: red; padding: 15px; background: #f8d7da; border-radius: 4px;">
                                            ❌ Authentication failed: \${data.error}
                                            <br><br>
                                            <strong>💡 Please check:</strong>
                                            <br>• Username/email is correct
                                            <br>• Password is correct
                                            <br>• Account is not locked
                                        </div>
                                    \`;
                                }
                            } catch (error) {
                                result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px;">❌ Error: ' + error.message + '</div>';
                            }
                        }
                        
                        async function startScraping() {
                            const result = document.getElementById('result');
                            const progress = document.getElementById('progress');
                            
                            result.innerHTML = '<div style="color: blue; padding: 10px; background: #e7f3ff; border-radius: 4px;">🚀 Starting automated scraping...</div>';
                            progress.innerHTML = '<div style="background: #f0f0f0; border-radius: 4px; padding: 5px;"><div id="progressBar" style="background: #007bff; height: 20px; width: 0%; border-radius: 4px; transition: width 0.3s;"></div></div>';
                            
                            try {
                                const response = await fetch('/start-scraping', {method: 'POST'});
                                const data = await response.json();
                                
                                if (data.success) {
                                    result.innerHTML = '<div style="color: green; padding: 10px; background: #d4edda; border-radius: 4px;">✅ Scraping started! Check progress below and logs for details.</div>';
                                    pollProgress();
                                } else {
                                    result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px;">❌ Failed to start scraping: ' + data.error + '</div>';
                                }
                            } catch (error) {
                                result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px;">❌ Error: ' + error.message + '</div>';
                            }
                        }
                        
                        async function logout() {
                            const response = await fetch('/logout', {method: 'POST'});
                            location.reload();
                        }
                        
                        async function pollProgress() {
                            try {
                                const response = await fetch('/scraping-progress');
                                const data = await response.json();
                                
                                if (data.active) {
                                    const progress = (data.completed / data.total) * 100;
                                    document.getElementById('progressBar').style.width = progress + '%';
                                    document.getElementById('progress').innerHTML = \`
                                        <div style="background: #f0f0f0; border-radius: 4px; padding: 5px;">
                                            <div style="background: #007bff; height: 20px; width: \${progress}%; border-radius: 4px; transition: width 0.3s;"></div>
                                            <div style="text-align: center; margin-top: 5px;">
                                                Scraped \${data.completed} of \${data.total} URLs (\${Math.round(progress)}%)
                                            </div>
                                        </div>
                                    \`;
                                    
                                    if (data.completed < data.total) {
                                        setTimeout(pollProgress, 2000);
                                    } else {
                                        document.getElementById('result').innerHTML = '<div style="color: green; padding: 10px; background: #d4edda; border-radius: 4px;">🎉 Scraping completed! Check logs for results.</div>';
                                    }
                                }
                            } catch (error) {
                                console.error('Error polling progress:', error);
                            }
                        }
                        
                        // URL Management Functions
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
                        
                        async function viewLogs() {
                            const logs = document.getElementById('logs');
                            logs.innerHTML = 'Loading...';
                            
                            try {
                                const response = await fetch('/logs');
                                const data = await response.json();
                                
                                if (Array.isArray(data) && data.length > 0) {
                                    logs.innerHTML = data.map(log => 
                                        \`<div style="margin: 5px 0; padding: 5px; border-left: 3px solid #007bff;"><strong>\${log.created_at || log.timestamp || 'Unknown time'}:</strong> \${log.url} - \${log.status} (\${log.product_count || 0} products)\${log.error_message ? ' - ' + log.error_message : ''}</div>\`
                                    ).join('');
                                } else {
                                    logs.innerHTML = '<div style="color: #666; font-style: italic;">No logs available yet. Try running a scraping session first.</div>';
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
                        
                        // Auto-refresh auth status every 30 seconds
                        setInterval(() => {
                            fetch('/auth-status').then(r => r.json()).then(data => {
                                const authCard = document.querySelector('.auth-status');
                                if (data.authenticated !== authCard.classList.contains('logged-in')) {
                                    location.reload();
                                }
                            }).catch(() => {});
                        }, 30000);
                    </script>
                </body>
                </html>
            `);
        });

        // Authentication endpoints
        this.app.post('/authenticate', async (req, res) => {
            try {
                const { username, password } = req.body;
                
                if (!username || !password) {
                    return res.json({
                        success: false,
                        error: 'Username and password required'
                    });
                }
                
                console.log('🔐 Starting authentication...');
                
                // Create a new browser session
                const browser = await puppeteer.connect({
                    browserWSEndpoint: this.browserlessEndpoint
                });
                
                const page = await browser.newPage();
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.setViewport({ width: 1366, height: 768 });
                
                // Navigate to ASICS B2B login
                console.log('🚀 Navigating to ASICS B2B login...');
                await page.goto('https://b2b.asics.com/authentication/login', { 
                    waitUntil: 'networkidle0',
                    timeout: 30000 
                });

                // Handle region selection if needed
                const pageContent = await page.evaluate(() => {
                    const bodyText = document.body ? document.body.innerText : '';
                    return {
                        hasCountrySelection: bodyText.includes('Please Select The Region') || bodyText.includes('United States'),
                        hasLoginForm: document.querySelector('input[type="password"]') !== null
                    };
                });

                if (pageContent.hasCountrySelection && !pageContent.hasLoginForm) {
                    console.log('🌍 Selecting United States...');
                    await page.click('text=United States');
                    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
                }

                // Fill in credentials
                console.log('📝 Filling credentials...');
                await page.waitForSelector('#username', { timeout: 10000 });
                await page.waitForSelector('#password', { timeout: 10000 });
                
                await page.type('#username', username);
                await page.type('#password', password);

                // Submit login
                console.log('🔐 Submitting login...');
                await page.click('button[type="submit"], button');
                
                // Wait and check result
                await page.waitForTimeout(5000);
                
                const loginResult = await page.evaluate(() => {
                    const url = window.location.href;
                    const title = document.title;
                    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                    
                    const success = !url.includes('login') && !url.includes('authentication');
                    
                    return {
                        url,
                        title,
                        success,
                        bodyPreview: bodyText.slice(0, 500)
                    };
                });

                if (loginResult.success) {
                    // Store the authenticated browser
                    this.activeBrowser = browser;
                    this.loginPage = page;
                    
                    console.log('✅ Authentication successful!');
                    res.json({
                        success: true,
                        message: 'Successfully authenticated! Ready to scrape.',
                        details: {
                            url: loginResult.url,
                            title: loginResult.title
                        }
                    });
                } else {
                    await browser.close();
                    console.log('❌ Authentication failed');
                    res.json({
                        success: false,
                        error: 'Authentication failed. Please check credentials.',
                        details: {
                            url: loginResult.url,
                            title: loginResult.title,
                            bodyPreview: loginResult.bodyPreview
                        }
                    });
                }
                
            } catch (error) {
                console.error('❌ Authentication error:', error.message);
                res.json({
                    success: false,
                    error: error.message
                });
            }
        });

        this.app.post('/logout', async (req, res) => {
            try {
                if (this.activeBrowser) {
                    await this.activeBrowser.close();
                    this.activeBrowser = null;
                    this.loginPage = null;
                }
                console.log('🚪 User logged out');
                res.json({ success: true });
            } catch (error) {
                res.json({ success: false, error: error.message });
            }
        });

        this.app.get('/auth-status', (req, res) => {
            res.json({ 
                authenticated: !!this.activeBrowser 
            });
        });

        // Scraping endpoints
        this.app.post('/start-scraping', async (req, res) => {
            try {
                if (!this.activeBrowser) {
                    return res.json({ 
                        success: false, 
                        error: 'Not logged in. Please authenticate first.' 
                    });
                }
                
                if (this.urlsToMonitor.length === 0) {
                    return res.json({
                        success: false,
                        error: 'No URLs configured. Add some URLs first!'
                    });
                }
                
                console.log('🚀 Starting scraping session...');
                
                // Start scraping in background
                this.scrapingProgress = {
                    active: true,
                    total: this.urlsToMonitor.length,
                    completed: 0,
                    results: []
                };
                
                setTimeout(() => this.startScraping(), 1000);
                
                res.json({ 
                    success: true, 
                    message: 'Scraping started', 
                    urlCount: this.urlsToMonitor.length 
                });
                
            } catch (error) {
                console.error('❌ Failed to start scraping:', error.message);
                res.json({ 
                    success: false, 
                    error: error.message 
                });
            }
        });

        this.app.get('/scraping-progress', (req, res) => {
            res.json(this.scrapingProgress || { active: false, total: 0, completed: 0 });
        });

        // URL Management (same as before)
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

    async startScraping() {
        const startTime = Date.now();
        const batchId = `manual_${Date.now()}`;
        
        console.log(`🚀 Starting scraping: ${this.urlsToMonitor.length} URLs`);
        
        try {
            if (!this.activeBrowser || !this.loginPage) {
                throw new Error('No active browser session');
            }
            
            const results = [];
            
            for (let i = 0; i < this.urlsToMonitor.length; i++) {
                const url = this.urlsToMonitor[i];
                
                try {
                    console.log(`🔍 Scraping (${i + 1}/${this.urlsToMonitor.length}): ${url}`);
                    
                    const result = await this.scrapeUrl(this.loginPage, url);
                    result.batchId = batchId;
                    results.push(result);
                    
                    // Update progress
                    this.scrapingProgress.completed = i + 1;
                    this.scrapingProgress.results = results;
                    
                    // Small delay between URLs
                    if (i < this.urlsToMonitor.length - 1) {
                        await this.delay(this.config.delayBetweenRequests);
                    }
                    
                } catch (urlError) {
                    console.error(`❌ Failed to scrape ${url}:`, urlError.message);
                    results.push({
                        url,
                        status: 'error',
                        error: urlError.message,
                        batchId,
                        products: [],
                        productCount: 0
                    });
                    
                    this.scrapingProgress.completed = i + 1;
                }
            }
            
            await this.processResults(results, batchId);
            
            this.scrapingProgress.active = false;
            
            const duration = Math.round((Date.now() - startTime) / 1000);
            console.log(`✅ Scraping completed in ${duration} seconds`);
            
        } catch (error) {
            console.error(`❌ Scraping failed:`, error.message);
            this.scrapingProgress.active = false;
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
                    '.product-details',
                    '[class*="product"]'
                ].join(', '));
                
                const products = [];
                
                productElements.forEach((element, index) => {
                    try {
                        const name = element.querySelector([
                            '.product-name',
                            '.product-title', 
                            '.name',
                            'h1', 'h2', 'h3', 'h4',
                            '.title',
                            '[class*="name"]',
                            '[class*="title"]'
                        ].join(', '))?.textContent?.trim();
                        
                        const price = element.querySelector([
                            '.price',
                            '.product-price',
                            '[class*="price"]',
                            '.msrp',
                            '.cost'
                        ].join(', '))?.textContent?.trim();
                        
                        const sku = element.querySelector([
                            '.sku',
                            '.product-id',
                            '[data-sku]',
                            '.style-number',
                            '[class*="sku"]'
                        ].join(', '))?.textContent?.trim() || 
                        element.getAttribute('data-sku') ||
                        element.getAttribute('data-product-id');
                        
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

    // Database and utility methods (same as before)
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
            await this.pool.query('SELECT NOW() as current_time');
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

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        try {
            console.log('🚀 Initializing ASICS Simple Authentication Scraper...');
            console.log('🎯 Simple Authentication + Auto Scrape mode activated!');
            
            const memUsage = process.memoryUsage();
            const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;
            console.log('💾 Memory available:', {
                heapUsed: formatMB(memUsage.heapUsed),
                rss: formatMB(memUsage.rss)
            });

            this.app.listen(this.port, () => {
                console.log(`🚀 ASICS Simple Authentication Scraper running on port ${this.port}`);
                console.log('📊 Dashboard available at /dashboard');
            });
            
            console.log(`✅ Simple authentication scraper initialized with ${this.urlsToMonitor.length} URLs`);
            console.log('🎯 Ready for simple authentication + automated scraping!');

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

const scraper = new ASICSManualLoginScraper();
scraper.start().catch(error => {
    console.error('❌ Startup failed:', error);
    process.exit(1);
});
