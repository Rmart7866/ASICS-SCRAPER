const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 ASICS Scraper</h1>
        <p>Basic app is running!</p>
        <p>Database connection will be added next.</p>
    `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
