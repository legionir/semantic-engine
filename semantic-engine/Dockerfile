FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.mjs jest.config.js ./
COPY contracts ./contracts
COPY public ./public
COPY tree-sitter-grammars ./tree-sitter-grammars
COPY bin ./bin
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/bin ./bin
COPY --from=build /app/tree-sitter-grammars ./tree-sitter-grammars

# Generated data goes here by default; mount a volume at /data (see
# structured-ai/docker-compose.yml). The directory is created owned by `node`
# so a named volume inherits usable permissions.
ENV SEMANTIC_ENGINE_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["ui", "--host", "0.0.0.0", "--allow-remote", "--port", "4000"]
