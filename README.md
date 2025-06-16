# ASICS B2B Scraper with Self-Hosted Browserless

A powerful, automated web scraper for ASICS B2B portal using self-hosted Browserless for reliable browser automation.

## 🚀 Features

- **FREE Browser Automation** - Self-hosted Browserless (no subscription fees)
- **ASICS B2B Authentication** - Automatic login and session management
- **Scheduled Scraping** - Weekly automated batches every Sunday at 2:00 AM
- **Manual Triggers** - On-demand scraping via web dashboard
- **Data Storage** - PostgreSQL database with comprehensive logging
- **Docker Ready** - Complete containerized setup

## 📋 Prerequisites

- Docker and Docker Compose
- ASICS B2B account credentials
- PostgreSQL database (optional - can run in memory mode)

## ⚡ Quick Start

1. **Clone and setup**:
   ```bash
   git clone <your-repo-url>
   cd asics-scraper
   cp .env.example .env
   ```

2. **Configure environment**:
   Edit `.env` file with your credentials:
   ```
   ASICS_USERNAME=your_asics_username
   ASICS_PASSWORD=your_asics_password
   DATABASE_URL=postgresql://user:pass@host:5432/dbname
   ```

3. **Start everything**:
   ```bash
   chmod +x startup.sh
   ./startup.sh
   ```

4. **Access dashboard**:
   - Open http://localhost:10000/dashboard
   - Add your ASICS B2B URLs
   - Click "Trigger Self-Hosted Batch"

## 🐳 Docker Commands

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Restart specific service
docker-compose restart asics-scraper

# Check Browserless status
curl http://localhost:3000/json/version
```

## 🏗️ Architecture

```
┌─────────────────────┐    WebSocket     ┌──────────────────────┐
│   ASICS Scraper     │ ───────────────► │   Browserless        │
│   (Node.js)         │                  │   (Chrome Browser)   │
│   Port: 10000       │                  │   Port: 3000         │
└─────────────────────┘                  └──────────────────────┘
        │                                           │
        │                                           │
        ▼                                           ▼
┌─────────────────────┐                  ┌──────────────────────┐
│    PostgreSQL       │                  │    ASICS B2B         │
│    Database         │                  │    Website           │
└─────────────────────┘                  └──────────────────────┘
```

## 📊 Dashboard Features

- **URL Management** - Add/edit/delete ASICS B2B URLs to monitor
- **Manual Triggers** - Start scraping batches on-demand
- **Connection Testing** - Verify Browserless connectivity
- **Logs Viewing** - Monitor scraping results and errors
- **Status Monitoring** - Real-time system health

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ASICS_USERNAME` | ASICS B2B login username | Yes |
| `ASICS_PASSWORD` | ASICS B2B login password | Yes |
| `DATABASE_URL` | PostgreSQL connection string | No* |
| `BROWSERLESS_ENDPOINT` | Browserless WebSocket URL | No** |
| `NODE_ENV` | Environment (production/development) | No |
| `PORT` | Application port | No |

*If not provided, runs in memory-only mode
**Defaults to `ws://browserless:3000`

### Browserless Configuration

The Browserless container is configured with:
- Max 10 concurrent sessions
- 60-second connection timeout
- Pre-booted Chrome for faster startup
- 2GB memory limit
- Persistent cache volume

## 📅 Scheduling

- **Automatic**: Every Sunday at 2:00 AM (EST)
- **Manual**: Via dashboard "Trigger Batch" button
- **Batch Size**: 5 URLs per batch (configurable)
- **Delays**: 30 seconds between batches, 2 seconds between URLs

## 🔍 Monitored Data

For each scraped URL, the system captures:
- Product names and titles
- Pricing information
- SKU/product IDs
- Product images
- Product links
- Timestamps and batch IDs

## 🚨 Troubleshooting

### Browserless Issues
```bash
# Check if Browserless is running
docker ps | grep browserless

# View Browserless logs
docker logs browserless

# Test connection manually
curl http://localhost:3000/json/version
```

### ASICS Scraper Issues
```bash
# Check scraper logs
docker-compose logs asics-scraper

# Restart scraper only
docker-compose restart asics-scraper

# Test dashboard access
curl http://localhost:10000/
```

### Database Issues
```bash
# Check if database is accessible
docker-compose exec asics-scraper node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT NOW()').then(() => console.log('DB OK')).catch(console.error);
"
```

## 💡 Tips

- **Memory Usage**: Monitor Docker stats with `docker stats`
- **Log Rotation**: Logs are stored in-memory and database
- **URL Testing**: Use dashboard to test individual URLs
- **Scaling**: Increase `MAX_CONCURRENT_SESSIONS` for more parallel browsers
- **Security**: Add `BROWSERLESS_TOKEN` for additional security

## 📈 Performance

- **Startup Time**: ~10-15 seconds for both services
- **Memory Usage**: ~1GB for Browserless, ~100MB for scraper
- **Scraping Speed**: ~30-60 seconds per ASICS page (including login)
- **Concurrency**: Up to 10 simultaneous browser sessions

## 🆘 Support

1. Check logs: `docker-compose logs -f`
2. Test connections via dashboard
3. Verify environment variables in `.env`
4. Ensure ASICS credentials are valid
5. Check Docker and network connectivity

## 📝 License

ISC License - Free for personal and commercial use.
