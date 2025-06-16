#!/bin/bash

echo "🚀 Starting ASICS Scraper with Self-Hosted Browserless..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    echo "Visit: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not available. Please install Docker Compose."
    exit 1
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating from template..."
    cp .env.example .env
    echo "📝 Please edit .env file with your actual credentials:"
    echo "   - ASICS_USERNAME"
    echo "   - ASICS_PASSWORD" 
    echo "   - DATABASE_URL"
    echo ""
    echo "Then run this script again."
    exit 1
fi

# Stop any existing containers
echo "🛑 Stopping existing containers..."
docker-compose down

# Build and start services
echo "🏗️  Building and starting services..."
docker-compose up -d --build

# Wait for services to start
echo "⏳ Waiting for services to start..."
sleep 10

# Check if Browserless is running
echo "🧪 Testing Browserless connection..."
if curl -f http://localhost:3000/json/version > /dev/null 2>&1; then
    echo "✅ Browserless is running!"
else
    echo "❌ Browserless connection failed"
    docker-compose logs browserless
    exit 1
fi

# Check if ASICS scraper is running
echo "🧪 Testing ASICS scraper..."
if curl -f http://localhost:10000/ > /dev/null 2>&1; then
    echo "✅ ASICS scraper is running!"
else
    echo "❌ ASICS scraper connection failed"
    docker-compose logs asics-scraper
    exit 1
fi

echo ""
echo "🎉 Success! Your ASICS scraper is now running:"
echo "   📊 Dashboard: http://localhost:10000/dashboard"
echo "   🎭 Browserless: http://localhost:3000"
echo ""
echo "🔧 Useful commands:"
echo "   View logs: docker-compose logs -f"
echo "   Stop services: docker-compose down"
echo "   Restart: docker-compose restart"
echo ""
echo "Happy scraping! 🕷️"
