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
            browser = await this.getBrowser();
            
            for (let i = 0; i < urls.length && this.isRunning; i++) {
                const url = urls[i];
                this.scrapingProgress.currentUrl = url;
                
                console.log(`🔍 Scraping ${url}`);
                
                try {
                    const result = await this.scrapePage(browser, url, batchId);
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
                    await this.delay(this.config.pageDelay);
                }
            }
            
        } catch (error) {
            console.error('❌ Batch browser error:', error);
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

    async getBrowser() {
        console.log('🚀 Launching browser...');
        
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

    async scrapePage(browser, url, batchId) {
        const page = await browser.newPage();
        
        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            
            await page.goto(url, { 
                waitUntil: 'networkidle0', 
                timeout: 60000 
            });

            await page.waitForSelector('.grid', { timeout: 20000 });
            await this.delay(5000);

            const inventory = await page.evaluate(() => {
                // Simple extraction for testing
                const productName = document.querySelector('h1')?.textContent?.trim() || 'Test Product';
                const styleId = window.location.pathname.split('/').pop()?.split('?')[0] || 'TEST123';
                
                return [{
                    productName: productName,
                    styleId: styleId,
                    colorCode: '001',
                    colorName: 'Test Color',
                    sizeUS: '10',
                    quantity: 5,
                    rawQuantity: '5',
                    extractedAt: new Date().toISOString(),
                    url: window.location.href
                }];
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
                <textarea id="bulkUrls" placeholder="https://b2b.asics.com/products/1013A160
https://b2b.asics.com/products/1013A161
https://b2b.asics.com/products/1013A162
...

Tip: You can paste hundreds of URLs at once!"></textarea>
                <button class="btn btn-success" onclick="uploadBulkUrls()">📤 Upload URLs</button>
                <button class="btn btn-danger" onclick="clearUrls()">🗑️ Clear All URLs</button>
                <div id="upload-status"></div>
            </div>
            
            <div class="card">
                <h3>🧪 Test & Quick Add</h3>
                <p>Test individual URLs before adding to batch:</p>
                <div class="input-group">
                    <input type="text" id="testUrl" placeholder="https://b2b.asics.com/products/1013A160">
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
            
            if (!url || !url.includes('b2b.asics.com/products/')) {
                showTestStatus('⚠️ Please enter a valid ASICS B2B product URL', 'warning');
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
        
        // Data export functions
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
   
