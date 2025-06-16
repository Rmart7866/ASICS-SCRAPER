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
        // Set some real ASICS B2B URLs as examples
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

        // Dashboard
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
                        .url-text { flex: 1; font-family: monospace; word-break: break-all; }
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
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🚀 ASICS Weekly Batch Scraper</h1>
                        
                        <div class="card status">
                            <h2>Status: Active ✅</h2>
                            <p>Uptime: ${Math.floor(process.uptime() / 60)} minutes</p>
                            <p>Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB</p>
                            <p>Database: ${this.databaseEnabled ? '✅ Connected' : '⚠️ Memory-only mode'}</p>
                            <p>ASICS Credentials: ${this.credentials.username ? '✅ Configured' : '⚠️ Missing'}</p>
                        </div>
                        
                        ${this.databaseEnabled ? `
                        <div class="card success">
                            <h3>✅ Ready to Scrape!</h3>
                            <p>All systems configured. Database logging enabled.</p>
                        </div>
                        ` : `
                        <div class="card warning">
                            <h3>⚠️ Running in Memory Mode</h3>
                            <p>Database not available but scraping still works. Results stored in memory.</p>
                        </div>
                        `}
                        
                        <div class="card">
                            <h3>📋 URL Management</h3>
                            <div class="form-group">
                                <label for="newUrl">Add New URL:</label>
                                <div class="flex">
                                    <input type="url" id="newUrl" class="form-control" placeholder="https://b2b.asics.com/us/en-us/..." />
                                    <button onclick="addUrl()" class="btn btn-success">➕ Add URL</button>
                                </div>
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
                                <p><strong>Example URLs:</strong></p>
                                <ul>
                                    <li>https://b2b.asics.com/us/en-us/mens-running-shoes</li>
                                    <li>https://b2b.asics.com/us/en-us/womens-running-shoes</li>
                                    <li>https://b2b.asics.com/us/en-us/mens-tennis-shoes</li>
                                </ul>
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
                                    location.reload(); // Refresh page to show new URL
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
                                    location.reload(); // Refresh page
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
                                    location.reload(); // Refresh page
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
                        
                        // Allow adding URLs with Enter key
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
                    // Try database first
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
                    // Return in-memory logs
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
            // Clear existing URLs and save new ones
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
            // Try to load from monitored_urls table first
            const result = await this.pool.query(`
                SELECT url FROM monitored_urls 
                ORDER BY created_at DESC
            `);
            
            if (result.rows.length > 0) {
                this.urlsToMonitor = result.rows.map(row => row.url);
                console.log(`📋 Loaded ${this.urlsToMonitor.length} URLs from database`);
            } else {
                // Fallback to scrape_logs if monitored_urls is empty
                const logResult = await this.pool.query(`
                    SELECT DISTINCT url FROM scrape_logs 
                    WHERE created_at > NOW() - INTERVAL '30 days'
                    LIMIT 100
                `);
                
                if (logResult.rows.length > 0) {
                    this.urlsToMonitor = logResult.rows.map(row => row.url);
                    console.log(`📋 Loaded ${this.urlsToMonitor.length} URLs from scrape logs`);
                } else {
                    this.setDefaultUrls();
                }
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
            
            // Test connection
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
            
            // Try to create basic scrape_logs table
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
                console.log('✅ Basic scrape_logs table ready');
            } catch (tableError) {
                console.log('⚠️ Could not create scrape_logs table:', tableError.message);
            }

            // Try to create products table
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
                console.log('✅ Basic products table ready');
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
        // Weekly scheduler - every Sunday at 2:00 AM
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
            // Split URLs into mini-batches
            const batches = [];
            for (let i = 0; i < this.urlsToMonitor.length; i += this.config.batchSize) {
                batches.push(this.urlsToMonitor.slice(i, i + this.config.batchSize));
            }
            
            const allResults = [];
            
            // Process each mini-batch
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                console.log(`📦 Mini-batch ${i + 1}/${batches.length}: ${batch.length} URLs`);
                
                try {
                    const batchResults = await this.processBatch(batch, batchId);
                    allResults.push(...batchResults);
                    
                    // Delay between batches (except for the last one)
                    if (i < batches.length - 1) {
                        console.log(`⏳ Waiting ${this.config.delayBetweenRequests / 1000}s before next batch...`);
                        await this.delay(this.config.delayBetweenRequests);
                    }
                    
                } catch (batchError) {
                    console.error(`❌ Mini-batch ${i + 1} failed:`, batchError.message);
                    // Continue with next batch even if one fails
                }
            }
            
            // Process all results
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
            // Get authenticated browser
            const authResult = await this.getAuthenticatedBrowser();
            browser = authResult.browser;
            page = authResult.page;
            
            // Process each URL in the batch
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
                
                // Small delay between URLs
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

    async getAuthenticatedBrowser() {
        console.log('🔧 Starting authentication...');
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
            
            console.log('🔐 Navigating to ASICS B2B login...');
            await page.goto('https://b2b.asics.com/authentication/login', { 
                waitUntil: 'networkidle0',
                timeout: 30000 
            });

            const currentUrl = page.url();
            const title = await page.title();
            console.log(`📋 Current URL: ${currentUrl}`);
            console.log(`📋 Page title: ${title}`);

            // Simple authentication attempt
            console.log('🔑 Attempting to authenticate...');
            
            // For now, just return the browser without actual login to test the flow
            console.log('⚠️ Skipping actual login for testing - will implement full auth after basic flow works');
            
            return { browser, page };

        } catch (error) {
            console.error('❌ Authentication failed:', error.message);
            await browser.close();
            throw error;
        }
    }

    async scrapeUrl(page, url) {
        const startTime = Date.now();
        
        try {
            console.log(`🔍 Navigating to: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle0', timeout: this.config.timeout });
            
            // Wait for content to load
            await page.waitForTimeout(3000);
            
            // Simple test scraping - just get page title for now
            const pageTitle = await page.title();
            const products = [
                {
                    name: `Test Product from ${pageTitle}`,
                    price: '$99.99',
                    sku: `test-${Date.now()}`,
                    imageUrl: '',
                    link: url,
                    description: 'Test product'
                }
            ];
            
            const duration = Date.now() - startTime;
            console.log(`✅ Test scraped ${products.length} products from ${url} in ${duration}ms`);
            
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

        // Always store in memory
        this.inMemoryLogs.push(...results.map(r => ({
            ...r,
            batch_id: batchId,
            created_at: new Date().toISOString()
        })));

        // Keep only last 1000 logs in memory
        if (this.inMemoryLogs.length > 1000) {
            this.inMemoryLogs = this.inMemoryLogs.slice(-1000);
        }

        console.log(`📊 Logged ${results.length} results to memory`);

        // Try to log to database if available
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
            // Log results
            await this.logScrapeResults(results, batchId);
            
            // Process successful results
            const successfulResults = results.filter(r => r.status === 'success' && r.products?.length > 0);
            const failedResults = results.filter(r => r.status === 'error' || !r.products || r.products.length === 0);
            
            console.log(`✅ Successful scrapes: ${successfulResults.length}`);
            console.log(`❌ Failed scrapes: ${failedResults.length}`);
            
            // Log summary of products found
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
            
            // Log memory info
            const memUsage = process.memoryUsage();
            const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;
            console.log('💾 Memory available:', {
                heapUsed: formatMB(memUsage.heapUsed),
                heapTotal: formatMB(memUsage.heapTotal),
                rss: formatMB(memUsage.rss)
            });

            // Start the server
            this.app.listen(this.port, () => {
                console.log(`🚀 ASICS Weekly Batch Scraper running on port ${this.port}`);
                console.log('📊 Dashboard available at /dashboard');
            });

            // Setup scheduler
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

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

// Start the scraper
const scraper = new ASICSWeeklyBatchScraper();
scraper.start().catch(error => {
    console.error('❌ Startup failed:', error);
    process.exit(1);
});
