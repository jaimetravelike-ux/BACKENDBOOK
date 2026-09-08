FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Instala Chromium y las dependencias de sistema que necesita Playwright para
# correr en un contenedor headless.
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "src/server.js"]
