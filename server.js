// server.js - ASICS Weekly Batch Scraper - Optimized for Render Starter Tier
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
        
        // Configuration for starter tier
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
            max: 3, // Limit connections for starter tier
            connectionTimeoutMillis: 30000,
            idleTimeoutMillis: 30000
        });
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json({ limit: '10mb' })); // For bulk URL uploads
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
            
            // Start batch in background
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
            
            if (!url || !url.includes('b2b.asics.com/products/')) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please provide a valid ASICS B2B product URL' 
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
                url && typeof url === 'string' && url.includes('b2b.asics.com/products/')
            );
            
            const newUrls = validUrls.filter(url => !this.pageList.includes(url));
            
            this.pageList.push(...newUrls);
            await this.savePageList();
            
            res.json({
                success: true,
                message: `Added ${newUrls.length} new URLs (${validUrls.length - newUrls.length} duplicates, ${urls.length - validUrls.length} invalid)`,
                total: this.pageList.length,
                added: newUrls.length,
                duplicates: validUrls.length - newUrls.length,
                invalid: urls.length - validUrls.length
            });
        });

        this.app.post('/api/bulk-upload', async (req, res) => {
            const { content, format } = req.body;
            
            let urls = [];
            
            try {
                if (format === 'csv') {
                    urls = content.split('\n')
                        .map(line => line.split(',')[0]?.trim())
                        .filter(url => url && url.includes('b2b.asics.com/products/'));
                } else {
                    // Plain text, one URL per line
                    urls = content.split('\n')
                        .map(line => line.trim())
                        .filter(url => url && url.includes('b2b.asics.com/products/'));
                }
                
                const newUrls = urls.filter(url => !this.pageList.includes(url));
                this.pageList.push(...newUrls);
                await this.savePageList();
                
                res.json({
                    success: true,
                    message: `Processed ${urls.length} URLs, added ${newUrls.length} new ones`,
                    total: this.pageList.length
                });
                
            } catch (error) {
                res.status(500).json({
                    success: false,
                    message: 'Error processing URLs: ' + error.message
                });
            }
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

        this.app.get('/api/inventory/:styleId', async (req, res) => {
            try {
                const { styleId } = req.params;
                const result = await this.db.query(`
                    SELECT * FROM current_inventory 
                    WHERE style_id = $1 
                    ORDER BY color_code, size_us
                `, [styleId]);
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

        // Logs and monitoring
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

        // Test endpoints
        this.app.post('/api/test-scrape', async (req, res) => {
            const { url } = req.body;
            
            if (!url || !url.includes('b2b.asics.com/products/')) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please provide a valid ASICS B2B product URL' 
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
                    created_at TIMESTAMP DEFAULT NOW(),
                    last_scraped TIMESTAMP,
                    scrape_count INTEGER DEFAULT 0
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
                    memory_used_mb INTEGER,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // Add indexes for better performance
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_inventory_style ON current_inventory(style_id);
                CREATE INDEX IF NOT EXISTS idx_inventory_scraped ON current_inventory(scraped_at);
                CREATE INDEX IF NOT EXISTS idx_logs_created ON scrape_logs(created_at);
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
        
        // Run every Sunday at 2 AM
        cron.schedule('0 2 * * 0', () => {
            if (!this.isRunning && this.pageList.length > 0) {
                console.log('📅 Scheduled weekly batch triggered');
                this.startWeeklyBatch();
            }
        });
        
        // Optional manual trigger for testing (disabled in production)
        if (process.env.NODE_ENV !== 'production') {
            setTimeout(() => {
                if (this.pageList.length > 0) {
                    console.log('🧪 Test batch starting in 2 minutes (dev mode)...');
                    // Uncomment to test immediately:
                    // setTimeout(() => this.startWeeklyBatch(), 120000);
                }
            }, 5000);
        }
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
        console.log(`📊 Memory before batch: ${JSON.stringify(this.getMemoryUsage())}`);
        
        this.totalBatches = Math.ceil(this.pageList.length / this.config.batchSize);
        let allResults = [];
        
        try {
            for (let i = 0; i < this.pageList.length && this.isRunning; i += this.config.batchSize) {
                this.currentBatch = Math.floor(i / this.config.batchSize) + 1;
                const batch = this.pageList.slice(i, i + this.config.batchSize);
                
                console.log(`📦 Mini-batch ${this.currentBatch}/${this.totalBatches}: ${batch.length} URLs`);
                console.log(`💾 Memory before mini-batch: ${this.getMemoryUsage().heapUsed}`);
                
                // Process this mini-batch
                const batchResults = await this.processBatch(batch, batchId);
                allResults.push(...batchResults);
                
                // Update progress
                this.scrapingProgress.completed = Math.min(i + this.config.batchSize, this.pageList.length);
                
                // Force garbage collection after each batch
                if (global.gc) {
                    global.gc();
                }
                
                console.log(`💾 Memory after mini-batch: ${this.getMemoryUsage().heapUsed}`);
                
                // Rest between batches (except the last one)
                if (i + this.config.batchSize < this.pageList.length && this.isRunning) {
                    console.log(`⏸️ Resting ${this.config.batchDelay/1000}s before next mini-batch...`);
                    await this.delay(this.config.batchDelay);
                }
            }
            
        } catch (error) {
            console.error('❌ Batch processing error:', error);
        }
        
        // Process all results
        await this.processResults(allResults, batchId);
        
        this.isRunning = false;
        this.lastScrapeTime = new Date().toISOString();
        this.scrapingProgress.currentUrl = null;
        
        const duration = Math.round((Date.now() - this.scrapingProgress.startTime) / 1000);
        console.log(`✅ Weekly batch ${batchId} completed in ${duration} seconds`);
        console.log(`📊 Final results: ${allResults.length} total, ${allResults.filter(r => r.success).length} successful`);
    }

    async processBatch(urls, batchId) {
        let browser;
        const results = [];
        
        try {
            // Launch fresh browser for each mini-batch
            browser = await this.getBrowser();
            
            for (let i = 0; i < urls.length && this.isRunning; i++) {
                const url = urls[i];
                this.scrapingProgress.currentUrl = url;
                
                console.log(`🔍 Scraping ${this.scrapingProgress.completed + i + 1}/${this.scrapingProgress.total}: ${url}`);
                
                let attempts = 0;
                let result = null;
                
                // Retry logic
                while (attempts < this.config.maxRetries && !result) {
                    attempts++;
                    try {
                        result = await this.scrapePage(browser, url, batchId);
                        
                        if (!result.success && attempts < this.config.maxRetries) {
                            console.log(`⚠️ Attempt ${attempts} failed for ${url}, retrying...`);
                            await this.delay(5000); // Wait before retry
                            result = null;
                        }
                        
                    } catch (error) {
                        console.error(`❌ Attempt ${attempts} error for ${url}:`, error.message);
                        if (attempts >= this.config.maxRetries) {
                            result = {
                                url: url,
                                success: false,
                                error: error.message,
                                timestamp: new Date().toISOString(),
                                batchId: batchId,
                                attempts: attempts
                            };
                        }
                    }
                }
                
                results.push(result);
                
                if (!result.success) {
                    this.scrapingProgress.errors++;
                }
                
                // Delay between pages within the batch
                if (i < urls.length - 1 && this.isRunning) {
                    await this.delay(this.config.pageDelay);
                }
            }
            
        } catch (error) {
            console.error('❌ Batch browser error:', error);
        } finally {
            // ALWAYS close browser after each mini-batch
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError) {
                    console.error('❌ Error closing browser:', closeError.message);
                }
                browser = null;
            }
            
            // Force garbage collection
            if (global.gc) {
                global.gc();
            }
        }
        
        return results;
    }

    async getBrowser() {
        console.log('🚀 Launching ultra-lightweight browser...');
        
        const browser = await puppeteer.launch({
            executablePath: await chromium.executablePath(),
            args: [
                ...chromium.args,
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--memory-pressure-off',
                '--max-old-space-size=128',
                '--single-process',
                '--no-zygote',
                '--disable-web-security',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection'
            ],
            headless: chromium.headless,
            defaultViewport: { width: 1024, height: 768 }
        });
        
        console.log('✅ Browser launched successfully');
        return browser;
    }

    async scrapePage(browser, url, batchId) {
        const page = await browser.newPage();
        
        try {
            console.log(`🔍 Scraping: ${url}`);
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            await page.goto(url, { 
                waitUntil: 'networkidle0', 
                timeout: 60000 
            });

            // Wait for the grid to load
            await page.waitForSelector('.grid', { timeout: 20000 });
            
            // Additional wait for dynamic content
            await this.delay(5000);

            // Extract inventory using the proven logic
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
                            console.warn('⚠️ Missing colors or sizes data');
                            return [];
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
                        const productName = document.querySelector('h1')?.textContent?.trim() || 'Unknown Product';
                        const styleId = window.location.pathname.split('/').pop()?.split('?')[0] || 'Unknown';
                        return { productName, styleId };
                    }

                    findColors() {
                        const colors = [];
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
                        
                        // Fallback method
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
                        const sizeElements = document.querySelectorAll('.bg-primary.text-white');
                        
                        sizeElements.forEach(el => {
                            const sizeText = el.textContent.trim();
                            if (sizeText.match(/^\d+\.?\d*$/)) {
                                sizes.push(sizeText);
                            }
                        });
                        
                        return sizes.length > 0 ? sizes : 
                            ['6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10', '10.5', '11', '11.5', '12', '12.5', '13', '14', '15'];
                    }

                    findQuantityMatrix() {
                        const quantityMatrix = [];
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
                        
                        // Alternative approach if no matrix found
                        if (quantityMatrix.length === 0) {
                            const potentialQuantityElements = document.querySelectorAll('span, div');
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
                                    if (currentRow.length > 5) {
                                        quantityMatrix.push([...currentRow]);
                                    }
                                    currentRow = [q.text];
                                    lastY = q.y;
                                }
                            });
                            
                            if (currentRow.length > 5) {
                                quantityMatrix.push(currentRow);
                            }
                        }
                        
                        return quantityMatrix;
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
            browser = await this.getBrowser();
            const result = await this.scrapePage(browser, url, 'test_' + Date.now());
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
        console.log(`✅ Successful pages: ${successCount}`);
        console.log(`❌ Failed pages: ${errorCount}`);

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
            
            console.log('📤 Saving inventory to database...');
            
            for (let item of inventory) {
                await client.query(`
                    INSERT INTO current_inventory 
                    (product_name, style_id, color_code, color_name, size_us, quantity, raw_quantity, source_url, scraped_at, batch_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (style_id, color_code, size_us) 
                    DO UPDATE SET 
                        quantity = EXCLUDED.quantity,
                        raw_quantity = EXCLUDED.raw_quantity,
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
            throw error;
        } finally {
            client.release();
        }
    }

    async logScrapeResults(batchId, totalPages, successCount, errorCount, recordCount, duration) {
        try {
            const memoryUsage = this.getMemoryUsage();
            await this.db.query(`
                INSERT INTO scrape_logs (batch_id, total_pages, success_count, error_count, record_count, duration_seconds, memory_used_mb)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [batchId, totalPages, successCount, errorCount, recordCount, duration, parseInt(memoryUsage.heapUsed.replace('MB', ''))]);
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
        const avgTimePerUrl = 15; // seconds (conservative estimate)
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
            external: Math.round(usage.external / 1024 / 1024) + 'MB',
            rss: Math.round(usage.rss / 1024 / 1024) + 'MB'
        };
    }

    getDashboardHTML() {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>ASICS Weekly Batch Scraper</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { box-sizing: border-box; }
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, sans-serif; 
                    margin: 0; padding: 20px; background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
                    line-height: 1.6; min-height: 100vh;
                }
                .container { max-width: 1400px; margin: 0 auto; }
                .header { 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                    color: white; padding: 40px; border-radius: 15px; 
                    margin-bottom: 30px; text-align: center;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                }
                .header h1 { margin: 0; font-size: 2.8em; font-weight: 700; }
                .header p { margin: 15px 0 0 0; opacity: 0.9; font-size: 1.1em; }
                .cards { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); 
                    gap: 25px; 
                    margin-bottom: 30px;
                }
                .card { 
                    background: white; padding: 30px; border-radius: 12px; 
                    box-shadow: 0 5px 20px rgba(0,0,0,0.1); 
                    transition: transform 0.2s, box-shadow 0.2s;
                    border: 1px solid rgba(255,255,255,0.8);
                }
                .card:hover { 
                    transform: translateY(-2px); 
                    box-shadow: 0 8px 25px rgba(0,0,0,0.15); 
                }
                .card h3 { 
                    margin: 0 0 25px 0; color: #2d3748; font-size: 1.4em; 
                    font-weight: 600; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;
                }
                .btn { 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                    color: white; border: none; 
                    padding: 14px 28px; border-radius: 8px; cursor: pointer; 
                    margin: 8px 8px 8px 0; font-size: 14px; font-weight: 600;
                    transition: all 0.3s; text-transform: uppercase; letter-spacing: 0.5px;
                }
                .btn:hover { 
                    transform: translateY(-2px); 
                    box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
                }
                .btn:disabled { 
                    background: #cbd5e0; cursor: not-allowed; transform: none; 
                    box-shadow: none;
                }
                .btn-success { background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); }
                .btn-success:hover { box-shadow: 0 5px 15px rgba(72, 187, 120, 0.4); }
                .btn-danger { background: linear-gradient(135deg, #f56565 0%, #e53e3e 100%); }
                .btn-danger:hover { box-shadow: 0 5px 15px rgba(245, 101, 101, 0.4); }
                .btn-warning { background: linear-gradient(135deg, #ed8936 0%, #dd7324 100%); }
                .btn-warning:hover { box-shadow: 0 5px 15px rgba(237, 137, 54, 0.4); }
                
                .progress-container {
                    background: #f7fafc;
                    border-radius: 12px;
                    padding: 20px;
                    margin: 20px 0;
                }
                .progress-bar {
                    background: #e2e8f0;
                    border-radius: 12px;
                    height: 24px;
                    overflow: hidden;
                    margin: 15px 0;
                    box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
                }
                .progress-fill {
                    background: linear-gradient(90deg, #48bb78 0%, #38a169 50%, #2f855a 100%);
                    height: 100%;
                    transition: width 0.5s ease;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    font-size: 13px;
                    font-weight: bold;
                    text-shadow: 0 1px 2px rgba(0,0,0,0.2);
                }
                
                .bulk-upload { 
                    border: 3px dashed #cbd5e0; 
                    border-radius: 12px; 
                    padding: 25px; 
                    text-align: center; 
                    background: linear-gradient(135deg, #f7fafc 0%, #edf2f7 100%);
                    transition: all 0.3s;
                }
                .bulk-upload:hover { 
                    border-color: #667eea; 
                    background: linear-gradient(135deg, #edf2f7 0%, #e2e8f0 100%);
                    transform: translateY(-1px);
                }
                .bulk-upload textarea {
                    width: 100%;
                    height: 140px;
                    border: 2px solid #e2e8f0;
                    border-radius: 8px;
                    padding: 15px;
                    font-family: 'Monaco', 'Menlo', monospace;
                    font-size: 12px;
                    resize: vertical;
                    transition: border-color 0.2s;
                }
                .bulk-upload textarea:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                }
                
                .stats-grid { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); 
                    gap: 20px; 
                    margin: 25px 0;
                }
                .stat-box { 
                    text-align: center; 
                    padding: 25px 15px; 
                    background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); 
                    border-radius: 10px; 
                    border: 1px solid #dee2e6;
                    transition: transform 0.2s;
                }
                .stat-box:hover {
                    transform: translateY(-2px);
                }
                .stat-number { 
                    font-size: 2.2em; 
                    font-weight: bold; 
                    color: #495057; 
                    margin: 0; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                .stat-label { 
                    color: #6c757d; 
                    font-size: 0.85em; 
                    text-transform: uppercase; 
                    letter-spacing: 1px; 
                    margin-top: 8px;
                    font-weight: 600;
                }
                
                .status-running { 
                    background: linear-gradient(135deg, #fff3cd 0%, #ffeaa7 100%); 
                    border: 1px solid #ffc107; color: #856404; 
                }
                .status-waiting { 
                    background: linear-gradient(135deg, #d1ecf1 0%, #bee5eb 100%); 
                    border: 1px solid #17a2b8; color: #0c5460; 
                }
                .status-complete { 
                    background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); 
                    border: 1px solid #28a745; color: #155724; 
                }
                .status-error { 
                    background: linear-gradient(135deg, #f8d7da 0%, #f5c6cb 100%); 
                    border: 1px solid #dc3545; color: #721c24; 
                }
                .status { 
                    padding: 18px; border-radius: 8px; margin: 20px 0; 
                    font-weight: 500; font-size: 14px;
                }
                
                .url-counter {
                    position: fixed;
                    top: 25px;
                    right: 25px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 12px 20px;
                    border-radius: 25px;
                    font-weight: bold;
                    box-shadow: 0 5px 20px rgba(102, 126, 234, 0.3);
                    z-index: 1000;
                    font-size: 14px;
                }
                
                .input-group {
                    display: flex;
                    gap: 12px;
                    margin: 20px 0;
                }
                .input-group input {
                    flex: 1;
                    padding: 14px;
                    border: 2px solid #e2e8f0;
                    border-radius: 8px;
                    font-size: 14px;
                    transition: border-color 0.2s;
                }
                .input-group input:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                }
                
                .schedule-info {
                    background: linear-gradient(135deg, #e6fffa 0%, #b2f5ea 100%);
                    padding: 20px;
                    border-radius: 10px;
                    border-left: 4px solid #38b2ac;
                }
                
                @media (max-width: 768px) {
                    .cards { grid-template-columns: 1fr; }
                    .url-counter { position: static; margin-bottom: 20px; text-align: center; }
                    .input-group { flex-direction: column; }
                    .header h1 { font-size: 2.2em; }
                    .header { padding: 25px; }
                }
                
                .animate-pulse {
                    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
                }
                
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: .5; }
                }
            </style>
        </head>
        <body>
            <div class="url-counter" id="urlCounter">
                📋 Loading URLs...
            </div>
            
            <div class="container">
                <div class="header">
                    <h1>📅 ASICS Weekly Batch Scraper</h1>
                    <p>Intelligent automation for hundreds of product URLs • Optimized for Render Starter Tier</p>
                </div>
                
                <div class="cards">
                    <div class="card">
                        <h3>🎛️ Batch Control Center</h3>
                        <button class="btn" id="startBatchBtn" onclick="startWeeklyBatch()">🚀 Start Weekly Batch</button>
                        <button class="btn btn-warning" onclick="stopBatch()">⏹️ Stop Batch</button>
                        <button class="btn" onclick="refreshStatus()">🔄 Refresh Status</button>
                        <div id="batch-status" class="status" style="display: none;"></div>
                    </div>
                    
                    <div class="card">
                        <h3>📊 Live Progress Monitor</h3>
                        <div class="progress-container">
                            <div class="progress-bar">
                                <div class="progress-fill" id="progressFill" style="width: 0%;">0%</div>
                            </div>
                            <div id="progress-details">Waiting for batch to start...</div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <h3>📈 Batch Statistics</h3>
                        <div id="batch-stats" class="stats-grid">
                            <div class="stat-box">
                                <div class="stat-number" id="totalUrls">0</div>
                                <div class="stat-label">Total URLs</div>
                            </div>
                            <div class="stat-box">
                                <div class="stat-number" id="completedUrls">0</div>
                                <div class="stat-label">Completed</div>
                            </div>
                            <div class="stat-box">
                                <div class="stat-number" id="errorUrls">0</div>
                                <div class="stat-label">Errors</div>
                            </div>
                            <div class="stat-box">
                                <div class="stat-number" id="timeRemaining">--</div>
                                <div class="stat-label">Min Left</div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="cards">
                    <div class="card">
                        <h3>📥 Bulk URL Management</h3>
                        <div class="bulk-upload">
                            <p><strong>📋 Paste your URLs here</strong> (one per line):</p>
                            <textarea id="bulkUrls" 
                                      placeholder="https://b2b.asics.com/products/1013A160
https://b2b.asics.com/products/1013A161
https://b2b.asics.com/products/1013A162
...

Tip: You can paste hundreds of URLs at once!"></textarea>
                            <br><br>
                            <button class="btn btn-success" onclick="uploadBulkUrls()">📤 Upload URLs</button>
                            <button class="btn btn-danger" onclick="clearUrls()">🗑️ Clear All URLs</button>
                        </div>
                        <div id="upload-status"></div>
                    </div>
                    
                    <div class="card">
                        <h3>➕ Quick Add Single URL</h3>
                        <p>Add individual URLs for testing:</p>
                        <div class="input-group">
                            <input type="text" id="singleUrl" 
                                   placeholder="https://b2b.asics.com/products/1013A160">
                            <button class="btn btn-success" onclick="addSingleUrl()">Add URL</button>
                        </div>
                        <button class="btn btn-warning" onclick="testScrape()">🧪 Test Scrape</button>
                        <div id="single-add-status"></div>
                    </div>
                </div>
                
                <div class="cards">
                    <div class="card">
                        <h3>🕐 Schedule Information</h3>
                        <div class="schedule-info">
                            <p><strong>📅 Next Scrape:</strong> <span id="nextScrape">Loading...</span></p>
                            <p><strong>⏰ Last Scrape:</strong> <span id="lastScrape">Never</span></p>
                            <p><strong>🔄 Schedule:</strong> Every Sunday at 2:00 AM</p>
                            <p><strong>⚡ Batch Size:</strong> 5 URLs per mini-batch</p>
                        </div>
                    </div>
                    
                    <div class="card">
                        <h3>📊 Data Export & Analysis</h3>
                        <button class="btn btn-success" onclick="exportCSV()">📥 Download CSV</button>
                        <button class="btn" onclick="viewInventory()">👁️ View Inventory</button>
                        <button class="btn" onclick="viewLogs()">📜 View Logs</button>
                        <button class="btn" onclick="checkMemory()">💾 Memory Usage</button>
                        <p style="margin-top: 20px; color: #666; font-size: 0.9em;">
                            💡 <strong>Pro tip:</strong> The system automatically handles memory management and 
                            processes your URLs in small batches to ensure reliability on the starter tier.
                        </p>
                    </div>
                </div>
            </div>
            
            <script>
                let refreshInterval;
                let isRefreshing = false;
                
                async function refreshStatus() {
                    if (isRefreshing) return;
                    isRefreshing = true;
                    
                    try {
                        const [progressRes, statusRes] = await Promise.all([
                            fetch('/api/progress'),
                            fetch('/api/batch-status')
                        ]);
                        
                        const progress = await progressRes.json();
                        const status = await statusRes.json();
                        
                        updateProgress(status);
                        updateScheduleInfo(progress);
                        updateUrlCount();
                        
                    } catch (error) {
                        console.error('Status refresh error:', error);
                    } finally {
                        isRefreshing = false;
                    }
                }
                
                function updateProgress(status) {
                    const progressFill = document.getElementById('progressFill');
                    const progressDetails = document.getElementById('progress-details');
                    const batchStatusDiv = document.getElementById('batch-status');
                    
                    // Update progress bar
                    progressFill.style.width = status.percentage + '%';
                    progressFill.textContent = status.percentage + '%';
                    
                    // Update details
                    if (status.status === 'Running Weekly Batch') {
                        progressDetails.innerHTML = \`
                            <div style="text-align: left; font-size: 13px; line-height: 1.6;">
                                <strong>🔍 Current URL:</strong> \${status.currentUrl ? status.currentUrl.split('/').pop() : 'Preparing...'}<br>
                                <strong>📊 Progress:</strong> \${status.completed}/\${status.total} URLs (\${status.percentage}%)<br>
                                <strong>🔥 Mini-batch:</strong> \${status.currentBatch}/\${status.totalBatches}<br>
                                <strong>❌ Errors:</strong> \${status.errors}<br>
                                <strong>⏱️ Est. Time:</strong> \${status.estimatedMinutesRemaining || '--'} minutes
                            </div>
                        \`;
                        
                        batchStatusDiv.style.display = 'block';
                        batchStatusDiv.className = 'status status-running';
                        batchStatusDiv.innerHTML = '🔄 <strong>Weekly batch in progress...</strong><br>Processing URLs in optimized mini-batches';
                        
                        // Auto-refresh while running
                        if (!refreshInterval) {
                            refreshInterval = setInterval(refreshStatus, 5000); // Every 5 seconds
                        }
                        
                        // Add pulse animation to progress bar
                        progressFill.classList.add('animate-pulse');
                        
                    } else {
                        progressDetails.innerHTML = \`
                            <div style="text-align: center; color: #666; font-style: italic;">
                                \${status.status}
                            </div>
                        \`;
                        batchStatusDiv.style.display = 'none';
                        
                        // Stop auto-refresh
                        if (refreshInterval) {
                            clearInterval(refreshInterval);
                            refreshInterval = null;
                        }
                        
                        // Remove pulse animation
                        progressFill.classList.remove('animate-pulse');
                    }
                    
                    // Update stats with animation
                    animateStatUpdate('totalUrls', status.total || 0);
                    animateStatUpdate('completedUrls', status.completed || 0);
                    animateStatUpdate('errorUrls', status.errors || 0);
                    animateStatUpdate('timeRemaining', status.estimatedMinutesRemaining || '--');
                }
                
                function animateStatUpdate(elementId, newValue) {
                    const element = document.getElementById(elementId);
                    const currentValue = element.textContent;
                    
                    if (currentValue !== newValue.toString()) {
                        element.style.transform = 'scale(1.1)';
                        element.style.transition = 'transform 0.2s';
                        
                        setTimeout(() => {
                            element.textContent = newValue;
                            element.style.transform = 'scale(1)';
                        }, 100);
                    }
                }
                
                function updateScheduleInfo(progress) {
                    document.getElementById('nextScrape').textContent = 
                        progress.nextScrape ? new Date(progress.nextScrape).toLocaleString() : 'Unknown';
                    document.getElementById('lastScrape').textContent = 
                        progress.lastScrape ? new Date(progress.lastScrape).toLocaleString() : 'Never';
                }
                
                async function updateUrlCount() {
                    try {
                        const response = await fetch('/api/pages');
                        const data = await response.json();
                        const count = data.pages.length;
                        document.getElementById('urlCounter').innerHTML = \`📋 \${count} URLs loaded\`;
                        
                        // Update counter color based on count
                        const counter = document.getElementById('urlCounter');
                        if (count === 0) {
                            counter.style.background = 'linear-gradient(135deg, #f56565 0%, #e53e3e 100%)';
                        } else if (count < 10) {
                            counter.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd7324 100%)';
                        } else {
                            counter.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                        }
                    } catch (error) {
                        console.error('URL count error:', error);
                        document.getElementById('urlCounter').textContent = '📋 Error loading';
                    }
                }
                
                async function startWeeklyBatch() {
                    const btn = document.getElementById('startBatchBtn');
                    const originalText = btn.textContent;
                    
                    btn.disabled = true;
                    btn.textContent = '🚀 Starting...';
                    btn.classList.add('animate-pulse');
                    
                    try {
                        const response = await fetch('/api/start-batch', { method: 'POST' });
                        const result = await response.json();
                        
                        if (result.success) {
                            showNotification('✅ Weekly batch started successfully!', 'success');
                            setTimeout(refreshStatus, 2000);
                        } else {
                            showNotification('❌ Error: ' + result.message, 'error');
                        }
                    } catch (error) {
                        showNotification('❌ Failed to start batch: ' + error.message, 'error');
                    } finally {
                        setTimeout(() => {
                            btn.disabled = false;
                            btn.textContent = originalText;
                            btn.classList.remove('animate-pulse');
                        }, 3000);
                    }
                }
                
                async function stopBatch() {
                    if (!confirm('Are you sure you want to stop the current batch? It will complete the current mini-batch before stopping.')) {
                        return;
                    }
                    
                    try {
                        const response = await fetch('/api/stop-batch', { method: 'POST' });
                        const result = await response.json();
                        
                        if (result.success) {
                            showNotification('⏹️ Batch stop requested', 'warning');
                        } else {
                            showNotification('❌ ' + result.message, 'error');
                        }
                    } catch (error) {
                        showNotification('❌ Error stopping batch: ' + error.message, 'error');
                    }
                }
                
                async function uploadBulkUrls() {
                    const textarea = document.getElementById('bulkUrls');
                    const rawUrls = textarea.value.split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0);
                    
                    if (rawUrls.length === 0) {
                        showNotification('⚠️ Please paste some URLs first', 'warning');
                        return;
                    }
                    
                    const statusDiv = document.getElementById('upload-status');
                    statusDiv.innerHTML = '<div class="status status-running">📤 Processing URLs...</div>';
                    
                    try {
                        const response = await fetch('/api/bulk-add', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ urls: rawUrls })
                        });
                        
                        const result = await response.json();
                        
                        if (result.success) {
                            statusDiv.innerHTML = \`
                                <div class="status status-complete">
                                    <strong>✅ Upload Complete!</strong><br>
                                    Added: \${result.added} new URLs<br>
                                    Duplicates: \${result.duplicates}<br>
                                    Invalid: \${result.invalid}<br>
                                    Total URLs: \${result.total}
                                </div>
                            \`;
                            textarea.value = '';
                            updateUrlCount();
                            showNotification(\`✅ Added \${result.added} new URLs!\`, 'success');
                        } else {
                            statusDiv.innerHTML = \`<div class="status status-error">❌ \${result.message}</div>\`;
                        }
                    } catch (error) {
                        statusDiv.innerHTML = \`<div class="status status-error">❌ Upload failed: \${error.message}</div>\`;
                    }
                    
                    // Clear status after 10 seconds
                    setTimeout(() => {
                        statusDiv.innerHTML = '';
                    }, 10000);
                }
                
                async function addSingleUrl() {
                    const input = document.getElementById('singleUrl');
                    const url = input.value.trim();
                    
                    if (!url) {
                        showNotification('⚠️ Please enter a URL', 'warning');
                        return;
                    }
                    
                    try {
                        const response = await fetch('/api/pages', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url })
                        });
                        
                        const result = await response.json();
                        const statusDiv = document.getElementById('single-add-status');
                        
                        if (result.success) {
                            statusDiv.innerHTML = \`<div class="status status-complete">✅ \${result.message}</div>\`;
                            input.value = '';
                            updateUrlCount();
                            showNotification('✅ URL added successfully!', 'success');
                        } else {
                            statusDiv.innerHTML = \`<div class="status status-error">❌ \${result.message}</div>\`;
                        }
                        
                        setTimeout(() => {
                            statusDiv.innerHTML = '';
                        }, 5000);
                        
                    } catch (error) {
                        console.error('Add URL error:', error);
                        showNotification('❌ Error adding URL: ' + error.message, 'error');
                    }
                }
                
                async function testScrape() {
                    const input = document.getElementById('singleUrl');
                    const url = input.value.trim();
                    
                    if (!url || !url.includes('b2b.asics.com/products/')) {
                        showNotification('⚠️ Please enter a valid ASICS B2B product URL', 'warning');
                        return;
                    }
                    
                    const statusDiv = document.getElementById('single-add-status');
                    statusDiv.innerHTML = '<div class="status status-running">🧪 Testing scrape... this may take 30-60 seconds</div>';
                    
                    try {
                        const response = await fetch('/api/test-scrape', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url })
                        });
                        
                        const result = await response.json();
                        
                        if (result.success) {
                            statusDiv.innerHTML = \`
                                <div class="status status-complete">
                                    <strong>✅ Test Successful!</strong><br>
                                    \${result.message}
                                </div>
                            \`;
                            showNotification('✅ Test scrape successful!', 'success');
                            setTimeout(refreshStatus, 1000);
                        } else {
                            statusDiv.innerHTML = \`<div class="status status-error">❌ \${result.message}</div>\`;
                        }
                        
                    } catch (error) {
                        statusDiv.innerHTML = \`<div class="status status-error">❌ Test failed: \${error.message}</div>\`;
                        console.error('Test scrape error:', error);
                    }
                }
                
                function exportCSV() {
                    window.open('/api/export/csv', '_blank');
                    showNotification('📥 CSV export started', 'info');
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
                        
                        showNotification(\`
                            💾 Memory Usage:<br>
                            Heap: \${memory.heapUsed} / \${memory.heapTotal}<br>
                            RSS: \${memory.rss}
                        \`, 'info');
                    } catch (error) {
                        showNotification('❌ Error checking memory', 'error');
                    }
                }
                
                async function clearUrls() {
                    if (!confirm('⚠️ Are you sure you want to clear ALL URLs? This cannot be undone!')) {
                        return;
                    }
                    
                    try {
                        const response = await fetch('/api/clear-all-pages', { method: 'POST' });
                        const result = await response.json();
                        
                        if (result.success) {
                            updateUrlCount();
                            showNotification('🗑️ All URLs cleared', 'success');
                        } else {
                            showNotification('❌ Error clearing URLs: ' + result.message, 'error');
                        }
                    } catch (error) {
                        showNotification('❌ Error clearing URLs: ' + error.message, 'error');
                    }
                }
                
                // Notification system
                function showNotification(message, type = 'info') {
                    const notification = document.createElement('div');
                    notification.innerHTML = message;
                    notification.style.cssText = \`
                        position: fixed;
                        top: 80px;
                        right: 25px;
                        padding: 15px 20px;
                        border-radius: 8px;
                        color: white;
                        font-weight: 500;
                        z-index: 10000;
                        max-width: 300px;
                        box-shadow: 0 5px 20px rgba(0,0,0,0.3);
                        transform: translateX(100%);
                        transition: transform 0.3s ease;
                    \`;
                    
                    // Set background based on type
                    switch(type) {
                        case 'success':
                            notification.style.background = 'linear-gradient(135deg, #48bb78 0%, #38a169 100%)';
                            break;
                        case 'error':
                            notification.style.background = 'linear-gradient(135deg, #f56565 0%, #e53e3e 100%)';
                            break;
                        case 'warning':
                            notification.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd7324 100%)';
                            break;
                        default:
                            notification.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                    }
                    
                    document.body.appendChild(notification);
                    
                    // Slide in
                    setTimeout(() => {
                        notification.style.transform = 'translateX(0)';
                    }, 100);
                    
                    // Slide out and remove
                    setTimeout(() => {
                        notification.style.transform = 'translateX(100%)';
                        setTimeout(() => {
                            if (notification.parentNode) {
                                notification.parentNode.removeChild(notification);
                            }
                        }, 300);
                    }, 4000);
                }
                
                // Enter key support
                document.getElementById('singleUrl').addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        addSingleUrl();
                    }
                });
                
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
                                if (!document.getElementById('startBatchBtn').disabled) {
                                    startWeeklyBatch();
                                }
                                break;
                        }
                    }
                });
                
                // Auto-save textarea content to localStorage (fallback)
                const textarea = document.getElementById('bulkUrls');
                textarea.addEventListener('input', function() {
                    try {
                        localStorage.setItem('bulkUrls', this.value);
                    } catch(e) {
                        // Ignore localStorage errors
                    }
                });
                
                // Restore textarea content
                try {
                    const saved = localStorage.getItem('bulkUrls');
                    if (saved) {
                        textarea.value = saved;
                    }
                } catch(e) {
                    // Ignore localStorage errors
                }
                
                // Initial load
                console.log('🚀 ASICS Weekly Batch Scraper Dashboard Loaded');
                refreshStatus();
                
                // Periodic refresh (every 30 seconds when not actively running)
                setInterval(() => {
                    if (!refreshInterval) { // Only if not already auto-refreshing
                        refreshStatus();
                    }
                }, 30000);
                
                // Show welcome message
                setTimeout(() => {
                    showNotification('🎉 Dashboard ready! Add your URLs and start batching.', 'success');
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
            console.log(`📊 Dashboard: http://localhost:${port}`);
            console.log(`💾 Memory usage: ${JSON.stringify(this.getMemoryUsage())}`);
            console.log(`📅 Next scheduled run: ${this.getNextScrapeTime()}`);
        });
    }
}

// Start the scraper
const scraper = new ASICSWeeklyBatchScraper();
scraper.start();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down gracefully...');
    if (scraper.db) {
        await scraper.db.end();
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    if (scraper.db) {
        await scraper.db.end();
    }
    process.exit(0);
});
    process.exit(0);
});
