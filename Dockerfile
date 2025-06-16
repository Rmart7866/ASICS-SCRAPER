# Use Node.js 20 slim image for smaller size
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files first (for better Docker layer caching) 
COPY package*.json ./

# Install dependencies
# No browser downloads needed since we use external Browserless!
RUN npm install --omit=dev && npm cache clean --force

# Copy application code
COPY . .

# Create non-root user for security
RUN groupadd -r scraper && useradd -r -g scraper scraper
RUN chown -R scraper:scraper /app
USER scraper

# Expose port
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:10000/ || exit 1

# Set default environment variables
ENV NODE_ENV=production


# Start the application
CMD ["node", "server.js"]
