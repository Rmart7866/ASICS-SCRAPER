const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Database setup
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
async function testDatabase() {
    try {
        const result = await db.query('SELECT NOW()');
        console.log('✅ Database connected:', result.rows[0].now);
        return true;
    } catch (error) {
        console.error('❌ Database error:', error);
        return false;
    }
}

// Simple dashboard
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>ASICS Scraper</title></head>
        <body style="font-family: Arial; padding: 20px;">
            <h1>🚀 ASICS Auto-Scraper</h1>
            <p><strong>Status:</strong> Running</p>
            <p><strong>Database:</strong> <span id="db-status">Testing...</span></p>
            
            <h3>Next Steps:</h3>
            <ul>
                <li>✅ Basic app running</li>
                <li>🔄 Database connection</li>
                <li>⏳ Add scraping functionality</li>
            </ul>
            
            <script>
                fetch('/api/status')
                    .then(r => r.json())
                    .then(data => {
                        document.getElementById('db-status').textContent = 
                            data.database ? '✅ Connected' : '❌ Failed';
                    });
            </script>
        </body>
        </html>
    `);
});

// API endpoint to test database
app.get('/api/status', async (req, res) => {
    const dbConnected = await testDatabase();
    res.json({
        status: 'running',
        database: dbConnected,
        uptime: Math.floor(process.uptime())
    });
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🚀 ASICS Scraper running on port ${port}`);
    testDatabase();
});
