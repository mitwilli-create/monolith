# MONOLITH — lean hosted deploy (Sprint B).
# tsx runs the TypeScript server directly (matches local npm start); the
# frontend bundle is built at image build time. User data lives OUTSIDE the
# image on a mounted volume: set MONOLITH_DATA_DIR to the mount point.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY seed ./seed
COPY public ./public
COPY scripts ./scripts
RUN npm run build

ENV NODE_ENV=production
# Safe with a public bind ONLY because config.ts refuses to start on a
# non-loopback bind without both Clerk keys: a container missing its
# secrets exits instead of serving an unauthenticated API.
ENV MONOLITH_BIND=0.0.0.0
ENV MONOLITH_PORT=4600
EXPOSE 4600

CMD ["npx", "tsx", "src/server.ts"]
