// server.js - ASICS Weekly Batch Scraper - Clean Version
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Pool } = require('pg');

class ASICSWeeklyBatchScraper {
    constructor() {
        this.app = express();
        this.setupDatabase();
        this.pageList = [];
        this.isRunning = false;
        this.lastScrapeTime = null;
        this.currentBatch = 0;
        this.totalBatches = 0;
        this.scrapingProgress = {
            total: 0,
            completed: 0,
            errors: 0,
            currentUrl: null,
            startTime: null
        };
        
        this.config = {
            batchSize: parseInt(process.env.WEEKLY_BATCH_SIZE) || 5,
            batchDelay: (parseInt(process.env.BATCH_DELAY_SECONDS) || 30) * 1000,
            pageDelay: (parseInt(process.env.PAGE_DELAY_SECONDS) || 10) * 1000,
            maxRetries: 2
        };
        
        this.setupMiddleware();
        this.setupRoutes();
        this.init();
    }

    setupDatabase() {
        this.db = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 3,
            connectionTimeoutMillis: 30000,
            idleTimeoutMillis: 30000
        });
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.text({ limit: '10mb' }));
    }

    setupRoutes() {
        // Main dashboard
        this.app.get('/', (req, res) => {
            res.send(this.getDashboardHTML());
        });

        // Status APIs
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: '📅 ASICS Weekly Batch Scraper',
                totalUrls: this.pageList.length,
                isRunning: this.isRunning,
                lastScrape: this.lastScrapeTime,
                nextScrape: this.getNextScrapeTime(),
                uptime: Math.floor(process.uptime()),
                version: '1.0.0 - Weekly Batch',
                config: this.config,
                memoryUsage: this.getMemoryUsage()
            });
        });

        this.app.get('/api/progress', (req, res) => {
            res.json({
                isRunning: this.isRunning,
                progress: this.scrapingProgress,
                currentBatch: this.currentBatch,
                totalBatches: this.totalBatches,
                lastScrape: this.lastScrapeTime,
                nextScrape: this.getNextScrapeTime()
            });
        });

        this.app.get('/api/batch-status', (req, res) => {
            const percentage = this.scrapingProgress.total > 0 ? 
                Math.round((this.scrapingProgress.completed / this.scrapingProgress.total) * 100) : 0;
                
            res.json({
                status: this.isRunning ? 'Running Weekly Batch' : 'Waiting for Next Week',
                percentage: percentage,
                completed: this.scrapingProgress.completed,
                total: this.scrapingProgress.total,
                errors: this.scrapingProgress.errors,
                currentUrl: this.scrapingProgress.currentUrl,
                estimatedMinutesRemaining: this.calculateTimeRemaining(),
                currentBatch: this.currentBatch,
                totalBatches: this.totalBatches
            });
        });

        // Batch control
        this.app.post('/api/start-batch', async (req, res) => {
            if (this.isRunning) {
                return res.json({ 
                    success: false, 
                    message: 'Weekly batch already running' 
                });
            }
            
            if (this.pageList.length === 0) {
                return res.json({ 
                    success: false, 
                    message: 'No URLs to scrape. Please add some URLs first.' 
                });
            }
            
            this.startWeeklyBatch();
            res.json({ 
                success: true, 
                message: `Weekly batch started for ${this.pageList.length} URLs`,
                estimatedDuration: Math.ceil(this.pageList.length / this.config.batchSize) * 2 + ' minutes'
            });
        });

        this.app.post('/api/stop-batch', (req, res) => {
            if (!this.isRunning) {
                return res.json({ 
                    success: false, 
                    message: 'No batch currently running' 
                });
            }
            
            this.isRunning = false;
            res.json({ 
                success: true, 
                message: 'Batch stop requested - will complete current mini-batch' 
            });
        });

        // URL management
        this.app.get('/api/pages', (req, res) => {
            res.json({ 
                pages: this.pageList,
                total: this.pageList.length
            });
        });

        this.app.post('/api/pages', async (req, res) => {
            const { url } = req.body;
            
            // Updated validation for ASICS B2B order URLs
            if (!url || (!url.includes('b2b.asics.com/products/') && !url.includes('b2b.asics.com/orders/'))) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please provide a valid ASICS B2B URL (products or orders page)' 
                });
            }
            
            if (this.pageList.includes(url)) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'This URL is already being monitored' 
                });
            }
            
            this.pageList.push(url);
            await this.savePageList();
            
            res.json({ 
                success: true, 
                message: 'URL added successfully', 
                total: this.pageList.length 
            });
        });

        // Bulk URL management
        this.app.post('/api/bulk-add', async (req, res) => {
            const { urls } = req.body;
            
            if (!Array.isArray(urls)) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please provide an array of URLs' 
                });
            }
            
            const validUrls = urls.filter(url => 
                url && typeof url === 'string' && 
                (url.includes('b2b.asics.com/products/') || url.includes('b2b.asics.com/orders/'))
            );
            
            const newUrls = validUrls.filter(url => !this.pageList.includes(url));
            
            this.pageList.push(...newUrls);
            await this.savePageList();
            
            res.json({
                success: true,
                message: `Added ${newUrls.length} new URLs`,
                total: this.pageList.length,
                added: newUrls.length,
                duplicates: validUrls.length - newUrls.length,
                invalid: urls.length - validUrls.length
            });
        });

        this.app.post('/api/clear-all-pages', async (req, res) => {
            try {
                this.pageList = [];
                await this.savePageList();
                res.json({ 
                    success: true, 
                    message: 'All URLs cleared' 
                });
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: 'Error clearing URLs: ' + error.message 
                });
            }
        });

        // Data export and viewing
        this.app.get('/api/inventory', async (req, res) => {
            try {
                const result = await this.db.query(`
                    SELECT style_id, product_name, 
                           COUNT(*) as variant_count,
                           SUM(quantity) as total_quantity,
                           MAX(scraped_at) as last_updated
                    FROM current_inventory 
                    GROUP BY style_id, product_name
                    ORDER BY last_updated DESC
                    LIMIT 100
                `);
                res.json({ inventory: result.rows });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/export/csv', async (req, res) => {
            try {
                const result = await this.db.query(`
                    SELECT product_name, style_id, color_code, color_name, 
                           size_us, quantity, raw_quantity, scraped_at, source_url
                    FROM current_inventory 
                    ORDER BY style_id, color_code, size_us
                `);
                
                const csvHeaders = 'Product Name,Style ID,Color Code,Color Name,Size US,Quantity,Raw Quantity,Scraped At,Source URL\n';
                const csvData = result.rows.map(row => 
                    `"${row.product_name}","${row.style_id}","${row.color_code}","${row.color_name}","${row.size_us}",${row.quantity},"${row.raw_quantity}","${row.scraped_at}","${row.source_url}"`
                ).join('\n');
                
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', 'attachment; filename=asics-weekly-inventory.csv');
                res.send(csvHeaders + csvData);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/logs', async (req, res) => {
            try {
                const result = await this.db.query(
                    'SELECT * FROM scrape_logs ORDER BY created_at DESC LIMIT 50'
                );
                res.json({ logs: result.rows });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/memory', (req, res) => {
            res.json(this.getMemoryUsage());
        });

        // Test endpoint
        this.app.post('/api/test-scrape', async (req, res) => {
            const { url } = req.body;
            
            if (!url || (!url.includes('b2b.asics.com/products/') && !url.includes('b2b.asics.com/orders/'))) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please provide a valid ASICS B2B URL (products or orders page)' 
                });
            }
            
            try {
                console.log(`🧪 Testing scrape of: ${url}`);
                const result = await this.scrapeSinglePage(url);
                
                if (result.success && result.inventory && result.inventory.length > 0) {
                    await this.saveInventoryToDatabase(result.inventory);
                    res.json({
                        success: true,
                        message: `Successfully scraped ${result.inventory.length} records`,
                        data: result
                    });
                } else {
                    res.json({
                        success: false,
                        message: result.error || 'No inventory data found',
                        data: result
                    });
                }
            } catch (error) {
                console.error('Test scrape error:', error);
                res.status(500).json({
                    success: false,
                    message: 'Scraping failed: ' + error.message
                });
            }
        });
    }

    async init() {
        console.log('🚀 Initializing ASICS Weekly Batch Scraper...');
        console.log('💾 Memory available:', this.getMemoryUsage());
        
        await this.setupDatabaseTables();
        await this.loadPageList();
        this.startScheduler();
        
        console.log(`✅ Weekly batch scraper initialized with ${this.pageList.length} URLs`);
        console.log(`⚙️ Config: ${this.config.batchSize} URLs per batch, ${this.config.batchDelay/1000}s delay`);
    }

    async setupDatabaseTables() {
        const client = await this.db.connect();
        
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS monitored_pages (
                    id SERIAL PRIMARY KEY,
                    url VARCHAR(500) NOT NULL UNIQUE,
                    active BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS current_inventory (
                    id SERIAL PRIMARY KEY,
                    product_name VARCHAR(255),
                    style_id VARCHAR(50),
                    color_code VARCHAR(10),
                    color_name VARCHAR(100),
                    size_us VARCHAR(10),
                    quantity INTEGER,
                    raw_quantity VARCHAR(20),
                    source_url VARCHAR(500),
                    scraped_at TIMESTAMP,
                    batch_id VARCHAR(50),
                    UNIQUE(style_id, color_code, size_us)
                )
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS scrape_logs (
                    id SERIAL PRIMARY KEY,
                    batch_id VARCHAR(50),
                    total_pages INTEGER,
                    success_count INTEGER,
                    error_count INTEGER,
                    record_count INTEGER,
                    duration_seconds INTEGER,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            console.log('✅ Database tables ready');
            
        } catch (error) {
            console.error('❌ Database setup error:', error);
        } finally {
            client.release();
        }
    }

    async loadPageList() {
        try {
            const result = await this.db.query(
                'SELECT url FROM monitored_pages WHERE active = true ORDER BY created_at'
            );
            this.pageList = result.rows.map(row => row.url);
            console.log(`📋 Loaded ${this.pageList.length} URLs to monitor`);
        } catch (error) {
            console.error('Error loading pages:', error);
            this.pageList = [];
        }
    }

    startScheduler() {
        console.log('📅 Starting weekly scheduler - every Sunday at 2:00 AM');
        
        cron.schedule('0 2 * * 0', () => {
            if (!this.isRunning && this.pageList.length > 0) {
                console.log('📅 Scheduled weekly batch triggered');
                this.startWeeklyBatch();
            }
        });
    }

    async startWeeklyBatch() {
        if (this.isRunning) {
            console.log('⏳ Batch already running, skipping...');
            return;
        }

        this.isRunning = true;
        this.scrapingProgress.total = this.pageList.length;
        this.scrapingProgress.completed = 0;
        this.scrapingProgress.errors = 0;
        this.scrapingProgress.startTime = Date.now();
        
        const batchId = `batch_${Date.now()}`;
        console.log(`🚀 Starting weekly batch ${batchId}: ${this.pageList.length} URLs`);
        
        this.totalBatches = Math.ceil(this.pageList.length / this.config.batchSize);
        let allResults = [];
        
        try {
            for (let i = 0; i < this.pageList.length && this.isRunning; i += this.config.batchSize) {
                this.currentBatch = Math.floor(i / this.config.batchSize) + 1;
                const batch = this.pageList.slice(i, i + this.config.batchSize);
                
                console.log(`📦 Mini-batch ${this.currentBatch}/${this.totalBatches}: ${batch.length} URLs`);
                
                const batchResults = await this.processBatch(batch, batchId);
                allResults.push(...batchResults);
                
                this.scrapingProgress.completed = Math.min(i + this.config.batchSize, this.pageList.length);
                
                if (global.gc) {
                    global.gc();
                }
                
                if (i + this.config.batchSize < this.pageList.length && this.isRunning) {
                    console.log(`⏸️ Resting ${this.config.batchDelay/1000}s before next mini-batch...`);
                    await this.delay(this.config.batchDelay);
                }
            }
            
        } catch (error) {
            console.error('❌ Batch processing error:', error);
        }
        
        await this.processResults(allResults, batchId);
        
        this.isRunning = false;
        this.lastScrapeTime = new Date().toISOString();
        this.scrapingProgress.currentUrl = null;
        
        const duration = Math.round((Date.now() - this.scrapingProgress.startTime) / 1000);
        console.log(`✅ Weekly batch ${batchId} completed in ${duration} seconds`);
    }

    async processBatch(urls, batchId) {
        let browser;
        const results = [];
        
        try {
            // Use the FIXED authenticated browser
            console.log('🔧 Using FIXED authentication method...');
            browser = await this.getAuthenticatedBrowser(); // Use new method name
            
            for (let i = 0; i < urls.length && this.isRunning; i++) {
                const url = urls[i];
                this.scrapingProgress.currentUrl = url;
                
                console.log(`🔍 Scraping authenticated page ${i + 1}/${urls.length}: ${url}`);
                
                try {
                    const result = await this.scrapeAuthenticatedPage(browser, url, batchId);
                    results.push(result);
                    
                    if (!result.success) {
                        this.scrapingProgress.errors++;
                    }
                    
                } catch (error) {
                    console.error(`❌ Error scraping ${url}:`, error.message);
                    results.push({
                        url: url,
                        success: false,
                        error: error.message,
                        timestamp: new Date().toISOString(),
                        batchId: batchId
                    });
                    this.scrapingProgress.errors++;
                }
                
                if (i < urls.length - 1 && this.isRunning) {
                    console.log(`⏸️ Waiting ${this.config.pageDelay/1000}s before next page...`);
                    await this.delay(this.config.pageDelay);
                }
            }
            
        } catch (error) {
            console.error('❌ Batch authentication error:', error);
            
            // Add all remaining URLs as failed
            for (let i = results.length; i < urls.length; i++) {
                results.push({
                    url: urls[i],
                    success: false,
                    error: 'Authentication failed - ' + error.message,
                    timestamp: new Date().toISOString(),
                    batchId: batchId
                });
                this.scrapingProgress.errors++;
            }
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError) {
                    console.error('❌ Error closing browser:', closeError.message);
                }
                browser = null;
            }
            
            if (global.gc) {
                global.gc();
            }
        }
        
        return results;
    }

    // NEW METHOD: Fixed authentication that handles country selection
    async getAuthenticatedBrowser() {
        console.log('🚀 [FIXED] Launching browser with ASICS B2B authentication...');
        
        const browser = await puppeteer.launch({
            executablePath: await chromium.executablePath(),
            args: [
                ...chromium.args,
                '--disable-dev-shm-usage',
                '--memory-pressure-off',
                '--max-old-space-size=128'
            ],
            headless: chromium.headless,
            defaultViewport: { width: 1024, height: 768 }
        });
        
        const page = await browser.newPage();
        
        try {
            console.log('🔐 [FIXED] Navigating to ASICS B2B authentication...');
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Navigate to authentication page
            await page.goto('https://b2b.asics.com/authentication/login', { 
                waitUntil: 'networkidle0', 
                timeout: 60000 
            });
            
            console.log('📋 [FIXED] Current URL:', page.url());
            console.log('📋 [FIXED] Page title:', await page.title());
            
            // Check credentials
            if (!process.env.ASICS_USERNAME || !process.env.ASICS_PASSWORD) {
                throw new Error('ASICS credentials not found. Set ASICS_USERNAME and ASICS_PASSWORD environment variables.');
            }
            
            await this.delay(3000);
            
            // Check if we see country selection
            const pageContent = await page.evaluate(() => {
                return {
                    title: document.title,
                    url: window.location.href,
                    bodyText: document.body.innerText.substring(0, 200),
                    hasCountrySelection: document.body.innerText.includes('Please Select The Region'),
                    hasLoginForm: !!(
                        document.querySelector('input[type="email"]') ||
                        document.querySelector('input[type="password"]')
                    )
                };
            });
            
            console.log('📊 [FIXED] Page content check:', pageContent);
            
            if (pageContent.hasCountrySelection && !pageContent.hasLoginForm) {
                console.log('🌍 [FIXED] Country selection detected, clicking United States...');
                
                // Click United States button
                const countrySelected = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const usButton = buttons.find(btn => 
                        btn.textContent.trim().includes('United States')
                    );
                    
                    if (usButton) {
                        console.log('Clicking US button:', usButton.textContent);
                        usButton.click();
                        return true;
                    }
                    return false;
                });
                
                if (!countrySelected) {
                    throw new Error('Could not find United States button on country selection page');
                }
                
                console.log('⏳ [FIXED] Waiting for login form after country selection...');
                await this.delay(5000);
                
                // Wait for login form to appear
                try {
                    await page.waitForSelector('input[type="email"], input[type="password"], input[name*="email"]', { 
                        timeout: 15000 
                    });
                    console.log('✅ [FIXED] Login form appeared');
                } catch (e) {
                    console.log('⚠️ [FIXED] Login form wait timeout, checking manually...');
                }
            }
            
            // Check for login form
            const loginFormExists = await page.evaluate(() => {
                const hasEmailField = !!(
                    document.querySelector('input[type="email"]') ||
                    document.querySelector('input[name*="email"]') ||
                    document.querySelector('input[name*="user"]')
                );
                const hasPasswordField = !!document.querySelector('input[type="password"]');
                
                return { hasEmailField, hasPasswordField, hasBoth: hasEmailField && hasPasswordField };
            });
            
            console.log('📝 [FIXED] Login form check:', loginFormExists);
            
            if (!loginFormExists.hasBoth) {
                // Log current page state for debugging
                const currentState = await page.evaluate(() => ({
                    url: window.location.href,
                    title: document.title,
                    bodyText: document.body.innerText.substring(0, 500)
                }));
                console.log('🔍 [FIXED] Current page state:', currentState);
                
                throw new Error(`Login form incomplete. Email: ${loginFormExists.hasEmailField}, Password: ${loginFormExists.hasPasswordField}`);
            }
            
            console.log('✅ [FIXED] Login form detected, filling credentials...');
            
            // Fill email
            const emailFilled = await page.evaluate((username) => {
                const emailSelectors = [
                    'input[type="email"]',
                    'input[name="email"]',
                    'input[name="username"]',
                    'input[name*="user"]',
                    'input[name*="email"]'
                ];
                
                for (let selector of emailSelectors) {
                    const field = document.querySelector(selector);
                    if (field && field.offsetWidth > 0 && field.offsetHeight > 0) {
                        field.focus();
                        field.value = '';
                        field.value = username;
                        field.dispatchEvent(new Event('input', { bubbles: true }));
                        field.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    }
                }
                return false;
            }, process.env.ASICS_USERNAME);
            
            if (!emailFilled) {
                throw new Error('Could not fill email field');
            }
            
            console.log('📧 [FIXED] Email filled');
            
            // Fill password
            const passwordFilled = await page.evaluate((password) => {
                const passwordField = document.querySelector('input[type="password"]');
                if (passwordField && passwordField.offsetWidth > 0 && passwordField.offsetHeight > 0) {
                    passwordField.focus();
                    passwordField.value = '';
                    passwordField.value = password;
                    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordField.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            }, process.env.ASICS_PASSWORD);
            
            if (!passwordFilled) {
                throw new Error('Could not fill password field');
            }
            
            console.log('🔒 [FIXED] Password filled');
            
            await this.delay(1000);
            
            // Click login
            console.log('🔐 [FIXED] Clicking login button...');
            
            const loginClicked = await page.evaluate(() => {
                const buttonSelectors = [
                    'button[type="submit"]',
                    'input[type="submit"]',
                    'button'
                ];
                
                for (let selector of buttonSelectors) {
                    const buttons = document.querySelectorAll(selector);
                    for (let button of buttons) {
                        if (button.offsetWidth > 0 && button.offsetHeight > 0) {
                            const text = (button.textContent || button.value || '').toLowerCase();
                            if (text.includes('login') || text.includes('sign') || text.includes('submit') || button.type === 'submit') {
                                button.click();
                                return true;
                            }
                        }
                    }
                }
                return false;
            });
            
            if (!loginClicked) {
                throw new Error('Could not click login button');
            }
            
            console.log('⏳ [FIXED] Waiting for login completion...');
            await this.delay(5000);
            
            // Verify login
            const currentUrl = page.url();
            const currentTitle = await page.title();
            
            console.log('📍 [FIXED] After login URL:', currentUrl);
            console.log('📍 [FIXED] After login title:', currentTitle);
            
            if (currentUrl.includes('/authentication/') || currentTitle.toLowerCase().includes('login')) {
                const errorMessage = await page.evaluate(() => {
                    const errorElements = document.querySelectorAll('[class*="error"], .alert, [role="alert"]');
                    for (let el of errorElements) {
                        const text = el.textContent.trim();
                        if (text.length > 0) return text;
                    }
                    return null;
                });
                
                throw new Error(errorMessage ? `Login failed: ${errorMessage}` : 'Login failed - still on auth page');
            }
            
            console.log('✅ [FIXED] Authentication successful!');
            await page.close();
            
            return browser;
            
        } catch (error) {
            console.error('❌ [FIXED] Authentication failed:', error.message);
            
            try {
                await page.screenshot({ type: 'png', fullPage: true });
                console.log('📸 [FIXED] Screenshot taken');
                
                const debugInfo = await page.evaluate(() => ({
                    url: window.location.href,
                    title: document.title,
                    bodySnippet: document.body.innerText.substring(0, 300)
                }));
                console.log('🔍 [FIXED] Debug info:', debugInfo);
                
            } catch (debugError) {
                console.log('❌ Debug failed:', debugError.message);
            }
            
            await browser.close();
            throw error;
        }
    }

    async scrapeAuthenticatedPage(browser, url, batchId) {
        const page = await browser.newPage();
        
        try {
            console.log(`🔍 Accessing authenticated ASICS B2B page: ${url}`);
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Navigate to the authenticated page
            await page.goto(url, { 
                waitUntil: 'networkidle0', 
                timeout: 60000 
            });

            // Check if we got redirected to login (session expired)
            const currentUrl = page.url();
            console.log('📍 Current page URL:', currentUrl);
            
            if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('auth')) {
                throw new Error('Session expired or authentication required - redirected to login page');
            }

            // Wait for page content to load with multiple selector attempts
            const possibleSelectors = [
                '.grid',
                '[class*="grid"]',
                'table',
                '[class*="inventory"]',
                '[class*="product"]',
                '[class*="order"]',
                'main',
                'body'
            ];
            
            let pageLoaded = false;
            for (let selector of possibleSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 10000 });
                    console.log(`✅ Page content loaded, found selector: ${selector}`);
                    pageLoaded = true;
                    break;
                } catch (e) {
                    console.log(`⚠️ Selector ${selector} not found, trying next...`);
                }
            }
            
            if (!pageLoaded) {
                console.log('⚠️ No specific selectors found, proceeding with basic wait...');
                await this.delay(5000);
            } else {
                // Additional wait for dynamic content
                await this.delay(3000);
            }

            // Extract inventory using your proven extension logic
            const inventory = await page.evaluate(() => {
                class ASICSInventoryExtractor {
                    extractInventoryData() {
                        const inventory = [];
                        const productInfo = this.getProductInfo();
                        const colors = this.findColors();
                        const sizes = this.findSizes();
                        const quantityMatrix = this.findQuantityMatrix();
                        
                        console.log('🏷️ Product:', productInfo);
                        console.log('🎨 Colors found:', colors.length);
                        console.log('📏 Sizes found:', sizes.length);
                        console.log('📊 Quantity matrix rows:', quantityMatrix.length);
                        
                        if (colors.length === 0 || sizes.length === 0) {
                            console.warn('⚠️ Missing colors or sizes data, using fallback extraction');
                            return this.fallbackExtraction(productInfo);
                        }
                        
                        colors.forEach((color, colorIndex) => {
                            const colorQuantities = quantityMatrix[colorIndex] || [];
                            sizes.forEach((size, sizeIndex) => {
                                const quantity = colorQuantities[sizeIndex] || '0';
                                inventory.push({
                                    productName: productInfo.productName,
                                    styleId: productInfo.styleId,
                                    colorCode: color.code,
                                    colorName: color.name,
                                    sizeUS: size,
                                    quantity: this.parseQuantity(quantity),
                                    rawQuantity: quantity,
                                    extractedAt: new Date().toISOString(),
                                    url: window.location.href
                                });
                            });
                        });
                        
                        return inventory;
                    }

                    getProductInfo() {
                        // Try multiple ways to get product name
                        let productName = 'Unknown Product';
                        const nameSelectors = [
                            'h1',
                            '[data-testid="product-name"]',
                            '.product-name',
                            '.product-title',
                            '[class*="product"][class*="name"]',
                            '[class*="title"]'
                        ];
                        
                        for (let selector of nameSelectors) {
                            const element = document.querySelector(selector);
                            if (element && element.textContent.trim()) {
                                productName = element.textContent.trim();
                                break;
                            }
                        }
                        
                        // Extract style ID from URL
                        let styleId = 'Unknown';
                        const urlMatch = window.location.href.match(/products\/([0-9A-Z]+)/);
                        if (urlMatch) {
                            styleId = urlMatch[1];
                        }
                        
                        return { productName, styleId };
                    }

                    findColors() {
                        const colors = [];
                        
                        // Method 1: Look for color information in flex structure (from your extension)
                        const colorElements = document.querySelectorAll('li div.flex.items-center.gap-2');
                        
                        colorElements.forEach(el => {
                            const spans = el.querySelectorAll('span');
                            if (spans.length >= 3) {
                                const code = spans[0].textContent.trim();
                                const separator = spans[1].textContent.trim();
                                const name = spans[2].textContent.trim();
                                
                                if (code.match(/^\d{3}$/) && separator === '-') {
                                    colors.push({ code, name });
                                }
                            }
                        });
                        
                        // Method 2: Extract from URL colorCode parameter
                        if (colors.length === 0) {
                            const urlParams = new URLSearchParams(window.location.search);
                            const colorCode = urlParams.get('colorCode');
                            if (colorCode) {
                                colors.push({
                                    code: colorCode,
                                    name: 'Color ' + colorCode
                                });
                            }
                        }
                        
                        // Method 3: Fallback search for color patterns in page text
                        if (colors.length === 0) {
                            const allElements = document.querySelectorAll('*');
                            const seenCodes = new Set();
                            
                            allElements.forEach(el => {
                                const text = el.textContent.trim();
                                const colorMatch = text.match(/^(\d{3})\s*-\s*([A-Z\/\s]+)$/);
                                if (colorMatch && !seenCodes.has(colorMatch[1])) {
                                    seenCodes.add(colorMatch[1]);
                                    colors.push({
                                        code: colorMatch[1],
                                        name: colorMatch[2].trim()
                                    });
                                }
                            });
                        }
                        
                        return colors;
                    }

                    findSizes() {
                        const sizes = [];
                        
                        // Method 1: Look for size headers with specific classes
                        const sizeElements = document.querySelectorAll('.bg-primary.text-white');
                        
                        sizeElements.forEach(el => {
                            const sizeText = el.textContent.trim();
                            if (sizeText.match(/^\d+\.?\d*$/)) {
                                sizes.push(sizeText);
                            }
                        });
                        
                        // Method 2: Look for any elements that might contain sizes
                        if (sizes.length === 0) {
                            const allElements = document.querySelectorAll('th, td, span, div');
                            const sizePattern = /^(\d{1,2}(?:\.\d)?|\d{1,2}½)$/;
                            const foundSizes = new Set();
                            
                            allElements.forEach(el => {
                                const text = el.textContent.trim();
                                if (sizePattern.test(text) && parseFloat(text) >= 6 && parseFloat(text) <= 15) {
                                    foundSizes.add(text);
                                }
                            });
                            
                            sizes.push(...Array.from(foundSizes).sort((a, b) => parseFloat(a) - parseFloat(b)));
                        }
                        
                        // Fallback to standard US sizes
                        if (sizes.length === 0) {
                            return ['6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10', '10.5', '11', '11.5', '12', '12.5', '13', '14', '15'];
                        }
                        
                        return sizes;
                    }

                    findQuantityMatrix() {
                        const quantityMatrix = [];
                        
                        // Method 1: Grid structure (from your extension)
                        const quantityRows = document.querySelectorAll('.grid.grid-flow-col.items-center');
                        
                        quantityRows.forEach((row, index) => {
                            const quantities = [];
                            const cells = row.querySelectorAll('.flex.items-center.justify-center span');
                            
                            cells.forEach(cell => {
                                const text = cell.textContent.trim();
                                if (text.match(/^\d+\+?$/) || text === '0' || text === '0+') {
                                    quantities.push(text);
                                }
                            });
                            
                            if (quantities.length > 0) {
                                quantityMatrix.push(quantities);
                            }
                        });
                        
                        // Method 2: Table-based extraction
                        if (quantityMatrix.length === 0) {
                            const tables = document.querySelectorAll('table');
                            tables.forEach(table => {
                                const rows = table.querySelectorAll('tr');
                                rows.forEach(row => {
                                    const cells = row.querySelectorAll('td, th');
                                    const quantities = [];
                                    
                                    cells.forEach(cell => {
                                        const text = cell.textContent.trim();
                                        if (text.match(/^\d+\+?$/) || text === '0') {
                                            quantities.push(text);
                                        }
                                    });
                                    
                                    if (quantities.length > 3) { // Reasonable threshold
                                        quantityMatrix.push(quantities);
                                    }
                                });
                            });
                        }
                        
                        // Method 3: Position-based extraction (from your extension)
                        if (quantityMatrix.length === 0) {
                            const potentialQuantityElements = document.querySelectorAll('span, div, td');
                            const quantityPattern = /^(\d+\+?|0\+?)$/;
                            const foundQuantities = [];
                            
                            potentialQuantityElements.forEach(el => {
                                const text = el.textContent.trim();
                                if (quantityPattern.test(text)) {
                                    const rect = el.getBoundingClientRect();
                                    foundQuantities.push({
                                        text,
                                        x: rect.left,
                                        y: rect.top
                                    });
                                }
                            });
                            
                            // Group by Y coordinate (rows)
                            foundQuantities.sort((a, b) => a.y - b.y);
                            
                            let currentRow = [];
                            let lastY = -1;
                            const tolerance = 10;
                            
                            foundQuantities.forEach(q => {
                                if (lastY === -1 || Math.abs(q.y - lastY) < tolerance) {
                                    currentRow.push(q.text);
                                    lastY = q.y;
                                } else {
                                    if (currentRow.length > 3) {
                                        quantityMatrix.push([...currentRow]);
                                    }
                                    currentRow = [q.text];
                                    lastY = q.y;
                                }
                            });
                            
                            if (currentRow.length > 3) {
                                quantityMatrix.push(currentRow);
                            }
                        }
                        
                        return quantityMatrix;
                    }
                    
                    fallbackExtraction(productInfo) {
                        // If structured extraction fails, try to extract whatever we can
                        console.log('🔄 Using fallback extraction method');
                        
                        const inventory = [];
                        const urlParams = new URLSearchParams(window.location.search);
                        const colorCode = urlParams.get('colorCode') || '000';
                        
                        // Look for any quantity information on the page
                        const quantityElements = document.querySelectorAll('*');
                        const quantities = [];
                        
                        quantityElements.forEach(el => {
                            const text = el.textContent.trim();
                            if (text.match(/^\d+$/) && parseInt(text) >= 0 && parseInt(text) <= 999) {
                                quantities.push(text);
                            }
                        });
                        
                        // Create at least one record with available information
                        inventory.push({
                            productName: productInfo.productName,
                            styleId: productInfo.styleId,
                            colorCode: colorCode,
                            colorName: 'Color ' + colorCode,
                            sizeUS: 'Various',
                            quantity: quantities.length > 0 ? parseInt(quantities[0]) : 0,
                            rawQuantity: quantities.length > 0 ? quantities[0] : '0',
                            extractedAt: new Date().toISOString(),
                            url: window.location.href
                        });
                        
                        return inventory;
                    }

                    parseQuantity(quantityText) {
                        if (!quantityText || quantityText === '-' || quantityText === '') return 0;
                        if (quantityText.includes('+')) {
                            const num = parseInt(quantityText.replace('+', ''));
                            return isNaN(num) ? 0 : num;
                        }
                        const num = parseInt(quantityText);
                        return isNaN(num) ? 0 : num;
                    }
                }

                const extractor = new ASICSInventoryExtractor();
                return extractor.extractInventoryData();
            });

            console.log(`✅ ${url}: ${inventory.length} records extracted from authenticated page`);
            
            return {
                url,
                success: true,
                inventory,
                recordCount: inventory.length,
                timestamp: new Date().toISOString(),
                batchId
            };

        } catch (error) {
            console.error(`❌ Error scraping authenticated page ${url}:`, error.message);
            return {
                url,
                success: false,
                error: error.message,
                timestamp: new Date().toISOString(),
                batchId
            };
        } finally {
            await page.close();
        }
    }

    async getBrowser() {
        console.log('🚀 Launching browser with authentication support...');
        
        const browser = await puppeteer.launch({
            executablePath: await chromium.executablePath(),
            args: [
                ...chromium.args,
                '--disable-dev-shm-usage',
                '--memory-pressure-off',
                '--max-old-space-size=128'
            ],
            headless: chromium.headless,
            defaultViewport: { width: 1024, height: 768 }
        });
        
        console.log('✅ Browser launched successfully');
        return browser;
    }

    async getBrowserWithAuth() {
        console.log('🚀 Launching browser with ASICS B2B authentication...');
        
        const browser = await puppeteer.launch({
            executablePath: await chromium.executablePath(),
            args: [
                ...chromium.args,
                '--disable-dev-shm-usage',
                '--memory-pressure-off',
                '--max-old-space-size=128'
            ],
            headless: chromium.headless,
            defaultViewport: { width: 1024, height: 768 }
        });
        
        // Create a new page for authentication
        const page = await browser.newPage();
        
        try {
            console.log('🔐 Attempting to access ASICS B2B portal...');
            
            // Set user agent to appear more like a real browser
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Navigate to the main B2B site first
            await page.goto('https://b2b.asics.com', { 
                waitUntil: 'networkidle0', 
                timeout: 60000 
            });
            
            console.log('📋 Current page URL:', page.url());
            console.log('📋 Page title:', await page.title());
            
            // Debug: Check what's actually on the page
            console.log('🔍 Debugging page content...');
            
            const pageContent = await page.evaluate(() => {
                return {
                    title: document.title,
                    url: window.location.href,
                    bodyText: document.body.innerText.substring(0, 500),
                    forms: Array.from(document.querySelectorAll('form')).length,
                    inputs: Array.from(document.querySelectorAll('input')).map(input => ({
                        type: input.type,
                        name: input.name,
                        id: input.id,
                        placeholder: input.placeholder,
                        className: input.className
                    })),
                    buttons: Array.from(document.querySelectorAll('button, input[type="submit"]')).map(btn => ({
                        text: btn.textContent || btn.value,
                        type: btn.type,
                        className: btn.className
                    })),
                    hasLoginElements: !!(
                        document.querySelector('input[type="email"]') ||
                        document.querySelector('input[type="password"]') ||
                        document.querySelector('input[name*="user"]') ||
                        document.querySelector('input[name*="email"]') ||
                        document.querySelector('input[name*="login"]')
                    )
                };
            });
            
            console.log('📊 Page Analysis:', JSON.stringify(pageContent, null, 2));
            
            // Check if we're already on a login page or need to find login
            if (!pageContent.hasLoginElements) {
                console.log('🔍 No login elements found, looking for login link...');
                
                // Look for login links
                const loginLinks = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    return links.filter(link => 
                        link.textContent.toLowerCase().includes('login') ||
                        link.textContent.toLowerCase().includes('sign in') ||
                        link.href.includes('login') ||
                        link.href.includes('signin') ||
                        link.href.includes('auth')
                    ).map(link => ({
                        text: link.textContent.trim(),
                        href: link.href
                    }));
                });
                
                console.log('🔗 Found login links:', loginLinks);
                
                if (loginLinks.length > 0) {
                    console.log('🔗 Clicking login link:', loginLinks[0].href);
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
                        page.click(`a[href*="login"], a[href*="signin"], a:contains("Login"), a:contains("Sign In")`)
                    ]);
                } else {
                    // Try navigating to common login paths
                    const loginPaths = [
                        'https://b2b.asics.com/login',
                        'https://b2b.asics.com/signin',
                        'https://b2b.asics.com/auth/login',
                        'https://b2b.asics.com/account/login'
                    ];
                    
                    for (let loginPath of loginPaths) {
                        try {
                            console.log(`🔍 Trying login path: ${loginPath}`);
                            await page.goto(loginPath, { waitUntil: 'networkidle0', timeout: 30000 });
                            
                            const hasLogin = await page.evaluate(() => {
                                return !!(
                                    document.querySelector('input[type="email"]') ||
                                    document.querySelector('input[type="password"]') ||
                                    document.querySelector('input[name*="user"]') ||
                                    document.querySelector('input[name*="email"]')
                                );
                            });
                            
                            if (hasLogin) {
                                console.log('✅ Found login page at:', loginPath);
                                break;
                            }
                        } catch (e) {
                            console.log(`❌ Login path ${loginPath} failed:`, e.message);
                        }
                    }
                }
            }
            
            // Wait a bit for any dynamic content to load
            await this.delay(3000);
            
            // Get updated page info
            const loginPageContent = await page.evaluate(() => {
                return {
                    url: window.location.href,
                    title: document.title,
                    allInputs: Array.from(document.querySelectorAll('input')).map(input => ({
                        type: input.type,
                        name: input.name,
                        id: input.id,
                        placeholder: input.placeholder,
                        className: input.className,
                        visible: input.offsetWidth > 0 && input.offsetHeight > 0
                    })),
                    bodyText: document.body.innerText.substring(0, 300)
                };
            });
            
            console.log('📊 Login Page Analysis:', JSON.stringify(loginPageContent, null, 2));
            
            // Check if we have credentials
            if (!process.env.ASICS_USERNAME || !process.env.ASICS_PASSWORD) {
                throw new Error('ASICS credentials not found. Please set ASICS_USERNAME and ASICS_PASSWORD environment variables.');
            }
            
            // Try to find and fill login form
            console.log('✍️ Attempting to fill login form...');
            
            // Find email/username field
            const emailSelectors = [
                'input[type="email"]',
                'input[name="email"]',
                'input[name="username"]',
                'input[name="user"]',
                'input[name="login"]',
                '#email',
                '#username',
                '#user',
                '#login',
                '[data-testid="email"]',
                '[data-testid="username"]',
                'input[placeholder*="email" i]',
                'input[placeholder*="username" i]'
            ];
            
            let emailField = null;
            for (let selector of emailSelectors) {
                try {
                    const field = await page.$(selector);
                    if (field) {
                        const isVisible = await field.evaluate(el => el.offsetWidth > 0 && el.offsetHeight > 0);
                        if (isVisible) {
                            console.log(`📧 Found email field with selector: ${selector}`);
                            emailField = field;
                            break;
                        }
                    }
                } catch (e) {
                    // Continue to next selector
                }
            }
            
            if (!emailField) {
                // Try to find any visible input that might be the email field
                const allInputs = await page.$('input');
                for (let input of allInputs) {
                    const inputInfo = await input.evaluate(el => ({
                        type: el.type,
                        name: el.name,
                        id: el.id,
                        placeholder: el.placeholder,
                        visible: el.offsetWidth > 0 && el.offsetHeight > 0
                    }));
                    
                    if (inputInfo.visible && (
                        inputInfo.type === 'email' ||
                        inputInfo.type === 'text' ||
                        inputInfo.name?.toLowerCase().includes('email') ||
                        inputInfo.name?.toLowerCase().includes('user') ||
                        inputInfo.placeholder?.toLowerCase().includes('email') ||
                        inputInfo.placeholder?.toLowerCase().includes('user')
                    )) {
                        console.log(`📧 Found potential email field:`, inputInfo);
                        emailField = input;
                        break;
                    }
                }
            }
            
            if (!emailField) {
                throw new Error('Could not find email/username input field on login page');
            }
            
            // Fill email
            await emailField.click();
            await emailField.type(process.env.ASICS_USERNAME, { delay: 100 });
            console.log('📧 Email field filled');
            
            // Find password field
            const passwordSelectors = [
                'input[type="password"]',
                'input[name="password"]',
                '#password',
                '[data-testid="password"]'
            ];
            
            let passwordField = null;
            for (let selector of passwordSelectors) {
                try {
                    const field = await page.$(selector);
                    if (field) {
                        const isVisible = await field.evaluate(el => el.offsetWidth > 0 && el.offsetHeight > 0);
                        if (isVisible) {
                            console.log(`🔒 Found password field with selector: ${selector}`);
                            passwordField = field;
                            break;
                        }
                    }
                } catch (e) {
                    // Continue to next selector
                }
            }
            
            if (!passwordField) {
                throw new Error('Could not find password input field on login page');
            }
            
            // Fill password
            await passwordField.click();
            await passwordField.type(process.env.ASICS_PASSWORD, { delay: 100 });
            console.log('🔒 Password field filled');
            
            // Find and click login button
            const loginButtons = await page.$('button, input[type="submit"]');
            let loginButton = null;
            
            for (let button of loginButtons) {
                const buttonInfo = await button.evaluate(el => ({
                    text: el.textContent || el.value,
                    type: el.type,
                    visible: el.offsetWidth > 0 && el.offsetHeight > 0
                }));
                
                if (buttonInfo.visible && (
                    buttonInfo.text?.toLowerCase().includes('login') ||
                    buttonInfo.text?.toLowerCase().includes('sign in') ||
                    buttonInfo.text?.toLowerCase().includes('submit') ||
                    buttonInfo.type === 'submit'
                )) {
                    console.log(`🔘 Found login button:`, buttonInfo);
                    loginButton = button;
                    break;
                }
            }
            
            if (!loginButton) {
                throw new Error('Could not find login button on page');
            }
            
            console.log('🔐 Attempting login...');
            
            // Click login button and wait for navigation
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }),
                loginButton.click()
            ]);
            
            // Verify login success
            const currentUrl = page.url();
            const currentTitle = await page.title();
            console.log('📍 After login URL:', currentUrl);
            console.log('📍 After login title:', currentTitle);
            
            if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('auth/error')) {
                // Check for error messages on the page
                const errorMessages = await page.evaluate(() => {
                    const errorElements = document.querySelectorAll(
                        '[class*="error"], [class*="alert"], .text-red-500, .text-danger, .error-message, .alert-danger'
                    );
                    return Array.from(errorElements).map(el => el.textContent.trim()).filter(text => text.length > 0);
                });
                
                if (errorMessages.length > 0) {
                    throw new Error(`Login failed: ${errorMessages.join(', ')}`);
                } else {
                    throw new Error('Login failed - still on login page. Please check credentials.');
                }
            }
            
            // Additional verification - wait for dashboard/main page elements
            await this.delay(3000);
            
            console.log('✅ Successfully logged into ASICS B2B portal');
            console.log('🍪 Session established, browser ready for authenticated requests');
            
            // Close the login page but keep the browser with session
            await page.close();
            
            return browser;
            
        } catch (error) {
            console.error('❌ Authentication failed:', error.message);
            
            // Take screenshot for debugging
            try {
                const screenshot = await page.screenshot({ type: 'png', fullPage: true });
                console.log('📸 Full page screenshot taken for debugging');
                
                // Also log current page HTML for debugging
                const pageHtml = await page.content();
                console.log('📄 Page HTML (first 1000 chars):', pageHtml.substring(0, 1000));
                
            } catch (screenshotError) {
                console.log('📸 Could not take screenshot:', screenshotError.message);
            }
            
            await browser.close();
            throw error;
        }
    }

    async scrapePage(browser, url, batchId) {
        const page = await browser.newPage();
        
        try {
            console.log(`🔍 Scraping ASICS B2B order page: ${url}`);
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Navigate to the order page
            await page.goto(url, { 
                waitUntil: 'networkidle0', 
                timeout: 60000 
            });

            // Wait for the page to load - try multiple selectors that might exist on order pages
            const possibleSelectors = [
                '.grid',
                '[class*="grid"]',
                'table',
                '[class*="inventory"]',
                '[class*="product"]',
                'main',
                'body'
            ];
            
            let pageLoaded = false;
            for (let selector of possibleSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 10000 });
                    console.log(`✅ Page loaded, found selector: ${selector}`);
                    pageLoaded = true;
                    break;
                } catch (e) {
                    console.log(`⚠️ Selector ${selector} not found, trying next...`);
                }
            }
            
            if (!pageLoaded) {
                console.log('⚠️ No common selectors found, proceeding with basic wait...');
                await this.delay(5000);
            } else {
                // Additional wait for dynamic content
                await this.delay(3000);
            }

            // Extract inventory using the logic from your working extension
            const inventory = await page.evaluate(() => {
                class ASICSInventoryExtractor {
                    extractInventoryData() {
                        const inventory = [];
                        const productInfo = this.getProductInfo();
                        const colors = this.findColors();
                        const sizes = this.findSizes();
                        const quantityMatrix = this.findQuantityMatrix();
                        
                        console.log('🏷️ Product:', productInfo);
                        console.log('🎨 Colors found:', colors.length);
                        console.log('📏 Sizes found:', sizes.length);
                        console.log('📊 Quantity matrix rows:', quantityMatrix.length);
                        
                        if (colors.length === 0 || sizes.length === 0) {
                            console.warn('⚠️ Missing colors or sizes data, using fallback extraction');
                            return this.fallbackExtraction(productInfo);
                        }
                        
                        colors.forEach((color, colorIndex) => {
                            const colorQuantities = quantityMatrix[colorIndex] || [];
                            sizes.forEach((size, sizeIndex) => {
                                const quantity = colorQuantities[sizeIndex] || '0';
                                inventory.push({
                                    productName: productInfo.productName,
                                    styleId: productInfo.styleId,
                                    colorCode: color.code,
                                    colorName: color.name,
                                    sizeUS: size,
                                    quantity: this.parseQuantity(quantity),
                                    rawQuantity: quantity,
                                    extractedAt: new Date().toISOString(),
                                    url: window.location.href
                                });
                            });
                        });
                        
                        return inventory;
                    }

                    getProductInfo() {
                        // Try multiple ways to get product name
                        let productName = 'Unknown Product';
                        const nameSelectors = [
                            'h1',
                            '[data-testid="product-name"]',
                            '.product-name',
                            '.product-title'
                        ];
                        
                        for (let selector of nameSelectors) {
                            const element = document.querySelector(selector);
                            if (element && element.textContent.trim()) {
                                productName = element.textContent.trim();
                                break;
                            }
                        }
                        
                        // Extract style ID from URL
                        let styleId = 'Unknown';
                        const urlMatch = window.location.href.match(/products\/([0-9A-Z]+)/);
                        if (urlMatch) {
                            styleId = urlMatch[1];
                        }
                        
                        return { productName, styleId };
                    }

                    findColors() {
                        const colors = [];
                        
                        // Method 1: Look for color information in flex structure (from your extension)
                        const colorElements = document.querySelectorAll('li div.flex.items-center.gap-2');
                        
                        colorElements.forEach(el => {
                            const spans = el.querySelectorAll('span');
                            if (spans.length >= 3) {
                                const code = spans[0].textContent.trim();
                                const separator = spans[1].textContent.trim();
                                const name = spans[2].textContent.trim();
                                
                                if (code.match(/^\d{3}$/) && separator === '-') {
                                    colors.push({ code, name });
                                }
                            }
                        });
                        
                        // Method 2: Extract from URL colorCode parameter
                        if (colors.length === 0) {
                            const urlParams = new URLSearchParams(window.location.search);
                            const colorCode = urlParams.get('colorCode');
                            if (colorCode) {
                                colors.push({
                                    code: colorCode,
                                    name: 'Color ' + colorCode
                                });
                            }
                        }
                        
                        // Method 3: Fallback search for color patterns in page text
                        if (colors.length === 0) {
                            const allElements = document.querySelectorAll('*');
                            const seenCodes = new Set();
                            
                            allElements.forEach(el => {
                                const text = el.textContent.trim();
                                const colorMatch = text.match(/^(\d{3})\s*-\s*([A-Z\/\s]+)$/);
                                if (colorMatch && !seenCodes.has(colorMatch[1])) {
                                    seenCodes.add(colorMatch[1]);
                                    colors.push({
                                        code: colorMatch[1],
                                        name: colorMatch[2].trim()
                                    });
                                }
                            });
                        }
                        
                        return colors;
                    }

                    findSizes() {
                        const sizes = [];
                        
                        // Method 1: Look for size headers with specific classes
                        const sizeElements = document.querySelectorAll('.bg-primary.text-white');
                        
                        sizeElements.forEach(el => {
                            const sizeText = el.textContent.trim();
                            if (sizeText.match(/^\d+\.?\d*$/)) {
                                sizes.push(sizeText);
                            }
                        });
                        
                        // Method 2: Look for any elements that might contain sizes
                        if (sizes.length === 0) {
                            const allElements = document.querySelectorAll('th, td, span, div');
                            const sizePattern = /^(\d{1,2}(?:\.\d)?|\d{1,2}½)$/;
                            const foundSizes = new Set();
                            
                            allElements.forEach(el => {
                                const text = el.textContent.trim();
                                if (sizePattern.test(text) && parseFloat(text) >= 6 && parseFloat(text) <= 15) {
                                    foundSizes.add(text);
                                }
                            });
                            
                            sizes.push(...Array.from(foundSizes).sort((a, b) => parseFloat(a) - parseFloat(b)));
                        }
                        
                        // Fallback to standard US sizes
                        if (sizes.length === 0) {
                            return ['6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10', '10.5', '11', '11.5', '12', '12.5', '13', '14', '15'];
                        }
                        
                        return sizes;
                    }

                    findQuantityMatrix() {
                        const quantityMatrix = [];
                        
                        // Method 1: Grid structure (from your extension)
                        const quantityRows = document.querySelectorAll('.grid.grid-flow-col.items-center');
                        
                        quantityRows.forEach((row, index) => {
                            const quantities = [];
                            const cells = row.querySelectorAll('.flex.items-center.justify-center span');
                            
                            cells.forEach(cell => {
                                const text = cell.textContent.trim();
                                if (text.match(/^\d+\+?$/) || text === '0' || text === '0+') {
                                    quantities.push(text);
                                }
                            });
                            
                            if (quantities.length > 0) {
                                quantityMatrix.push(quantities);
                            }
                        });
                        
                        // Method 2: Table-based extraction
                        if (quantityMatrix.length === 0) {
                            const tables = document.querySelectorAll('table');
                            tables.forEach(table => {
                                const rows = table.querySelectorAll('tr');
                                rows.forEach(row => {
                                    const cells = row.querySelectorAll('td, th');
                                    const quantities = [];
                                    
                                    cells.forEach(cell => {
                                        const text = cell.textContent.trim();
                                        if (text.match(/^\d+\+?$/) || text === '0') {
                                            quantities.push(text);
                                        }
                                    });
                                    
                                    if (quantities.length > 3) { // Reasonable threshold
                                        quantityMatrix.push(quantities);
                                    }
                                });
                            });
                        }
                        
                        // Method 3: Position-based extraction (from your extension)
                        if (quantityMatrix.length === 0) {
                            const potentialQuantityElements = document.querySelectorAll('span, div, td');
                            const quantityPattern = /^(\d+\+?|0\+?)$/;
                            const foundQuantities = [];
                            
                            potentialQuantityElements.forEach(el => {
                                const text = el.textContent.trim();
                                if (quantityPattern.test(text)) {
                                    const rect = el.getBoundingClientRect();
                                    foundQuantities.push({
                                        text,
                                        x: rect.left,
                                        y: rect.top
                                    });
                                }
                            });
                            
                            // Group by Y coordinate (rows)
                            foundQuantities.sort((a, b) => a.y - b.y);
                            
                            let currentRow = [];
                            let lastY = -1;
                            const tolerance = 10;
                            
                            foundQuantities.forEach(q => {
                                if (lastY === -1 || Math.abs(q.y - lastY) < tolerance) {
                                    currentRow.push(q.text);
                                    lastY = q.y;
                                } else {
                                    if (currentRow.length > 3) {
                                        quantityMatrix.push([...currentRow]);
                                    }
                                    currentRow = [q.text];
                                    lastY = q.y;
                                }
                            });
                            
                            if (currentRow.length > 3) {
                                quantityMatrix.push(currentRow);
                            }
                        }
                        
                        return quantityMatrix;
                    }
                    
                    fallbackExtraction(productInfo) {
                        // If structured extraction fails, try to extract whatever we can
                        console.log('🔄 Using fallback extraction method');
                        
                        const inventory = [];
                        const urlParams = new URLSearchParams(window.location.search);
                        const colorCode = urlParams.get('colorCode') || '000';
                        
                        // Look for any quantity information on the page
                        const quantityElements = document.querySelectorAll('*');
                        const quantities = [];
                        
                        quantityElements.forEach(el => {
                            const text = el.textContent.trim();
                            if (text.match(/^\d+$/) && parseInt(text) >= 0 && parseInt(text) <= 999) {
                                quantities.push(text);
                            }
                        });
                        
                        // Create at least one record with available information
                        inventory.push({
                            productName: productInfo.productName,
                            styleId: productInfo.styleId,
                            colorCode: colorCode,
                            colorName: 'Color ' + colorCode,
                            sizeUS: 'Various',
                            quantity: quantities.length > 0 ? parseInt(quantities[0]) : 0,
                            rawQuantity: quantities.length > 0 ? quantities[0] : '0',
                            extractedAt: new Date().toISOString(),
                            url: window.location.href
                        });
                        
                        return inventory;
                    }

                    parseQuantity(quantityText) {
                        if (!quantityText || quantityText === '-' || quantityText === '') return 0;
                        if (quantityText.includes('+')) {
                            const num = parseInt(quantityText.replace('+', ''));
                            return isNaN(num) ? 0 : num;
                        }
                        const num = parseInt(quantityText);
                        return isNaN(num) ? 0 : num;
                    }
                }

                const extractor = new ASICSInventoryExtractor();
                return extractor.extractInventoryData();
            });

            console.log(`✅ ${url}: ${inventory.length} records extracted`);
            
            return {
                url,
                success: true,
                inventory,
                recordCount: inventory.length,
                timestamp: new Date().toISOString(),
                batchId
            };

        } catch (error) {
            console.error(`❌ Error scraping ${url}:`, error.message);
            return {
                url,
                success: false,
                error: error.message,
                timestamp: new Date().toISOString(),
                batchId
            };
        } finally {
            await page.close();
        }
    }

    async scrapeSinglePage(url) {
        let browser;
        try {
            browser = await this.getAuthenticatedBrowser(); // Use new method
            const result = await this.scrapeAuthenticatedPage(browser, url, 'test_' + Date.now());
            return result;
        } catch (error) {
            console.error('Single page scrape error:', error);
            return {
                url,
                success: false,
                error: error.message
            };
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }

    async processResults(results, batchId) {
        const allInventory = [];
        const successCount = results.filter(r => r.success).length;
        const errorCount = results.filter(r => !r.success).length;
        
        results.forEach(result => {
            if (result.success && result.inventory) {
                allInventory.push(...result.inventory.map(item => ({
                    ...item,
                    sourceUrl: result.url,
                    scrapedAt: result.timestamp,
                    batchId: batchId
                })));
            }
        });

        console.log(`📊 Processing batch ${batchId} results: ${allInventory.length} total records`);

        if (allInventory.length > 0) {
            await this.saveInventoryToDatabase(allInventory);
        }

        const duration = Math.round((Date.now() - this.scrapingProgress.startTime) / 1000);
        await this.logScrapeResults(batchId, results.length, successCount, errorCount, allInventory.length, duration);
    }

    async saveInventoryToDatabase(inventory) {
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            for (let item of inventory) {
                await client.query(`
                    INSERT INTO current_inventory 
                    (product_name, style_id, color_code, color_name, size_us, quantity, raw_quantity, source_url, scraped_at, batch_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (style_id, color_code, size_us) 
                    DO UPDATE SET 
                        quantity = EXCLUDED.quantity,
                        scraped_at = EXCLUDED.scraped_at,
                        batch_id = EXCLUDED.batch_id
                `, [
                    item.productName, item.styleId, item.colorCode, 
                    item.colorName, item.sizeUS, item.quantity,
                    item.rawQuantity, item.sourceUrl, item.scrapedAt, item.batchId
                ]);
            }
            
            await client.query('COMMIT');
            console.log('✅ Inventory saved to database');
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Database save error:', error);
        } finally {
            client.release();
        }
    }

    async logScrapeResults(batchId, totalPages, successCount, errorCount, recordCount, duration) {
        try {
            await this.db.query(`
                INSERT INTO scrape_logs (batch_id, total_pages, success_count, error_count, record_count, duration_seconds)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [batchId, totalPages, successCount, errorCount, recordCount, duration]);
        } catch (error) {
            console.error('Error logging results:', error);
        }
    }

    async savePageList() {
        const client = await this.db.connect();
        try {
            await client.query('DELETE FROM monitored_pages');
            for (let url of this.pageList) {
                await client.query(
                    'INSERT INTO monitored_pages (url, active) VALUES ($1, true) ON CONFLICT (url) DO UPDATE SET active = true',
                    [url]
                );
            }
        } catch (error) {
            console.error('Error saving page list:', error);
        } finally {
            client.release();
        }
    }

    calculateTimeRemaining() {
        if (!this.isRunning || this.scrapingProgress.total === 0) return null;
        
        const remaining = this.scrapingProgress.total - this.scrapingProgress.completed;
        const avgTimePerUrl = 15;
        const avgTimePerBatch = this.config.batchDelay / 1000;
        const remainingBatches = Math.ceil(remaining / this.config.batchSize);
        
        const totalSeconds = (remaining * avgTimePerUrl) + (remainingBatches * avgTimePerBatch);
        return Math.round(totalSeconds / 60);
    }
    
    getNextScrapeTime() {
        const now = new Date();
        const nextSunday = new Date();
        const daysUntilSunday = (7 - now.getDay()) % 7;
        
        if (daysUntilSunday === 0 && now.getHours() < 2) {
            nextSunday.setHours(2, 0, 0, 0);
        } else {
            nextSunday.setDate(now.getDate() + (daysUntilSunday || 7));
            nextSunday.setHours(2, 0, 0, 0);
        }
        
        return nextSunday.toISOString();
    }

    getMemoryUsage() {
        const usage = process.memoryUsage();
        return {
            heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
            heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + 'MB',
            rss: Math.round(usage.rss / 1024 / 1024) + 'MB'
        };
    }

    getDashboardHTML() {
        return `<!DOCTYPE html>
<html>
<head>
    <title>ASICS Weekly Batch Scraper</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, sans-serif; 
            margin: 0; padding: 20px; background: #f5f7fa; 
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { 
            background: linear-gradient(135deg, #667eea, #764ba2); 
            color: white; padding: 30px; border-radius: 10px; 
            margin-bottom: 30px; text-align: center;
        }
        .header h1 { margin: 0; font-size: 2.5em; }
        .cards { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); 
            gap: 20px; 
        }
        .card { 
            background: white; padding: 25px; border-radius: 8px; 
            box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
        }
        .btn { 
            background: #667eea; color: white; border: none; 
            padding: 12px 24px; border-radius: 6px; cursor: pointer; 
            margin: 5px 5px 5px 0; font-size: 14px;
        }
        .btn:hover { background: #5a67d8; }
        .btn:disabled { background: #ccc; cursor: not-allowed; }
        .btn-success { background: #48bb78; }
        .btn-success:hover { background: #38a169; }
        .btn-danger { background: #f56565; }
        .btn-danger:hover { background: #e53e3e; }
        .btn-warning { background: #ed8936; }
        .btn-warning:hover { background: #dd7324; }
        textarea {
            width: 100%; height: 120px; margin: 10px 0;
            padding: 10px; border: 1px solid #ddd; border-radius: 4px;
            font-family: monospace; font-size: 12px;
        }
        input[type="text"] {
            width: 100%; padding: 10px; margin: 10px 0;
            border: 1px solid #ddd; border-radius: 4px;
        }
        .input-group {
            display: flex; gap: 10px; margin: 10px 0;
        }
        .input-group input {
            flex: 1;
        }
        .status { 
            padding: 12px; margin: 10px 0; border-radius: 4px; 
            font-weight: 500;
        }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .warning { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
        .info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
        .progress-bar {
            background: #e2e8f0;
            border-radius: 10px;
            height: 20px;
            overflow: hidden;
            margin: 10px 0;
        }
        .progress-fill {
            background: linear-gradient(90deg, #48bb78, #38a169);
            height: 100%;
            transition: width 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 12px;
            font-weight: bold;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
            gap: 15px;
            margin: 15px 0;
        }
        .stat {
            text-align: center;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 6px;
            border: 1px solid #e9ecef;
        }
        .stat-number {
            font-size: 1.5em;
            font-weight: bold;
            color: #495057;
            margin: 0;
        }
        .stat-label {
            color: #6c757d;
            font-size: 0.8em;
            text-transform: uppercase;
        }
        @media (max-width: 768px) {
            .cards { grid-template-columns: 1fr; }
            .input-group { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📅 ASICS Weekly Batch Scraper</h1>
            <p>Optimized for Render Starter Tier - Weekly Automation</p>
        </div>
        
        <div class="cards">
            <div class="card">
                <h3>🎛️ Batch Controls</h3>
                <button class="btn" id="startBtn" onclick="startBatch()">🚀 Start Weekly Batch</button>
                <button class="btn btn-warning" onclick="stopBatch()">⏹️ Stop Batch</button>
                <button class="btn" onclick="refreshStatus()">🔄 Refresh Status</button>
                <div id="status"></div>
                
                <div id="progress-section" style="display: none;">
                    <h4>📊 Progress</h4>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progressFill" style="width: 0%;">0%</div>
                    </div>
                    <div id="progress-details"></div>
                </div>
            </div>
            
            <div class="card">
                <h3>📈 Statistics</h3>
                <div class="stats" id="stats">
                    <div class="stat">
                        <div class="stat-number" id="totalUrls">0</div>
                        <div class="stat-label">Total URLs</div>
                    </div>
                    <div class="stat">
                        <div class="stat-number" id="completedUrls">0</div>
                        <div class="stat-label">Completed</div>
                    </div>
                    <div class="stat">
                        <div class="stat-number" id="errorUrls">0</div>
                        <div class="stat-label">Errors</div>
                    </div>
                </div>
                <div id="schedule-info">
                    <p><strong>Next Scrape:</strong> <span id="nextScrape">Loading...</span></p>
                    <p><strong>Last Scrape:</strong> <span id="lastScrape">Never</span></p>
                </div>
            </div>
            
            <div class="card">
                <h3>📥 Bulk URL Upload</h3>
                <p>Paste your ASICS B2B product URLs (one per line):</p>
                <textarea id="bulkUrls" placeholder="https://b2b.asics.com/orders/100452449/products/1013A142?colorCode=300&deliveryDate=2025-06-14
https://b2b.asics.com/orders/100452449/products/1013A160?colorCode=100&deliveryDate=2025-06-14
https://b2b.asics.com/products/1013A161
...

Tip: You can paste both order URLs and product URLs!"></textarea>
                <button class="btn btn-success" onclick="uploadBulkUrls()">📤 Upload URLs</button>
                <button class="btn btn-danger" onclick="clearUrls()">🗑️ Clear All URLs</button>
                <div id="upload-status"></div>
            </div>
            
            <div class="card">
                <h3>🧪 Test & Quick Add</h3>
                <p>Test individual URLs before adding to batch:</p>
                <div class="input-group">
                    <input type="text" id="testUrl" placeholder="https://b2b.asics.com/orders/100452449/products/1013A142?colorCode=300">
                    <button class="btn" onclick="addSingleUrl()">➕ Add</button>
                </div>
                <button class="btn btn-warning" onclick="testScrape()">🧪 Test Scrape</button>
                <div id="test-status"></div>
            </div>
            
            
            <div class="card">
                <h3>📊 Data & Export</h3>
                <button class="btn btn-success" onclick="exportCSV()">📥 Download CSV</button>
                <button class="btn" onclick="viewInventory()">👁️ View Inventory</button>
                <button class="btn" onclick="viewLogs()">📜 View Logs</button>
                <button class="btn" onclick="checkMemory()">💾 Memory Usage</button>
                <p style="margin-top: 15px; color: #666; font-size: 0.9em;">
                    💡 The system processes URLs in batches of 5 to optimize memory usage on the starter tier.
                </p>
            </div>
        </div>
    </div>
    
    <script>
        let refreshInterval = null;
        
        // Main status refresh function
        async function refreshStatus() {
            try {
                const [statusRes, progressRes] = await Promise.all([
                    fetch('/api/status'),
                    fetch('/api/batch-status')
                ]);
                
                const status = await statusRes.json();
                const progress = await progressRes.json();
                
                updateStatus(status);
                updateProgress(progress);
                updateStats(status, progress);
                updateSchedule(status);
                
            } catch (error) {
                console.error('Status refresh error:', error);
                showStatus('❌ Error refreshing status: ' + error.message, 'error');
            }
        }
        
        function updateStatus(status) {
            const statusDiv = document.getElementById('status');
            if (status.isRunning) {
                statusDiv.innerHTML = '<div class="info">🔄 <strong>Weekly batch running...</strong></div>';
                document.getElementById('startBtn').disabled = true;
                document.getElementById('startBtn').textContent = '⏳ Running...';
                
                // Start auto-refresh
                if (!refreshInterval) {
                    refreshInterval = setInterval(refreshStatus, 5000);
                }
            } else {
                statusDiv.innerHTML = '<div class="success">✅ <strong>System ready</strong> - ' + status.totalUrls + ' URLs loaded</div>';
                document.getElementById('startBtn').disabled = false;
                document.getElementById('startBtn').textContent = '🚀 Start Weekly Batch';
                
                // Stop auto-refresh
                if (refreshInterval) {
                    clearInterval(refreshInterval);
                    refreshInterval = null;
                }
            }
        }
        
        function updateProgress(progress) {
            const progressSection = document.getElementById('progress-section');
            const progressFill = document.getElementById('progressFill');
            const progressDetails = document.getElementById('progress-details');
            
            if (progress.status === 'Running Weekly Batch') {
                progressSection.style.display = 'block';
                progressFill.style.width = progress.percentage + '%';
                progressFill.textContent = progress.percentage + '%';
                
                progressDetails.innerHTML = \`
                    <strong>Current:</strong> \${progress.currentUrl ? progress.currentUrl.split('/').pop() : 'Preparing...'}<br>
                    <strong>Progress:</strong> \${progress.completed}/\${progress.total} URLs<br>
                    <strong>Batch:</strong> \${progress.currentBatch}/\${progress.totalBatches}<br>
                    <strong>Time Left:</strong> \${progress.estimatedMinutesRemaining || '--'} minutes
                \`;
            } else {
                progressSection.style.display = 'none';
            }
        }
        
        function updateStats(status, progress) {
            document.getElementById('totalUrls').textContent = status.totalUrls || 0;
            document.getElementById('completedUrls').textContent = progress.completed || 0;
            document.getElementById('errorUrls').textContent = progress.errors || 0;
        }
        
        function updateSchedule(status) {
            document.getElementById('nextScrape').textContent = 
                status.nextScrape ? new Date(status.nextScrape).toLocaleString() : 'Unknown';
            document.getElementById('lastScrape').textContent = 
                status.lastScrape ? new Date(status.lastScrape).toLocaleString() : 'Never';
        }
        
        // Batch control functions
        async function startBatch() {
            try {
                const response = await fetch('/api/start-batch', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    showStatus('✅ ' + result.message, 'success');
                    setTimeout(refreshStatus, 2000);
                } else {
                    showStatus('❌ ' + result.message, 'error');
                }
            } catch (error) {
                showStatus('❌ Error starting batch: ' + error.message, 'error');
            }
        }
        
        async function stopBatch() {
            if (!confirm('Stop the current batch? It will complete the current mini-batch first.')) {
                return;
            }
            
            try {
                const response = await fetch('/api/stop-batch', { method: 'POST' });
                const result = await response.json();
                showStatus(result.success ? '⏹️ ' + result.message : '❌ ' + result.message, 
                          result.success ? 'warning' : 'error');
            } catch (error) {
                showStatus('❌ Error stopping batch: ' + error.message, 'error');
            }
        }
        
        // URL management functions
        async function uploadBulkUrls() {
            const textarea = document.getElementById('bulkUrls');
            const urls = textarea.value.split('\\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            if (urls.length === 0) {
                showUploadStatus('⚠️ Please paste some URLs first', 'warning');
                return;
            }
            
            showUploadStatus('📤 Processing URLs...', 'info');
            
            try {
                const response = await fetch('/api/bulk-add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showUploadStatus(\`✅ \${result.message}\`, 'success');
                    textarea.value = '';
                    refreshStatus();
                } else {
                    showUploadStatus('❌ ' + result.message, 'error');
                }
            } catch (error) {
                showUploadStatus('❌ Upload failed: ' + error.message, 'error');
            }
        }
        
        async function addSingleUrl() {
            const input = document.getElementById('testUrl');
            const url = input.value.trim();
            
            if (!url) {
                showTestStatus('⚠️ Please enter a URL', 'warning');
                return;
            }
            
            try {
                const response = await fetch('/api/pages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showTestStatus('✅ ' + result.message, 'success');
                    input.value = '';
                    refreshStatus();
                } else {
                    showTestStatus('❌ ' + result.message, 'error');
                }
            } catch (error) {
                showTestStatus('❌ Error adding URL: ' + error.message, 'error');
            }
        }
        
        async function testScrape() {
            const input = document.getElementById('testUrl');
            const url = input.value.trim();
            
            if (!url || (!url.includes('b2b.asics.com/products/') && !url.includes('b2b.asics.com/orders/'))) {
                showTestStatus('⚠️ Please enter a valid ASICS B2B URL (products or orders page)', 'warning');
                return;
            }
            
            showTestStatus('🧪 Testing scrape... this may take 30-60 seconds', 'info');
            
            try {
                const response = await fetch('/api/test-scrape', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showTestStatus('✅ ' + result.message, 'success');
                    refreshStatus();
                } else {
                    showTestStatus('❌ ' + result.message, 'error');
                }
            } catch (error) {
                showTestStatus('❌ Test failed: ' + error.message, 'error');
            }
        }
        
        async function clearUrls() {
            if (!confirm('⚠️ Clear ALL URLs? This cannot be undone!')) {
                return;
            }
            
            try {
                const response = await fetch('/api/clear-all-pages', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    showUploadStatus('🗑️ All URLs cleared', 'success');
                    refreshStatus();
                } else {
                    showUploadStatus('❌ Error: ' + result.message, 'error');
                }
            } catch (error) {
                showUploadStatus('❌ Error clearing URLs: ' + error.message, 'error');
            }
        }
        
        // Authentication test function
        async function testAuth() {
            const statusDiv = document.getElementById('auth-test-status');
            const indicator = document.getElementById('auth-indicator');
            
            statusDiv.innerHTML = '<div class="info">🔐 Testing ASICS B2B authentication...</div>';
            indicator.textContent = 'Testing...';
            
            try {
                const response = await fetch('/api/test-auth', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    statusDiv.innerHTML = '<div class="success">✅ Authentication successful!</div>';
                    indicator.textContent = '✅ Connected';
                } else {
                    statusDiv.innerHTML = \`<div class="error">❌ Authentication failed: \${result.error}</div>\`;
                    indicator.textContent = '❌ Failed';
                }
            } catch (error) {
                statusDiv.innerHTML = \`<div class="error">❌ Test failed: \${error.message}</div>\`;
                indicator.textContent = '❌ Error';
            }
            
            setTimeout(() => {
                statusDiv.innerHTML = '';
            }, 10000);
        }
        function exportCSV() {
            window.open('/api/export/csv', '_blank');
            showStatus('📥 CSV export started', 'info');
        }
        
        function viewInventory() {
            window.open('/api/inventory', '_blank');
        }
        
        function viewLogs() {
            window.open('/api/logs', '_blank');
        }
        
        async function checkMemory() {
            try {
                const response = await fetch('/api/memory');
                const memory = await response.json();
                showStatus(\`💾 Memory: \${memory.heapUsed} heap, \${memory.rss} RSS\`, 'info');
            } catch (error) {
                showStatus('❌ Error checking memory', 'error');
            }
        }
        
        // Status display helpers
        function showStatus(message, type) {
            const statusDiv = document.getElementById('status');
            statusDiv.innerHTML = \`<div class="\${type}">\${message}</div>\`;
            setTimeout(() => {
                refreshStatus(); // Refresh to show current status
            }, 3000);
        }
        
        function showUploadStatus(message, type) {
            const statusDiv = document.getElementById('upload-status');
            statusDiv.innerHTML = \`<div class="\${type}">\${message}</div>\`;
            setTimeout(() => {
                statusDiv.innerHTML = '';
            }, 5000);
        }
        
        function showTestStatus(message, type) {
            const statusDiv = document.getElementById('test-status');
            statusDiv.innerHTML = \`<div class="\${type}">\${message}</div>\`;
            setTimeout(() => {
                statusDiv.innerHTML = '';
            }, 5000);
        }
        
        // Keyboard shortcuts
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey || e.metaKey) {
                switch(e.key) {
                    case 'r':
                        e.preventDefault();
                        refreshStatus();
                        break;
                    case 's':
                        e.preventDefault();
                        if (!document.getElementById('startBtn').disabled) {
                            startBatch();
                        }
                        break;
                }
            }
        });
        
        // Enter key support
        document.getElementById('testUrl').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                addSingleUrl();
            }
        });
        
        // Initial load
        console.log('🚀 ASICS Weekly Batch Scraper Dashboard Loaded');
        refreshStatus();
        
        // Welcome message
        setTimeout(() => {
            showStatus('🎉 Dashboard ready! Add your URLs and start batching.', 'success');
        }, 1000);
    </script>
</body>
</html>`;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    start() {
        const port = process.env.PORT || 3000;
        this.app.listen(port, '0.0.0.0', () => {
            console.log(`🚀 ASICS Weekly Batch Scraper running on port ${port}`);
            console.log(`📊 Dashboard available`);
            console.log(`💾 Memory usage: ${JSON.stringify(this.getMemoryUsage())}`);
        });
    }
}

// Start the scraper
const scraper = new ASICSWeeklyBatchScraper();
scraper.start();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down gracefully...');
    process.exit(0);
});
