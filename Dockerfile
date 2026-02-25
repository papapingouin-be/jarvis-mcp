FROM node:20-alpine

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev || npm install

# Copy sources
COPY . .

# Build if project has build script
RUN npm run build || true

EXPOSE 7010

# Default: run dev/start if present, else keep container alive (you will adjust once MCP server is wired)
CMD sh -lc 'npm run start 2>/dev/null || npm run dev 2>/dev/null || tail -f /dev/null'
