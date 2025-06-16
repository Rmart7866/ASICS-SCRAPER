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

        if (!this.credentials.username || !this.credentials.password) {
            console.warn('⚠️ ASICS credentials not set - authentication will fail');
        } else {
            console.log('✅ ASICS credentials configured');
        }

        // Scraping configuration
        this.config = {
            batchSize: 5,
            delayBetweenRequests: 30000, // 30 seconds
            maxRetries: 3,
            timeout: 60000
        };

        // URLs to monitor - start with empty, will be loaded from database or defaults
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
        // Set some real ASICS B2B URLs as examples - individual product URLs like you mentioned
        this.urlsToMonitor = [
            'https://b2b.asics.com/us/en-us/mens-running-shoes',
            'https://b2b.asics.com/us/en-us/womens-running-shoes'
        ];
        console.log('📋 Using default URLs');
    }

    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static('public'));
        
        // Simplified memory monitoring
        this.app.use((req, res, next) => {
            if (Math.random() < 0.1) { // Only log 10% of requests to reduce spam
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
                status: 'ASICS Weekly Batch Scraper Active',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                config: this.config,
                urlCount: this.urlsToMonitor.length,
                databaseEnabled: this.databaseEnabled,
                environment: {
                    DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT SET',
                    ASICS_USERNAME: process.env.ASICS_USERNAME ? 'SET' : 'NOT SET',
                    ASICS_PASSWORD: process.env.ASICS_PASSWORD ? 'SET' : 'NOT SET'
                }
            });
        });

        // Dashboard with URL management
        this.app.get('/dashboard', (req, res) => {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>ASICS Scraper Dashboard</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
                        .container { max-width: 1200px; margin: 0 auto; }
                        .card { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                        .status { background: #f0f8ff; }
                        .success { background: #d4edda; border: 1px solid #c3e6cb; }
                        .warning { background: #fff3cd; border: 1px solid #ffeaa7; }
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
                        <h1>🚀 ASICS B2B Scraper Dashboard</h1>
                        
                        <div class="card status">
                            <h2>Status: Active ✅</h2>
                            <p>Uptime: ${Math.floor(process.uptime() / 60)} minutes</p>
                            <p>Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB</p>
                            <p>Database: ${this.databaseEnabled ? '✅ Connected' : '⚠️ Memory-only mode'}</p>
                            <p>ASICS Credentials: ${this.credentials.username ? '✅ Configured' : '⚠️ Missing'}</p>
                        </div>
                        
                        ${this.databaseEnabled && this.credentials.username ? `
                        <div class="card success">
                            <h3>✅ Ready to Scrape ASICS B2B!</h3>
                            <p>Database connected and ASICS credentials configured. Ready to scrape individual products.</p>
                        </div>
                        ` : `
                        <div class="card warning">
                            <h3>⚠️ Configuration Needed</h3>
                            <p>Make sure ASICS_USERNAME and ASICS_PASSWORD environment variables are set.</p>
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
                                <p><strong>Category Pages:</strong></p>
                                <ul>
                                    <li>https://b2b.asics.com/us/en-us/mens-running-shoes</li>
                                    <li>https://b2b.asics.com/us/en-us/womens-running-shoes</li>
                                    <li>https://b2b.asics.com/us/en-us/mens-tennis-shoes</li>
                                </ul>
                                <p><strong>Individual Product Pages:</strong></p>
                                <ul>
                                    <li>https://b2b.asics.com/orders/[ORDER-ID]/products/[SKU]?colorCode=[COLOR]</li>
                                    <li>https://b2b.asics.com/us/en-us/product/[SKU]</li>
                                </ul>
                                <p><strong>Note:</strong> Individual product URLs require being logged into ASICS B2B with proper access.</p>
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
                                <p><strong>No URLs configured!</strong> Add some ASICS B2B URLs above to start monitoring.</p>
                            </div>
                            ` : ''}
                        </div>
                        
                        <div class="card">
                            <h3>⚙️ Configuration</h3>
                            <p>Batch Size: ${this.config.batchSize} URLs</p>
                            <p>Delay: ${this.config.delayBetweenRequests / 1000}s</p>
                            <p>Max Retries: ${this.config.maxRetries}</p>
                        </div>
                        
                        <div class="card">
                            <h3>🎯 Quick Actions</h3>
                            <button onclick="triggerBatch()" class="btn btn-primary">
                                🎯 Trigger Manual Batch
                            </button>
                            <button onclick="viewLogs()" class="btn btn-success">
                                📋 View Recent Logs
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
                                    result.innerHTML = '<div style="color: green; padding: 10px; background: #d4edda; border-radius: 4px; margin: 10px 0;">✅ Batch started successfully! Check logs for progress.</div>';
                                } else {
                                    result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px; margin: 10px 0;">❌ ' + data.error + '</div>';
                                }
                            } catch (error) {
                                result.innerHTML = '<div style="color: red; padding: 10px; background: #f8d7da; border-radius: 4px; margin: 10px 0;">❌ ' + error.message + '</div>';
                            }
                            
                            button.disabled = false;
                            button.textContent = '🎯 Trigger Manual Batch';
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

        // Manual trigger
        this.app.post('/trigger', async (req, res) => {
            try {
                if (this.urlsToMonitor.length === 0) {
                    return res.status(400).json({
                        success: false,
                        error: 'No URLs configured. Add some URLs first!'
                    });
                }
                
                console.log('🎯 Manual batch trigger received');
                const batchId = `manual_${Date.now()}`;
                
                // Run batch in background
                setTimeout(() => this.startWeeklyBatch(batchId), 1000);
                
                res.json({ 
                    success: true, 
                    message: 'Batch started in background', 
                    batchId,
                    urlCount: this.urlsToMonitor.length,
                    databaseEnabled: this.databaseEnabled
                });
            } catch (error) {
                console.error('❌ Manual trigger failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Get recent logs
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
            console.log('🔗 Testing database connection...');
            
            const testResult = await this.pool.query('SELECT NOW() as current_time');
            console.log('✅ Database connection successful!');
            console.log('   Time:', testResult.rows[0].current_time);
            
            // Create monitored_urls table
            try {
                await this.pool.query(`
                    CREATE TABLE IF NOT EXISTS monitored_urls (
                        id SERIAL PRIMARY KEY,
                        url VARCHAR(1000) NOT NULL UNIQUE,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                console.log('✅ Monitored URLs table ready');
            } catch (tableError) {
                console.log('⚠️ Could not create monitored_urls table:', tableError.message);
            }
            
            // Create scrape_logs table
            try {
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
                console.log('✅ Scrape logs table ready');
            } catch (tableError) {
                console.log('⚠️ Could not create scrape_logs table:', tableError.message);
            }

            // Create products table
            try {
                await this.pool.query(`
                    CREATE TABLE IF NOT EXISTS products (
                        id SERIAL PRIMARY KEY,
                        batch_id VARCHAR(255),
                        url VARCHAR(1000),
                        sku VARCHAR(255),
                        name VARCHAR(500),
                        price VARCHAR(100),
                        description TEXT,
                        image_url VARCHAR(1000),
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                console.log('✅ Products table ready');
            } catch (tableError) {
                console.log('⚠️ Could not create products table:', tableError.message);
            }

            console.log('✅ Database initialization completed');
            
        } catch (error) {
            console.error('⚠️ Database initialization failed:', error.message);
            this.databaseEnabled = false;
            throw error;
        }
    }

    setupScheduler() {
        cron.schedule('0 2 * * 0', async () => {
            console.log('📅 Weekly scheduled batch starting...');
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

    // WORKING authentication function from your old code
    async getAuthenticatedBrowser() {
        console.log('🔧 Using FIXED authentication method...');
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-extensions',
                '--disable-plugins'
            ]
        });

        try {
            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            console.log('🚀 [FIXED] Launching browser with ASICS B2B authentication...');
            console.log('🔐 [FIXED] Navigating to ASICS B2B authentication...');
            
            await page.goto('https://b2b.asics.com/authentication/login', { 
                waitUntil: 'networkidle0',
                timeout: 30000 
            });

            const currentUrl = page.url();
            const title = await page.title();
            console.log(`📋 [FIXED] Current URL: ${currentUrl}`);
            console.log(`📋 [FIXED] Page title: ${title}`);

            const pageState = await page.evaluate(() => {
                const bodyText = document.body ? document.body.innerText.slice(0, 500) : '';
                const hasCountrySelection = bodyText.includes('Please Select The Region') || 
                                          bodyText.includes('Americas') || 
                                          bodyText.includes('United States');
                const hasLoginForm = document.querySelector('input[type="password"]') !== null ||
                                   document.querySelector('input[name*="password"]') !== null;
                
                return {
                    title: document.title,
                    url: window.location.href,
                    bodyText,
                    hasCountrySelection,
                    hasLoginForm
                };
            });

            console.log('📊 [FIXED] Page content check:', pageState);

            if (pageState.hasCountrySelection && !pageState.hasLoginForm) {
                console.log('🌍 [FIXED] Country selection detected, clicking United States...');
                
                const countrySelectors = [
                    'a[href*="united-states"]',
                    'button:contains("United States")',
                    'div:contains("United States")',
                    'span:contains("United States")',
                    '.country-item:contains("United States")'
                ];

                let countrySelected = false;
                for (const selector of countrySelectors) {
                    try {
                        await page.waitForSelector(selector, { timeout: 5000 });
                        await page.click(selector);
                        countrySelected = true;
                        break;
                    } catch (e) {
                        continue;
                    }
                }

                if (!countrySelected) {
                    await page.evaluate(() => {
                        const elements = Array.from(document.querySelectorAll('*'));
                        const usElement = elements.find(el => 
                            el.textContent && el.textContent.includes('United States')
                        );
                        if (usElement) {
                            usElement.click();
                        }
                    });
                }

                console.log('⏳ [FIXED] Waiting for login form after country selection...');
                await page.waitForTimeout(3000);
                
                try {
                    await page.waitForSelector('input[type="password"], input[name*="password"]', { timeout: 10000 });
                    console.log('✅ [FIXED] Login form appeared');
                } catch (e) {
                    throw new Error('Login form did not appear after country selection');
                }
            }

            const loginFormCheck = await page.evaluate(() => {
                const usernameSelectors = [
                    'input[type="email"]',
                    'input[name*="email" i]',
                    'input[name*="username" i]',
                    'input[name*="user" i]',
                    'input[id*="email" i]',
                    'input[id*="username" i]',
                    'input[id*="user" i]',
                    'input[placeholder*="email" i]',
                    'input[placeholder*="username" i]',
                    'input[placeholder*="user" i]'
                ];
                
                const passwordSelectors = [
                    'input[type="password"]',
                    'input[name*="password" i]',
                    'input[id*="password" i]'
                ];

                let usernameField = null;
                let passwordField = null;

                for (const selector of usernameSelectors) {
                    usernameField = document.querySelector(selector);
                    if (usernameField) break;
                }

                for (const selector of passwordSelectors) {
                    passwordField = document.querySelector(selector);
                    if (passwordField) break;
                }

                if (!usernameField && passwordField) {
                    const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
                    const passwordIndex = Array.from(document.querySelectorAll('input')).indexOf(passwordField);
                    usernameField = allInputs.find(input => {
                        const inputIndex = Array.from(document.querySelectorAll('input')).indexOf(input);
                        return inputIndex < passwordIndex;
                    });
                }

                function getSelector(element) {
                    if (element.id) return `#${element.id}`;
                    if (element.name) return `input[name="${element.name}"]`;
                    if (element.className) return `input.${element.className.split(' ')[0]}`;
                    return element.tagName.toLowerCase();
                }

                return {
                    hasEmailField: !!usernameField,
                    hasPasswordField: !!passwordField,
                    hasBoth: !!(usernameField && passwordField),
                    usernameSelector: usernameField ? getSelector(usernameField) : null,
                    passwordSelector: passwordField ? getSelector(passwordField) : null
                };
            });

            console.log('📝 [FIXED] Login form check:', loginFormCheck);

            const debugState = await page.evaluate(() => ({
                url: window.location.href,
                title: document.title,
                bodyText: document.body ? document.body.innerText.slice(0, 500) : ''
            }));
            console.log('🔍 [FIXED] Current page state:', debugState);

            if (!loginFormCheck.hasBoth) {
                try {
                    await page.screenshot({
                        path: '/tmp/login_debug.png',
                        fullPage: true
                    });
                    console.log('📸 [FIXED] Screenshot taken');
                } catch (screenshotError) {
                    console.log('⚠️ Could not take screenshot:', screenshotError.message);
                }
                
                const debugInfo = {
                    url: debugState.url,
                    title: debugState.title,
                    bodySnippet: debugState.bodyText.slice(0, 200),
                    loginFormCheck
                };
                console.log('🔍 [FIXED] Debug info:', debugInfo);
                
                throw new Error(`Login form incomplete. Email: ${loginFormCheck.hasEmailField}, Password: ${loginFormCheck.hasPasswordField}`);
            }

            try {
                const cookieAcceptButton = await page.$('button:contains("Accept"), button[id*="accept"], button[class*="accept"]');
                if (cookieAcceptButton) {
                    await cookieAcceptButton.click();
                    console.log('🍪 [FIXED] Cookie consent accepted');
                    await page.waitForTimeout(1000);
                }
            } catch (e) {
                // Cookie consent not found
            }

            console.log('📝 [FIXED] Filling in credentials...');
            
            if (loginFormCheck.usernameSelector) {
                await page.type(loginFormCheck.usernameSelector, this.credentials.username);
            }
            
            if (loginFormCheck.passwordSelector) {
                await page.type(loginFormCheck.passwordSelector, this.credentials.password);
            }

            console.log('🔐 [FIXED] Submitting login form...');
            
            const submitSelectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:contains("Log In")',
                'button:contains("Login")',
                'button:contains("Sign In")',
                '.login-button',
                '#login-button'
            ];

            let submitted = false;
            for (const selector of submitSelectors) {
                try {
                    await page.click(selector);
                    submitted = true;
                    break;
                } catch (e) {
                    continue;
                }
            }

            if (!submitted) {
                await page.focus(loginFormCheck.passwordSelector);
                await page.keyboard.press('Enter');
            }

            console.log('⏳ [FIXED] Waiting for authentication...');
            await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 });

            const finalUrl = page.url();
            console.log(`✅ [FIXED] Authentication complete. Final URL: ${finalUrl}`);

            if (finalUrl.includes('login') || finalUrl.includes('authentication')) {
                throw new Error('Authentication failed - still on login page');
            }

            return { browser, page };

        } catch (error) {
            console.error('❌ [FIXED] Authentication failed:', error.message);
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
            
            // Enhanced product scraping for ASICS B2B
            const products = await page.evaluate(() => {
                const productElements = document.querySelectorAll([
                    '.product-item',
                    '.product-card', 
                    '.product-tile',
                    '.product',
                    '[data-product-id]',
                    '.grid-item',
                    '.product-details',
                    '.item-detail'
                ].join(', '));
                
                const products = [];
                
                productElements.forEach((element, index) => {
                    try {
                        const name = element.querySelector([
                            '.product-name',
                            '.product-title', 
                            '.name',
                            'h1',
                            'h2',
                            'h3',
                            '.title',
                            '[data-product-name]'
                        ].join(', '))?.textContent?.trim();
                        
                        const price = element.querySelector([
                            '.price',
                            '.product-price',
                            '.cost',
                            '[class*="price"]',
                            '.msrp',
                            '.wholesale'
                        ].join(', '))?.textContent?.trim();
                        
                        const sku = element.querySelector([
                            '.sku',
                            '.product-id',
                            '[data-sku]',
                            '[data-product-id]',
                            '.style-number',
                            '.model-number'
                        ].join(', '))?.textContent?.trim() || 
                        element.getAttribute('data-sku') || 
                        element.getAttribute('data-product-id');
                        
                        const imageUrl = element.querySelector('img')?.src;
                        const link = element.querySelector('a')?.href;
                        
                        // Try to get additional ASICS-specific details
                        const color = element.querySelector([
                            '.color',
                            '.color-name',
                            '[data-color]'
                        ].join(', '))?.textContent?.trim();
                        
                        const size = element.querySelector([
                            '.size',
                            '.size-option',
                            '[data-size]'
                        ].join(', '))?.textContent?.trim();
                        
                        const availability = element.querySelector([
                            '.availability',
                            '.stock',
                            '.in-stock',
                            '.qty'
                        ].join(', '))?.textContent?.trim();
                        
                        if (name || sku || price) {
                            products.push({
                                name: name || '',
                                price: price || '',
                                sku: sku || `auto-${index}`,
                                imageUrl: imageUrl || '',
                                link: link || '',
                                color: color || '',
                                size: size || '',
                                availability: availability || '',
                                description: ''
                            });
                        }
                    } catch (productError) {
                        console.log('Error processing product:', productError);
                    }
                });
                
                // If no products found with standard selectors, try to get page-level product info
                if (products.length === 0) {
                    const pageTitle = document.title;
                    const bodyText = document.body ? document.body.innerText : '';
                    
                    // Check if this looks like a product page
                    if (pageTitle && (bodyText.includes('SKU') || bodyText.includes('Price') || url.includes('product'))) {
                        products.push({
                            name: pageTitle,
                            price: 'See page for pricing',
                            sku: 'extracted-from-page',
                            imageUrl: '',
                            link: url,
                            color: '',
                            size: '',
                            availability: '',
                            description: 'Product page detected but specific details not extracted'
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
                console.error('⚠️ Database logging failed, but memory logging succeeded:', error.message);
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
            console.log('🚀 Initializing ASICS Weekly Batch Scraper...');
            
            const memUsage = process.memoryUsage();
            const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;
            console.log('💾 Memory available:', {
                heapUsed: formatMB(memUsage.heapUsed),
                heapTotal: formatMB(memUsage.heapTotal),
                rss: formatMB(memUsage.rss)
            });

            this.app.listen(this.port, () => {
                console.log(`🚀 ASICS Weekly Batch Scraper running on port ${this.port}`);
                console.log('📊 Dashboard available at /dashboard');
            });

            this.setupScheduler();
            
            console.log(`✅ Weekly batch scraper initialized with ${this.urlsToMonitor.length} URLs`);
            console.log(`⚙️ Config: ${this.config.batchSize} URLs per batch, ${this.config.delayBetweenRequests / 1000}s delay`);
            console.log(`🗄️ Database mode: ${this.databaseEnabled ? 'Enabled' : 'Memory-only'}`);

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
