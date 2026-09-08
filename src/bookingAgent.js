// Nucleo del agente de Booking (componente 3), embebido aqui para que el backend
// del chat sea un unico servicio autocontenido y facil de desplegar. La version
// "suelta" para pruebas de linea de comandos vive en el repo hermano
// titi-hotels-booking-agent (mismo codigo).
//
// Nota tecnica: Booking.com redirige cualquier acceso "en frio" a sus resultados
// (URL construida a mano, sin pasar antes por su propia home) a una pagina generica
// de SEO de la ciudad, sin precios filtrados. Hace falta reproducir una sesion de
// busqueda real: cargar la home, "calentarla" un poco, escribir el destino, dejar que
// su propio autocompletado resuelva el hotel, elegir fechas en su calendario y pulsar
// Buscar. Con eso, y ocultando las señales mas obvias de automatizacion (navigator.webdriver,
// user-agent por defecto de Chromium), se llega a resultados reales de forma fiable.

import { chromium } from 'playwright';

async function dismissOverlays(page) {
  const candidates = ['button:has-text("Aceptar")', '#onetrust-accept-btn-handler'];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1200 })) await el.click({ timeout: 1200 });
    } catch {
      // overlay no presente, seguimos
    }
  }
  try {
    if (await page.locator('[data-bui-trap-root]').first().isVisible({ timeout: 1200 })) {
      const closeBtn = page.locator('[data-bui-trap-root] button').first();
      await closeBtn.click({ timeout: 1200 }).catch(() => page.keyboard.press('Escape'));
    }
  } catch {
    // sin modal atrapando el foco
  }
}

async function pickCalendarDate(page, isoDate) {
  const cell = page.locator(`[data-date="${isoDate}"]`).first();
  await cell.waitFor({ state: 'visible', timeout: 8000 });
  await cell.click();
  await page.waitForTimeout(300);
}

async function runRealSearch(page, { query, checkin, checkout }) {
  await page.goto('https://www.booking.com/index.es.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await dismissOverlays(page);
  await page.waitForTimeout(500);
  await dismissOverlays(page);

  await page.mouse.move(400, 300);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(1000);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1200);

  const destInput = page.locator('input[name="ss"]').first();
  await destInput.click({ timeout: 10000 });
  await destInput.fill('');
  await destInput.type(query, { delay: 90 });
  await page.waitForTimeout(1200);

  const suggestions = page.locator('[data-testid="autocomplete-result"]:visible, li[role="option"]:visible');
  await suggestions.first().waitFor({ state: 'visible', timeout: 10000 });
  await destInput.press('ArrowDown');
  await page.waitForTimeout(250);
  await destInput.press('Enter');
  await page.waitForTimeout(800);

  await pickCalendarDate(page, checkin);
  await pickCalendarDate(page, checkout);
  await page.waitForTimeout(500);

  const submit = page.getByRole('button', { name: /Buscar/i }).first();
  await submit.click({ timeout: 10000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

async function applyBreakfastFilter(page) {
  const filterText = page.getByText(/Desayuno incluido/i).first();
  try {
    await filterText.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    return true;
  } catch {
    return false;
  }
}

function scoreMatch(text, queryWords) {
  const lower = text.toLowerCase();
  return queryWords.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
}

async function extractBestCard(page, query) {
  await page.waitForSelector('[data-testid="property-card"]', { timeout: 20000 });
  const cards = page.locator('[data-testid="property-card"]');
  const count = await cards.count();
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  let bestMatch = null;
  let cheapestOverall = null;

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    let name = null;
    let priceText = null;
    try {
      name = await card.locator('[data-testid="title"]').first().innerText({ timeout: 2000 });
    } catch {}
    try {
      priceText = await card.locator('[data-testid="price-and-discounted-price"]').first().innerText({ timeout: 2000 });
    } catch {}
    if (!priceText || !name) continue;

    const numeric = Number(priceText.replace(/[^\d]/g, ''));
    if (!Number.isFinite(numeric) || numeric <= 0) continue;

    let breakfastMentioned = false;
    try {
      const bfText = await card.locator('text=/desayuno/i').first().innerText({ timeout: 600 });
      breakfastMentioned = /desayuno/i.test(bfText);
    } catch {}

    let extraChargesNotice = null;
    try {
      const cardText = await card.innerText({ timeout: 1000 });
      const priceLineIdx = cardText.split('\n').findIndex((l) => /^Precio /.test(l));
      const feeLine = cardText
        .split('\n')
        .slice(priceLineIdx + 1, priceLineIdx + 3)
        .find((l) => /impuesto|cargo|tasa/i.test(l));
      if (feeLine && !/^Incluye impuestos y cargos$/i.test(feeLine.trim())) {
        extraChargesNotice = feeLine.trim();
      }
    } catch {}

    const matchScore = scoreMatch(name, queryWords);
    const entry = { name, priceText, numeric, breakfastMentioned, extraChargesNotice, matchScore, card };

    if (matchScore > 0 && (!bestMatch || matchScore > bestMatch.matchScore || (matchScore === bestMatch.matchScore && numeric < bestMatch.numeric))) {
      bestMatch = entry;
    }
    if (!cheapestOverall || numeric < cheapestOverall.numeric) {
      cheapestOverall = entry;
    }
  }

  return bestMatch ?? cheapestOverall;
}

async function extractCancellationPolicy(cardLocator) {
  try {
    const el = cardLocator.locator('text=/Cancelaci[oó]n gratuita|No reembolsable/i').first();
    return await el.innerText({ timeout: 1500 });
  } catch {
    return null;
  }
}

/**
 * Consulta Booking.com y devuelve el precio mas barato que cumple los criterios.
 * @param {{query:string, checkin:string, checkout:string, adults?:string, rooms?:string, breakfast?:boolean, headless?:boolean}} params
 */
export async function checkBookingPrice({ query, checkin, checkout, adults = '2', rooms = '1', breakfast = false, headless = true }) {
  if (!query || !checkin || !checkout) {
    throw new Error('query, checkin y checkout son obligatorios');
  }

  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      // Sin esto Chromium no arranca dentro de un contenedor Docker (como en
      // Render): el sandbox de Chrome necesita permisos que el contenedor no da.
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Evita quedarse sin memoria compartida en contenedores con /dev/shm pequeño.
      '--disable-dev-shm-usage',
    ],
  });
  const context = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    await runRealSearch(page, { query, checkin, checkout });

    if (rooms !== '1' || adults !== '2') {
      const url = new URL(page.url());
      url.searchParams.set('group_adults', adults);
      url.searchParams.set('no_rooms', rooms);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    if (breakfast) {
      await applyBreakfastFilter(page);
      await dismissOverlays(page);
    }

    const best = await extractBestCard(page, query);
    if (!best) {
      return { found: false, reason: 'Sin resultados con disponibilidad para esos criterios', sourceUrl: page.url() };
    }

    const cancellationPolicy = await extractCancellationPolicy(best.card);

    return {
      found: true,
      hotel: best.name,
      totalPrice: best.priceText,
      breakfastRequested: breakfast,
      breakfastMentionedOnCard: best.breakfastMentioned,
      extraChargesNotice: best.extraChargesNotice,
      cancellationPolicy,
      checkin,
      checkout,
      adults,
      rooms,
      sourceUrl: page.url(),
    };
  } finally {
    await browser.close();
  }
}
