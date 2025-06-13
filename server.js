// server.js - Complete ASICS Auto-Scraper with Real Scraping
const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Pool } = require('pg');

class RealASICSScraper {
    constructor() {
        this.app = express();
        this.setupDatabase();
        this.pageList = [];
        this.isRunning = false;
        this.lastScrapeTime = null;
        
        this.setupMiddleware();
        this.setupRoutes();
        this.init();
    }

    setupDatabase() {
        this.db = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());
    }

    setupRoutes() {
        // Main dashboard
        this.app.get('/', (req, res) => {
            res.send(this.getDashboardHTML());
        });

        // Status API
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: '🚀 ASICS Real Auto-Scraper Running',
                pages: this.pageList.length,
                isScrapingNow: this.isRunning,
                lastScrape: this.lastScrapeTime,
                uptime: Math.floor(process.uptime()),
                version: '3.0.0 - REAL SCRAPING'
            });
        });

        // Trigger manual scrape
        this.app.post('/api/scrape-now', async (req, res) => {
            if (this.isRunning) {
                return res.json({ 
                    success: false, 
                    message: 'Scraper already running' 
                });
            }
            
            if (this.pageList.length === 0) {
                return res.json({ 
                    success: false, 
                    message: 'No pages to scrape. Add some URLs first.' 
                });
            }
            
            // Start scraping in background
            this.scrapeAllPages();
            res.json({ 
                success: true, 
                message: `Real scraping started for ${this.pageList.length} pages`,
                pages: this.pageList.length 
            });
        });

        // Page management
        this.app.get('/api/pages', (req, res) => {
            res.json({ pages: this.pageList });
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
                message: 'Page added successfully', 
                total: this.pageList.length 
            });
        });

        this.app.delete('/api/pages', async (req, res) => {
            const { url } = req.body;
            const index = this.pageList.indexOf(url);
            
            if (index > -1) {
                this.pageList.splice(index, 1);
                await this.savePageList();
                res.json({ 
                    success: true, 
                    message: 'Page removed successfully', 
                    total: this.pageList.length 
                });
            } else {
                res.status(404).json({ 
                    success: false, 
                    message: 'Page not found' 
                });
            }
        });

        // View scraped data
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
                    LIMIT 50
                `);
                res.json({ inventory: result.rows });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // View detailed inventory for a specific product
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

        // View scraping logs
        this.app.get('/api/logs', async (req, res) => {
            try {
                const result = await this.db.query(
                    'SELECT * FROM scrape_logs ORDER BY created_at DESC LIMIT 20'
                );
                res.json({ logs: result.rows });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Download inventory as CSV
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
                res.setHeader('Content-Disposition', 'attachment; filename=asics-inventory.csv');
                res.send(csvHeaders + csvData);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Test single page scraping
        this.app.post('/api/test-scrape', async (req, res) => {
            const { url } = req.body;
            
            if (!url || !url.includes('b2b.asics.com/products/')) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please provide a valid ASICS B2B product URL' 
                });
            }
            
            try {
                console.log(`🧪 Testing real scrape of: ${url}`);
                const result = await this.scrapeSinglePage(url);
                
                if (result.success && result.inventory && result.inventory.length > 0) {
                    await this.saveInventoryToDatabase(result.inventory);
                    res.json({
                        success: true,
                        message: `Successfully scraped ${result.inventory.length} records from ${url}`,
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
        console.log('🚀 Initializing Real ASICS Auto-Scraper...');
        
        await this.setupDatabaseTables();
        await this.loadPageList();
        this.startScheduler();
        
        console.log(`✅ Real scraper initialized with ${this.pageList.length} pages`);
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
                    UNIQUE(style_id, color_code, size_us)
                )
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS scrape_logs (
                    id SERIAL PRIMARY KEY,
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
            console.log(`📋 Loaded ${this.pageList.length} pages to monitor`);
        } catch (error) {
            console.error('Error loading pages:', error);
            this.pageList = [];
        }
    }

    startScheduler() {
        console.log('🕐 Starting real scraping scheduler - every 30 minutes');
        
        // Run first scrape after 2 minutes if we have pages
        setTimeout(() => {
            if (this.pageList.length > 0) {
                console.log('🚀 Running initial real scrape...');
                this.scrapeAllPages();
            } else {
                console.log('📝 No pages to scrape. Add some URLs first.');
            }
        }, 120000);
        
        // Then every 30 minutes
        cron.schedule('*/30 * * * *', () => {
            if (this.pageList.length > 0) {
                console.log('⏰ Scheduled real scrape triggered');
                this.scrapeAllPages();
            }
        });
    }

    async scrapeAllPages() {
        if (this.isRunning) {
            console.log('⏳ Scraper already running, skipping...');
            return;
        }

        this.isRunning = true;
        const startTime = Date.now();
        
        console.log(`🚀 Starting real scrape of ${this.pageList.length} pages`);

        let browser;
        const results = [];

        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-extensions',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding'
                ]
            });

            console.log('🌐 Browser launched successfully');

            // Process pages in small batches to avoid memory issues
            const batchSize = 2;
            for (let i = 0; i < this.pageList.length; i += batchSize) {
                const batch = this.pageList.slice(i, i + batchSize);
                console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1}: ${batch.length} pages`);
                
                const batchPromises = batch.map(url => this.scrapePage(browser, url));
                const batchResults = await Promise.allSettled(batchPromises);
                
                batchResults.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        results.push(result.value);
                    } else {
                        console.error(`❌ Batch error for ${batch[index]}:`, result.reason.message);
                        results.push({
                            url: batch[index],
                            success: false,
                            error: result.reason.message
                        });
                    }
                });
                
                if (i + batchSize < this.pageList.length) {
                    console.log('⏸️ Waiting between batches...');
                    await this.delay(5000);
                }
            }

        } catch (error) {
            console.error('❌ Critical scraping error:', error);
        } finally {
            if (browser) {
                await browser.close();
                console.log('🔒 Browser closed');
            }
        }

        await this.processResults(results);
        
        const duration = Math.round((Date.now() - startTime) / 1000);
        this.lastScrapeTime = new Date().toISOString();
        
        console.log(`✅ Real scraping completed in ${duration} seconds`);
        this.isRunning = false;
    }

    async scrapePage(browser, url) {
        const page = await browser.newPage();
        
        try {
            console.log(`🔍 Real scraping: ${url}`);
            
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            await page.goto(url, { 
                waitUntil: 'networkidle0', 
                timeout: 45000 
            });

            // Wait for the grid to load
            await page.waitForSelector('.grid', { timeout: 15000 });
            
            // Additional wait for dynamic content
            await this.delay(3000);

            // Extract inventory using your proven logic
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
                        
                        // Fallback method if no colors found
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
                        
                        console.log('Found quantity row elements:', quantityRows.length);
                        
                        quantityRows.forEach((row, index) => {
                            const quantities = [];
                            const cells = row.querySelectorAll('.flex.items-center.justify-center span');
                            console.log(`Row ${index} has ${cells.length} cells`);
                            
                            cells.forEach(cell => {
                                const text = cell.textContent.trim();
                                if (text.match(/^\d+\+?$/) || text === '0' || text === '0+') {
                                    quantities.push(text);
                                }
                            });
                            
                            console.log(`Row ${index} quantities:`, quantities);
                            
                            if (quantities.length > 0) {
                                quantityMatrix.push(quantities);
                            }
                        });
                        
                        // If no matrix found, try alternative approach
                        if (quantityMatrix.length === 0) {
                            console.log('No quantity matrix found, trying alternative approach...');
                            
                            const potentialQuantityElements = document.querySelectorAll('span, div');
                            const quantityPattern = /^(\d+\+?|0\+?)$/;
                            const foundQuantities = [];
                            
                            potentialQuantityElements.forEach(el => {
                                const text = el.textContent.trim();
                                if (quantityPattern.test(text)) {
                                    const rect = el.getBoundingClientRect();
                                    foundQuantities.push({
                                        text,
                                        element: el,
                                        x: rect.left,
                                        y: rect.top
                                    });
                                }
                            });
                            
                            console.log('Found potential quantities:', foundQuantities.map(q => q.text));
                            
                            // Group quantities by similar Y coordinates (rows)
                            foundQuantities.sort((a, b) => a.y - b.y);
                            
                            let currentRow = [];
                            let lastY = -1;
                            const tolerance = 10; // pixels
                            
                            foundQuantities.forEach(q => {
                                if (lastY === -1 || Math.abs(q.y - lastY) < tolerance) {
                                    currentRow.push(q.text);
                                    lastY = q.y;
                                } else {
                                    if (currentRow.length > 5) { // Minimum reasonable number of sizes
                                        quantityMatrix.push([...currentRow]);
                                    }
                                    currentRow = [q.text];
                                    lastY = q.y;
                                }
                            });
                            
                            // Add the last row
                            if (currentRow.length > 5) {
                                quantityMatrix.push(currentRow);
                            }
                        }
                        
                        console.log('Final quantity matrix:', quantityMatrix);
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

            console.log(`✅ ${url}: ${inventory.length} real records extracted`);
            
            return {
                url,
                success: true,
                inventory,
                recordCount: inventory.length,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error(`❌ Error scraping ${url}:`, error.message);
            return {
                url,
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            };
        } finally {
            await page.close();
        }
    }

    async scrapeSinglePage(url) {
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-extensions'
                ]
            });

            const result = await this.scrapePage(browser, url);
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

    async processResults(results) {
        const allInventory = [];
        const successCount = results.filter(r => r.success).length;
        const errorCount = results.filter(r => !r.success).length;
        
        results.forEach(result => {
            if (result.success && result.inventory) {
                allInventory.push(...result.inventory.map(item => ({
                    ...item,
                    sourceUrl: result.url,
                    scrapedAt: result.timestamp
                })));
            }
        });

        console.log(`📊 Processing real results: ${allInventory.length} total records`);
        console.log(`✅ Successful pages: ${successCount}`);
        console.log(`❌ Failed pages: ${errorCount}`);

        if (allInventory.length > 0) {
            await this.saveInventoryToDatabase(allInventory);
        }

        await this.logScrapeResults(results.length, successCount, errorCount, allInventory.length);
    }

    async saveInventoryToDatabase(inventory) {
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');
            
            console.log('📤 Saving real inventory to database...');
            
            for (let item of inventory) {
                await client.query(`
                    INSERT INTO current_inventory 
                    (product_name, style_id, color_code, color_name, size_us, quantity, raw_quantity, source_url, scraped_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (style_id, color_code, size_us) 
                    DO UPDATE SET 
                        quantity = EXCLUDED.quantity,
                        raw_quantity = EXCLUDED.raw_quantity,
                        scraped_at = EXCLUDED.scraped_at
                `, [
                    item.productName, item.styleId, item.colorCode, 
                    item.colorName, item.sizeUS, item.quantity,
                    item.rawQuantity, item.sourceUrl, item.scrapedAt
                ]);
            }
            
            await client.query('COMMIT');
            console.log('✅ Real inventory saved to database');
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Database save error:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async logScrapeResults(totalPages, successCount, errorCount, recordCount) {
        try {
            await this.db.query(`
                INSERT INTO scrape_logs (total_pages, success_count, error_count, record_count)
                VALUES ($1, $2, $3, $4)
            `, [totalPages, successCount, errorCount, recordCount]);
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
                    'INSERT INTO monitored_pages (url, active) VALUES ($1, true) ON CONFLICT (url) DO NOTHING',
                    [url]
                );
            }
        } catch (error) {
            console.error('Error saving page list:', error);
        } finally {
            client.release();
        }
    }

    getDashboardHTML() {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>ASICS Real Auto-Scraper</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { box-sizing: border-box; }
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, sans-serif; 
                    margin: 0; padding: 20px; background: #f5f7fa; 
                    line-height: 1.6;
                }
                .container { max-width: 1200px; margin: 0 auto; }
                .header { 
                    background: linear-gradient(135deg, #667eea, #764ba2); 
                    color: white; padding: 30px; border-radius: 10px; 
                    margin-bottom: 30px; text-align: center;
                }
                .header h1 { margin: 0; font-size: 2.5em; }
                .header p { margin: 10px 0 0 0; opacity: 0.9; }
                .cards { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); 
                    gap: 20px; 
                    margin-bottom: 30px;
                }
                .card { 
                    background: white; padding: 25px; border-radius: 8px; 
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
                }
                .card h3 { margin: 0 0 20px 0; color: #333; font-size: 1.3em; }
                .btn { 
                    background: #667eea; color: white; border: none; 
                    padding: 12px 24px; border-radius: 6px; cursor: pointer; 
                    margin: 5px 5px 5px 0; font-size: 14px; font-weight: 500;
                    transition: all 0.2s;
                }
                .btn:hover { background: #5a67d8; transform: translateY(-1px); }
                .btn:disabled { background: #ccc; cursor: not-allowed; transform: none; }
                .btn-success { background: #48bb78; }
                .btn-success:hover { background: #38a169; }
                .btn-danger { background: #f56565; }
                .btn-danger:hover { background: #e53e3e; }
                .btn-test { background: #ed8936; }
                .btn-test:hover { background: #dd7324; }
                .status { 
                    padding: 15px; border-radius: 5px; margin: 15px 0; 
                    font-weight: 500;
                }
                .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
                .warning { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
                .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
                .info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
                .input-group { display: flex; gap: 10px; margin: 15px 0; }
                .input-group input { 
                    flex: 1; padding: 12px; border: 1px solid #ddd; 
                    border-radius: 4px; font-size: 14px;
                }
                .page-list { max-height: 300px; overflow-y: auto; border: 1px solid #eee; border-radius: 4px; }
                .page-item { 
                    padding: 12px; border-bottom: 1px solid #f0f0f0; 
                    display: flex; justify-content: space-between; align-items: center;
                }
                .page-item:last-child { border-bottom: none; }
                .page-url { font-size: 12px; color: #666; word-break: break-all; flex: 1; }
                .logs { max-height: 400px; overflow-y: auto; }
                .log-item { 
                    padding: 12px; border-bottom: 1px solid #eee; 
                    font-size: 13px; background: #f9f9f9; margin: 5px 0; border-radius: 4px;
                }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
                .stat-box { 
                    text-align: center; padding: 20px; background: #f8f9fa; 
                    border-radius: 6px; border: 1px solid #e9ecef;
                }
                .stat-number { font-size: 2em; font-weight: bold; color: #495057; margin: 0; }
                .stat-label { color: #6c757d; font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.5px; }
                .loading { opacity: 0.6; }
                .export-btn { background: #28a745; }
                .export-btn:hover { background: #218838; }
                .notice { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 15px; border-radius: 6px; margin: 15px 0; }
                @media (max-width: 768px) {
                    .cards { grid-template-columns: 1fr; }
                    .input-group { flex-direction: column; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🚀 ASICS Real Auto-Scraper</h1>
                    <p>Live inventory scraping from ASICS B2B portal</p>
                </div>
                
                <div class="notice">
                    <strong>🎉 REAL SCRAPING ACTIVE:</strong> Now using Puppeteer to extract actual inventory data from ASICS B2B pages!
                </div>
                
                <div class="cards">
                    <div class="card">
                        <h3>🎛️ Controls</h3>
                        <button class="btn" id="scrapeBtn" onclick="scrapeNow()">🚀 Scrape All Pages</button>
                        <button class="btn btn-test" onclick="testScrape()">🧪 Test Single Page</button>
                        <button class="btn" onclick="refreshAll()">🔄 Refresh Status</button>
                        <button class="btn export-btn" onclick="exportCSV()">📥 Export CSV</button>
                        <div id="status-message" class="status" style="display: none;"></div>
                    </div>
                    
                    <div class="card">
                        <h3>📊 Status</h3>
                        <div id="current-status">Loading...</div>
                    </div>
                    
                    <div class="card">
                        <h3>📋 Add New Page</h3>
                        <div class="input-group">
                            <input type="text" id="newUrl" placeholder="https://b2b.asics.com/products/1013A160" />
                            <button class="btn btn-success" onclick="addPage()">Add Page</button>
                        </div>
                        <div id="add-status" style="min-height: 20px;"></div>
                    </div>
                </div>
                
                <div class="cards">
                    <div class="card">
                        <h3>📝 Monitored Pages</h3>
                        <div id="page-list" class="page-list">Loading...</div>
                    </div>
                    
                    <div class="card">
                        <h3>📈 Recent Activity</h3>
                        <div id="recent-logs" class="logs">Loading...</div>
                    </div>
                </div>
                
                <div class="card">
                    <h3>📦 Current Inventory</h3>
                    <div id="inventory-stats" class="stats-grid">Loading...</div>
                </div>
            </div>
            
            <script>
                let isRefreshing = false;
                
                async function refreshAll() {
                    if (isRefreshing) return;
                    isRefreshing = true;
                    
                    await Promise.all([
                        refreshStatus(),
                        loadPages(),
                        loadLogs(),
                        loadInventoryStats()
                    ]);
                    
                    isRefreshing = false;
                }
                
                async function refreshStatus() {
                    try {
                        const response = await fetch('/api/status');
                        const status = await response.json();
                        
                        document.getElementById('current-status').innerHTML = \`
                            <div class="stats-grid">
                                <div class="stat-box">
                                    <div class="stat-number">\${status.isScrapingNow ? '🟡' : '🟢'}</div>
                                    <div class="stat-label">\${status.isScrapingNow ? 'Scraping' : 'Ready'}</div>
                                </div>
                                <div class="stat-box">
                                    <div class="stat-number">\${status.pages}</div>
                                    <div class="stat-label">Pages</div>
                                </div>
                                <div class="stat-box">
                                    <div class="stat-number">\${Math.floor(status.uptime / 60)}</div>
                                    <div class="stat-label">Uptime (min)</div>
                                </div>
                            </div>
                            <p style="margin-top: 15px; color: #666; font-size: 0.9em;">
                                <strong>Version:</strong> \${status.version}<br>
                                <strong>Last Scrape:</strong> \${status.lastScrape ? new Date(status.lastScrape).toLocaleString() : 'Never'}
                            </p>
                        \`;
                        
                        // Update scrape button
                        const btn = document.getElementById('scrapeBtn');
                        if (status.isScrapingNow) {
                            btn.textContent = '⏳ Scraping...';
                            btn.disabled = true;
                        } else {
                            btn.textContent = '🚀 Scrape All Pages';
                            btn.disabled = false;
                        }
                        
                    } catch (error) {
                        console.error('Status error:', error);
                        document.getElementById('current-status').innerHTML = '<p class="error">Error loading status</p>';
                    }
                }
                
                async function scrapeNow() {
                    const btn = document.getElementById('scrapeBtn');
                    const statusDiv = document.getElementById('status-message');
                    
                    btn.disabled = true;
                    btn.textContent = 'Starting...';
                    
                    try {
                        const response = await fetch('/api/scrape-now', { method: 'POST' });
                        const result = await response.json();
                        
                        statusDiv.style.display = 'block';
                        statusDiv.className = \`status \${result.success ? 'success' : 'error'}\`;
                        statusDiv.textContent = result.message;
                        
                        if (result.success) {
                            setTimeout(refreshAll, 2000);
                            setTimeout(refreshAll, 15000); // Check again in 15s
                        }
                        
                    } catch (error) {
                        statusDiv.style.display = 'block';
                        statusDiv.className = 'status error';
                        statusDiv.textContent = 'Error starting scrape: ' + error.message;
                    } finally {
                        setTimeout(() => {
                            btn.disabled = false;
                            btn.textContent = '🚀 Scrape All Pages';
                        }, 3000);
                    }
                }
                
                async function testScrape() {
                    const url = document.getElementById('newUrl').value.trim();
                    
                    if (!url || !url.includes('b2b.asics.com/products/')) {
                        alert('Please enter a valid ASICS B2B product URL');
                        return;
                    }
                    
                    const statusDiv = document.getElementById('status-message');
                    statusDiv.style.display = 'block';
                    statusDiv.className = 'status info';
                    statusDiv.textContent = 'Testing real scrape... this may take 30-60 seconds';
                    
                    try {
                        const response = await fetch('/api/test-scrape', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url })
                        });
                        
                        const result = await response.json();
                        
                        statusDiv.className = \`status \${result.success ? 'success' : 'error'}\`;
                        statusDiv.textContent = result.message;
                        
                        if (result.success) {
                            setTimeout(refreshAll, 1000);
                        }
                        
                    } catch (error) {
                        statusDiv.className = 'status error';
                        statusDiv.textContent = 'Test scrape failed: ' + error.message;
                        console.error('Test scrape error:', error);
                    }
                }
                
                async function addPage() {
                    const input = document.getElementById('newUrl');
                    const statusDiv = document.getElementById('add-status');
                    const url = input.value.trim();
                    
                    if (!url) {
                        showAddStatus('Please enter a URL', 'warning');
                        return;
                    }
                    
                    if (!url.includes('b2b.asics.com/products/')) {
                        showAddStatus('Please enter a valid ASICS B2B product URL', 'error');
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
                            input.value = '';
                            showAddStatus(result.message, 'success');
                            loadPages();
                            refreshStatus();
                        } else {
                            showAddStatus(result.message, 'error');
                        }
                        
                    } catch (error) {
                        showAddStatus('Error adding page: ' + error.message, 'error');
                    }
                }
                
                function showAddStatus(message, type) {
                    const statusDiv = document.getElementById('add-status');
                    statusDiv.innerHTML = \`<div class="status \${type}" style="margin: 10px 0;">\${message}</div>\`;
                    setTimeout(() => {
                        statusDiv.innerHTML = '';
                    }, 5000);
                }
                
                async function removePage(url) {
                    if (!confirm('Remove this page from monitoring?')) return;
                    
                    try {
                        const response = await fetch('/api/pages', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url })
                        });
                        
                        const result = await response.json();
                        if (result.success) {
                            loadPages();
                            refreshStatus();
                        }
                    } catch (error) {
                        console.error('Remove error:', error);
                    }
                }
                
                async function loadPages() {
                    try {
                        const response = await fetch('/api/pages');
                        const data = await response.json();
                        
                        const pageListDiv = document.getElementById('page-list');
                        
                        if (data.pages.length === 0) {
                            pageListDiv.innerHTML = '<p style="padding: 20px; text-align: center; color: #666;">No pages added yet</p>';
                            return;
                        }
                        
                        pageListDiv.innerHTML = data.pages.map(url => \`
                            <div class="page-item">
                                <div class="page-url">\${url.replace('https://b2b.asics.com/products/', '')}</div>
                                <div>
                                    <button class="btn btn-test" onclick="testSingleUrl('\${url}')" style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Test</button>
                                    <button class="btn btn-danger" onclick="removePage('\${url}')" style="padding: 4px 8px; font-size: 11px;">Remove</button>
                                </div>
                            </div>
                        \`).join('');
                        
                    } catch (error) {
                        console.error('Pages error:', error);
                        document.getElementById('page-list').innerHTML = '<p class="error">Error loading pages</p>';
                    }
                }
                
                async function testSingleUrl(url) {
                    document.getElementById('newUrl').value = url;
                    await testScrape();
                }
                
                async function loadLogs() {
                    try {
                        const response = await fetch('/api/logs');
                        const data = await response.json();
                        
                        const logsDiv = document.getElementById('recent-logs');
                        
                        if (data.logs.length === 0) {
                            logsDiv.innerHTML = '<p style="padding: 20px; text-align: center; color: #666;">No recent activity</p>';
                            return;
                        }
                        
                        logsDiv.innerHTML = data.logs.map(log => \`
                            <div class="log-item">
                                <strong>\${new Date(log.created_at).toLocaleString()}</strong><br>
                                📊 \${log.success_count}/\${log.total_pages} pages successful • 
                                📦 \${log.record_count} records • 
                                ❌ \${log.error_count} errors
                            </div>
                        \`).join('');
                        
                    } catch (error) {
                        console.error('Logs error:', error);
                        document.getElementById('recent-logs').innerHTML = '<p class="error">Error loading logs</p>';
                    }
                }
                
                async function loadInventoryStats() {
                    try {
                        const response = await fetch('/api/inventory');
                        const data = await response.json();
                        
                        const statsDiv = document.getElementById('inventory-stats');
                        
                        if (data.inventory.length === 0) {
                            statsDiv.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #666;">No inventory data yet - try testing a scrape!</p>';
                            return;
                        }
                        
                        const totalProducts = data.inventory.length;
                        const totalQuantity = data.inventory.reduce((sum, item) => sum + (parseInt(item.total_quantity) || 0), 0);
                        const latestUpdate = data.inventory[0]?.last_updated;
                        
                        statsDiv.innerHTML = \`
                            <div class="stat-box">
                                <div class="stat-number">\${totalProducts}</div>
                                <div class="stat-label">Products</div>
                            </div>
                            <div class="stat-box">
                                <div class="stat-number">\${totalQuantity}</div>
                                <div class="stat-label">Total Units</div>
                            </div>
                            <div class="stat-box">
                                <div class="stat-number">\${latestUpdate ? new Date(latestUpdate).toLocaleDateString() : 'Never'}</div>
                                <div class="stat-label">Last Updated</div>
                            </div>
                        \`;
                        
                    } catch (error) {
                        console.error('Inventory error:', error);
                        document.getElementById('inventory-stats').innerHTML = '<p class="error">Error loading inventory</p>';
                    }
                }
                
                function exportCSV() {
                    window.open('/api/export/csv', '_blank');
                }
                
                // Enter key support for adding pages
                document.getElementById('newUrl').addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        addPage();
                    }
                });
                
                // Initial load
                refreshAll();
                
                // Auto-refresh every 30 seconds
                setInterval(refreshStatus, 30000);
            </script>
        </body>
        </html>`;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    start() {
        const port = process.env.PORT || 3000;
        this.app.listen(port, '0.0.0.0', async () => {
            console.log(`🚀 Real ASICS Auto-Scraper running on port ${port}`);
            console.log(`📊 Dashboard: https://asics-auto-scraper.onrender.com`);
        });
    }
}

// Start the real scraper
const scraper = new RealASICSScraper();
scraper.start();

process.on('SIGTERM', () => {
    console.log('🛑 Shutting down gracefully');
    process.exit(0);
});
