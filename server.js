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
        console.log('   DB_HOST:', process.env.DB_HOST ? 'SET' : 'NOT SET');
        console.log('   DB_PORT:', process.env.DB_PORT || '5432 (default)');
        console.log('   DB_NAME:', process.env.DB_NAME ? 'SET' : 'NOT SET');
        console.log('   DB_USER:', process.env.DB_USER ? 'SET' : 'NOT SET');
        console.log('   DB_PASSWORD:', process.env.DB_PASSWORD ? 'SET' : 'NOT SET');
        console.log('   ASICS_USERNAME:', process.env.ASICS_USERNAME ? 'SET' : 'NOT SET');
        console.log('   ASICS_PASSWORD:', process.env.ASICS_PASSWORD ? 'SET' : 'NOT SET');
        
        // Database configuration
        if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER || !process.env.DB_PASSWORD) {
            console.error('❌ Missing required database environment variables!');
            console.error('   Required: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD');
            process.exit(1);
        }
        
        this.pool = new Pool({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT || 5432,
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });

        console.log('🗄️ Database configuration loaded:', {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT || 5432,
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
            ssl: process.env.NODE_ENV === 'production' ? 'enabled' : 'disabled'
        });

        // ASICS credentials
        this.credentials = {
            username: process.env.ASICS_USERNAME,
            password: process.env.ASICS_PASSWORD
        };

        if (!this.credentials.username || !this.credentials.password) {
            console.warn('⚠️ ASICS credentials not set - authentication will fail');
            console.warn('   Set ASICS_USERNAME and ASICS_PASSWORD environment variables');
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
        
        this.setupMiddleware();
        this.setupRoutes();
        this.initializeDatabase();
    }

    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static('public'));
        
        // Memory monitoring middleware
        this.app.use((req, res, next) => {
            const memUsage = process.memoryUsage();
            const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;
            console.log('💾 Memory usage:', {
                heapUsed: formatMB(memUsage.heapUsed),
                heapTotal: formatMB(memUsage.heapTotal),
                rss: formatMB(memUsage.rss)
            });
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
                environment: {
                    DB_HOST: process.env.DB_HOST ? 'SET' : 'NOT SET',
                    DB_NAME: process.env.DB_NAME ? 'SET' : 'NOT SET',
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
                        body { font-family: Arial, sans-serif; margin: 40px; }
                        .status { background: #f0f8ff; padding: 20px; border-radius: 8px; }
                        .config { background: #f5f5f5; padding: 15px; margin: 20px 0; }
                        .urls { background: #fff5ee; padding: 15px; margin: 20px 0; }
                    </style>
                </head>
                <body>
                    <h1>🚀 ASICS Weekly Batch Scraper</h1>
                    <div class="status">
                        <h2>Status: Active</h2>
                        <p>Uptime: ${Math.floor(process.uptime() / 60)} minutes</p>
                        <p>Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB</p>
                    </div>
                    <div class="config">
                        <h3>Configuration</h3>
                        <p>Batch Size: ${this.config.batchSize} URLs</p>
                        <p>Delay: ${this.config.delayBetweenRequests / 1000}s</p>
                        <p>Max Retries: ${this.config.maxRetries}</p>
                    </div>
                    <div class="urls">
                        <h3>Monitoring ${this.urlsToMonitor.length} URLs</h3>
                        ${this.urlsToMonitor.map(url => `<p>• ${url}</p>`).join('')}
                    </div>
                    <div class="config">
                        <h3>Quick Actions</h3>
                        <button onclick="fetch('/trigger', {method: 'POST'}).then(r=>r.json()).then(d=>alert(JSON.stringify(d)))">
                            🎯 Trigger Manual Batch
                        </button>
                    </div>
                </body>
                </html>
            `);
        });

        // Manual trigger
        this.app.post('/trigger', async (req, res) => {
            try {
                console.log('🎯 Manual batch trigger received');
                const batchId = `manual_${Date.now()}`;
                
                // Run batch in background
                setTimeout(() => this.startWeeklyBatch(batchId), 1000);
                
                res.json({ 
                    success: true, 
                    message: 'Batch started in background', 
                    batchId
                });
            } catch (error) {
                console.error('❌ Manual trigger failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Get recent logs
        this.app.get('/logs', async (req, res) => {
            try {
                const result = await this.pool.query(`
                    SELECT * FROM scrape_logs 
                    ORDER BY created_at DESC 
                    LIMIT 50
                `);
                res.json(result.rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    async initializeDatabase() {
        try {
            console.log('🗄️ Initializing database...');
            console.log('🔗 Testing database connection...');
            
            // Test connection first
            const testResult = await this.pool.query('SELECT NOW() as current_time, version() as postgres_version');
            console.log('✅ Database connection successful!');
            console.log('   Time:', testResult.rows[0].current_time);
            console.log('   PostgreSQL:', testResult.rows[0].postgres_version.split(' ')[0]);
            
            // Create scrape_logs table with all necessary columns
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS scrape_logs (
                    id SERIAL PRIMARY KEY,
                    batch_id VARCHAR(255),
                    url VARCHAR(1000) NOT NULL,
                    status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    product_count INTEGER DEFAULT 0,
                    error_message TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Add batch_id column if it doesn't exist (for existing installations)
            try {
                await this.pool.query(`
                    ALTER TABLE scrape_logs 
                    ADD COLUMN IF NOT EXISTS batch_id VARCHAR(255)
                `);
            } catch (alterError) {
                console.log('   batch_id column already exists or could not be added');
            }

            // Create indexes for better performance
            await this.pool.query(`
                CREATE INDEX IF NOT EXISTS idx_scrape_logs_batch_id 
                ON scrape_logs(batch_id)
            `);
            
            await this.pool.query(`
                CREATE INDEX IF NOT EXISTS idx_scrape_logs_status 
                ON scrape_logs(status)
            `);

            // Create products table (optional, for storing actual product data)
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS products (
                    id SERIAL PRIMARY KEY,
                    batch_id VARCHAR(255),
                    url VARCHAR(1000),
                    sku VARCHAR(255) UNIQUE,
                    name VARCHAR(500),
                    price VARCHAR(100),
                    description TEXT,
                    image_url VARCHAR(1000),
                    availability VARCHAR(100),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            console.log('✅ Database tables ready');
            
            // Load URLs to monitor
            await this.loadUrlsToMonitor();
            
        } catch (error) {
            console.error('❌ Database initialization failed:', error);
            console.error('   Error details:', {
                code: error.code,
                message: error.message,
                host: process.env.DB_HOST,
                database: process.env.DB_NAME
            });
            process.exit(1);
        }
    }

    async loadUrlsToMonitor() {
        try {
            // Try to load from database first
            const result = await this.pool.query(`
                SELECT DISTINCT url FROM scrape_logs 
                WHERE created_at > NOW() - INTERVAL '30 days'
                LIMIT 100
            `);
            
            if (result.rows.length > 0) {
                this.urlsToMonitor = result.rows.map(row => row.url);
            } else {
                // Fallback to default URLs if no recent ones in database
                this.urlsToMonitor = [
                    'https://b2b.asics.com/us/en-us/mens-running-shoes',
                    'https://b2b.asics.com/us/en-us/womens-running-shoes'
                ];
            }
            
            console.log(`📋 Loaded ${this.urlsToMonitor.length} URLs to monitor`);
            
        } catch (error) {
            console.error('⚠️ Could not load URLs from database, using defaults:', error.message);
            this.urlsToMonitor = [
                'https://b2b.asics.com/us/en-us/mens-running-shoes',
                'https://b2b.asics.com/us/en-us/womens-running-shoes'
            ];
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

    // Enhanced authentication function with better field detection
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
            
            // Set user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            console.log('🚀 [FIXED] Launching browser with ASICS B2B authentication...');
            console.log('🔐 [FIXED] Navigating to ASICS B2B authentication...');
            
            await page.goto('https://b2b.asics.com/authentication/login', { 
                waitUntil: 'networkidle0',
                timeout: 30000 
            });

            // Log current state
            const currentUrl = page.url();
            const title = await page.title();
            console.log(`📋 [FIXED] Current URL: ${currentUrl}`);
            console.log(`📋 [FIXED] Page title: ${title}`);

            // Check page content and detect country selection
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

            // Handle country selection if present
            if (pageState.hasCountrySelection && !pageState.hasLoginForm) {
                console.log('🌍 [FIXED] Country selection detected, clicking United States...');
                
                // Try multiple selectors for United States
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
                        // Try next selector
                        continue;
                    }
                }

                if (!countrySelected) {
                    // Fallback: click any element containing "United States"
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
                
                // Wait for login form to appear
                try {
                    await page.waitForSelector('input[type="password"], input[name*="password"]', { timeout: 10000 });
                    console.log('✅ [FIXED] Login form appeared');
                } catch (e) {
                    throw new Error('Login form did not appear after country selection');
                }
            }

            // Enhanced login form detection
            const loginFormCheck = await page.evaluate(() => {
                // Look for various username/email field patterns
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

                // Find username field
                for (const selector of usernameSelectors) {
                    usernameField = document.querySelector(selector);
                    if (usernameField) break;
                }

                // Find password field
                for (const selector of passwordSelectors) {
                    passwordField = document.querySelector(selector);
                    if (passwordField) break;
                }

                // If no specific username field found, look for the first text input before password
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

            // Get current page state for debugging
            const debugState = await page.evaluate(() => ({
                url: window.location.href,
                title: document.title,
                bodyText: document.body ? document.body.innerText.slice(0, 500) : ''
            }));
            console.log('🔍 [FIXED] Current page state:', debugState);

            if (!loginFormCheck.hasBoth) {
                // Take screenshot for debugging
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

            // Handle cookie consent if present
            try {
                const cookieAcceptButton = await page.$('button:contains("Accept"), button[id*="accept"], button[class*="accept"]');
                if (cookieAcceptButton) {
                    await cookieAcceptButton.click();
                    console.log('🍪 [FIXED] Cookie consent accepted');
                    await page.waitForTimeout(1000);
                }
            } catch (e) {
                // Cookie consent not found or already handled
            }

            // Fill in credentials using detected selectors
            console.log('📝 [FIXED] Filling in credentials...');
            
            if (loginFormCheck.usernameSelector) {
                await page.type(loginFormCheck.usernameSelector, this.credentials.username);
            }
            
            if (loginFormCheck.passwordSelector) {
                await page.type(loginFormCheck.passwordSelector, this.credentials.password);
            }

            // Submit form
            console.log('🔐 [FIXED] Submitting login form...');
            
            // Try multiple submit methods
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
                // Fallback: press Enter on password field
                await page.focus(loginFormCheck.passwordSelector);
                await page.keyboard.press('Enter');
            }

            // Wait for navigation after login
            console.log('⏳ [FIXED] Waiting for authentication...');
            await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 });

            // Verify successful login
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
            
            // Wait for products to load
            await page.waitForTimeout(3000);
            
            // Extract product data
            const products = await page.evaluate(() => {
                const productElements = document.querySelectorAll([
                    '.product-item',
                    '.product-card', 
                    '.product-tile',
                    '.product',
                    '[data-product-id]',
                    '.grid-item'
                ].join(', '));
                
                const products = [];
                
                productElements.forEach((element, index) => {
                    try {
                        const name = element.querySelector([
                            '.product-name',
                            '.product-title', 
                            '.name',
                            'h2',
                            'h3',
                            '.title'
                        ].join(', '))?.textContent?.trim();
                        
                        const price = element.querySelector([
                            '.price',
                            '.product-price',
                            '.cost',
                            '[class*="price"]'
                        ].join(', '))?.textContent?.trim();
                        
                        const sku = element.querySelector([
                            '.sku',
                            '.product-id',
                            '[data-sku]',
                            '[data-product-id]'
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

    // Fixed logging function that handles missing batch_id column gracefully
    async logScrapeResults(results, batchId = null) {
        if (!results || results.length === 0) {
            console.log('📊 No results to log');
            return;
        }

        try {
            // First, check if batch_id column exists
            const columnCheckQuery = `
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'scrape_logs' 
                AND column_name = 'batch_id'
            `;
            
            const columnExists = await this.pool.query(columnCheckQuery);
            const hasBatchIdColumn = columnExists.rows.length > 0;

            // Prepare the insert query based on whether batch_id column exists
            let insertQuery;
            let values;

            if (hasBatchIdColumn && batchId) {
                // Include batch_id in the insert
                insertQuery = `
                    INSERT INTO scrape_logs (batch_id, url, status, product_count, error_message, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `;
                
                for (const result of results) {
                    values = [
                        batchId,
                        result.url,
                        result.status || 'completed',
                        result.productCount || result.products?.length || 0,
                        result.error || null,
                        new Date()
                    ];
                    
                    await this.pool.query(insertQuery, values);
                }
            } else {
                // Insert without batch_id column
                insertQuery = `
                    INSERT INTO scrape_logs (url, status, product_count, error_message, created_at)
                    VALUES ($1, $2, $3, $4, $5)
                `;
                
                for (const result of results) {
                    values = [
                        result.url,
                        result.status || 'completed',
                        result.productCount || result.products?.length || 0,
                        result.error || null,
                        new Date()
                    ];
                    
                    await this.pool.query(insertQuery, values);
                }
            }

            console.log(`✅ Logged ${results.length} scrape results to database`);
            
        } catch (error) {
            console.error('❌ Error logging scrape results:', error.message);
            
            // Fallback: try to log without batch_id if the error is column-related
            if (error.message.includes('batch_id') && error.message.includes('does not exist')) {
                console.log('🔄 Retrying without batch_id column...');
                
                try {
                    const fallbackQuery = `
                        INSERT INTO scrape_logs (url, status, product_count, error_message, created_at)
                        VALUES ($1, $2, $3, $4, $5)
                    `;
                    
                    for (const result of results) {
                        const fallbackValues = [
                            result.url,
                            result.status || 'completed',
                            result.productCount || result.products?.length || 0,
                            result.error || null,
                            new Date()
                        ];
                        
                        await this.pool.query(fallbackQuery, fallbackValues);
                    }
                    
                    console.log(`✅ Logged ${results.length} scrape results (fallback method)`);
                    
                } catch (fallbackError) {
                    console.error('❌ Fallback logging also failed:', fallbackError.message);
                }
            }
        }
    }

    // Enhanced processResults function to handle errors better
    async processResults(results, batchId) {
        console.log(`📊 Processing batch ${batchId} results: ${results.length} total records`);
        
        if (results.length === 0) {
            console.log('⚠️ No results to process');
            return;
        }

        try {
            // Log results to database
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
            
            // Save products to database if any found
            if (totalProducts > 0) {
                await this.saveProductsToDatabase(successfulResults, batchId);
            }
            
        } catch (error) {
            console.error('❌ Error processing results:', error.message);
        }
    }

    // Helper function to safely save products
    async saveProductsToDatabase(results, batchId) {
        try {
            const insertProductQuery = `
                INSERT INTO products (batch_id, url, name, price, sku, description, image_url, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (sku) DO UPDATE SET
                price = EXCLUDED.price,
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                image_url = EXCLUDED.image_url,
                updated_at = CURRENT_TIMESTAMP
            `;
            
            let savedCount = 0;
            
            for (const result of results) {
                if (result.products && result.products.length > 0) {
                    for (const product of result.products) {
                        try {
                            await this.pool.query(insertProductQuery, [
                                batchId,
                                result.url,
                                product.name || '',
                                product.price || '',
                                product.sku || `auto-${Date.now()}-${savedCount}`,
                                product.description || '',
                                product.imageUrl || '',
                                new Date()
                            ]);
                            savedCount++;
                        } catch (productError) {
                            console.error('Error saving product:', productError.message);
                        }
                    }
                }
            }
            
            console.log(`✅ Saved ${savedCount} products to database`);
            
        } catch (error) {
            console.error('❌ Error saving products:', error.message);
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
                console.log('📊 Dashboard available');
                
                // Log memory usage
                const memUsage = process.memoryUsage();
                console.log('💾 Memory usage:', {
                    heapUsed: formatMB(memUsage.heapUsed),
                    heapTotal: formatMB(memUsage.heapTotal),
                    rss: formatMB(memUsage.rss)
                });
            });

            // Initialize database and setup scheduler
            await this.initializeDatabase();
            this.setupScheduler();
            
            console.log(`✅ Weekly batch scraper initialized with ${this.urlsToMonitor.length} URLs`);
            console.log(`⚙️ Config: ${this.config.batchSize} URLs per batch, ${this.config.delayBetweenRequests / 1000}s delay`);

            // Start initial batch if requested
            if (process.env.START_IMMEDIATE === 'true') {
                console.log('🎯 Starting immediate batch...');
                const batchId = `startup_${Date.now()}`;
                setTimeout(() => this.startWeeklyBatch(batchId), 5000);
            }

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
