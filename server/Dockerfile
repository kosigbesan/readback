# Anywhere that runs containers: Fly, Railway, Cloud Run, a VPS.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "start.js"]
