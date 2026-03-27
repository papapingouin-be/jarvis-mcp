FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache \
  bash \
  curl \
  git \
  jq \
  openssh-client \
  python3 \
  rsync \
  sshpass

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache \
  bash \
  curl \
  git \
  jq \
  openssh-client \
  python3 \
  rsync \
  sshpass

COPY package.json package-lock.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/tools ./tools

RUN chmod 755 /app/tools/*.sh \
  && find /app/tools/scripts -type f -name "*.sh" -exec chmod 755 {} +

EXPOSE 7010
CMD ["node", "build/index.js"]
