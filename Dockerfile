FROM oven/bun:1.1.42-slim

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

COPY src ./src

CMD ["bun", "src/index.ts"]
