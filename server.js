const express = require('express');

console.log('🚀 Starting minimal test server...');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

app.get('/', (req, res) => {
    console.log('✅ Health check received');
    res.json({
        status: 'Test server active',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.get('/test', (req, res) => {
    res.send(`
        <html>
        <head><title>Railway Test</title></head>
        <body>
            <h1>🎉 Railway Deployment Working!</h1>
            <p>Server started successfully at ${new Date().toISOString()}</p>
            <p>Port: ${port}</p>
            <p>Environment: ${process.env.NODE_ENV || 'development'}</p>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`✅ Test server running on port ${port}`);
    console.log('📊 Test page available at /test');
});

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down...');
    process.exit(0);
});
