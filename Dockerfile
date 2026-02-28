# ===== build stage =====
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ===== runtime stage =====
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# only runtime deps
COPY package*.json ./
RUN npm ci --omit=dev

# compiled output
COPY --from=build /app/build ./build

EXPOSE 7010
CMD ["node", "build/index.js"]