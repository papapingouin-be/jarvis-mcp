FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# compiled output + tools wrappers used by MCP
COPY --from=build /app/build ./build
COPY --from=build /app/tools ./tools

EXPOSE 7010
CMD ["node", "build/index.js"]
