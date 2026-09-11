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
    if (await page.locator('[data-bui-trap-root]').first().isVisible({ timeout: 2000 })) {
      const closeBtn = page.locator('[data-bui-trap-root] button').first();
      await closeBtn.click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
      await page.waitForTimeout(300);
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

// Booking simplemente resalta su primera sugerencia por defecto, que no
// siempre es la mejor coincidencia real (p.ej. buscando "Plaza" propone antes
// un "Riu Plaza New York" que "The Plaza", el hotel famoso). En vez de
// quedarnos con la primera, leemos la respuesta interna de autocompletado
// (la misma que usa la propia caja de busqueda) y elegimos la sugerencia cuyo
// nombre encaja mejor con lo que pidio el cliente antes de pulsar Enter.
// El autocompletado de Booking no siempre responde igual de bien a la misma
// busqueda (a veces trae una lista floja/irrelevante sin motivo aparente).
// Encapsulamos un solo intento aqui para poder reintentarlo antes de rendirnos.
async function captureAutocomplete(page, destInput, query) {
  const responses = [];
  const onResponse = (r) => {
    if (/dml\/graphql/i.test(r.url()) && r.status() === 200) responses.push(r);
  };
  page.on('response', onResponse);
  await destInput.fill('');
  await destInput.fill(query);
  await page.waitForTimeout(1800);
  page.off('response', onResponse);

  if (responses.length === 0) return [];
  try {
    const json = await responses[responses.length - 1].json();
    return json?.data?.autoCompleteSuggestions?.results ?? [];
  } catch {
    return [];
  }
}

async function selectBestDestination(page, destInput, query, { preferArea = false } = {}) {
  const fallback = async () => {
    await destInput.press('ArrowDown');
    await destInput.press('Enter');
    return null;
  };

  let results = await captureAutocomplete(page, destInput, query);
  let nyResults = results.filter((r) => {
    const label = (r.displayInfo?.label ?? '').toLowerCase();
    return /new york|nueva york/.test(label) && r.destination?.countryCode === 'us';
  });

  // Si la primera pasada no trajo nada util (ni resultados, ni ninguno de
  // verdad en Nueva York), reintentamos una vez mas antes de rendirnos - suele
  // bastar para las respuestas flojas puntuales de Booking.
  if (nyResults.length === 0) {
    await page.waitForTimeout(500);
    results = await captureAutocomplete(page, destInput, query);
    nyResults = results.filter((r) => {
      const label = (r.displayInfo?.label ?? '').toLowerCase();
      return /new york|nueva york/.test(label) && r.destination?.countryCode === 'us';
    });
  }

  if (results.length === 0) return fallback();

  // Si NINGUNA sugerencia es de verdad de Nueva York (ni siquiera tras
  // reintentar), NUNCA hay que caer en "usar lo que sea" - eso es justo lo que
  // mando a un cliente real a un hotel en Estambul o Dubai buscando "el
  // Plaza". Mejor no encontrar nada que encontrar el hotel equivocado en la
  // ciudad equivocada.
  if (nyResults.length === 0) {
    return { notFoundInNewYork: true };
  }

  // Si el cliente ha dicho explicitamente que no quiere un hotel concreto
  // (preferArea), se descartan las sugerencias de tipo HOTEL antes de
  // puntuar. Sin esto, una zona como "Brooklyn" o "Chelsea" casi siempre
  // "pierde" contra un hotel real que coincide por nombre (p.ej. "Sheraton
  // Brooklyn", "Renaissance ... Chelsea Hotel"), y el cliente nunca consigue
  // la busqueda por zona que pidio. Si tras filtrar no queda ningun
  // candidato de zona, se sigue con la lista completa - mejor encontrar
  // algo que no encontrar nada.
  let candidates = nyResults;
  if (preferArea) {
    const areaCandidates = nyResults.filter((r) => r.destination?.destType !== 'HOTEL');
    if (areaCandidates.length > 0) candidates = areaCandidates;
  }
  const candidateIndexOf = (r) => results.indexOf(r);

  const effectiveQueryWords = computeEffectiveWords(
    query,
    candidates.map((r) => r.displayInfo?.title ?? '')
  );

  const scored = candidates.map((r) => {
    const title = (r.displayInfo?.title ?? '').toLowerCase();
    const titleWords = relevantWords(title);
    const score = effectiveQueryWords.reduce((acc, w) => acc + (titleWords.includes(w) ? 1 : 0), 0);
    const coverage =
      titleWords.length > 0 ? titleWords.filter((w) => effectiveQueryWords.includes(w)).length / titleWords.length : 0;
    return { r, score, coverage };
  });

  let best = scored[0];
  scored.forEach((s) => {
    if (s.score > best.score || (s.score === best.score && s.coverage > best.coverage)) best = s;
  });

  // Si dos o mas hoteles DISTINTOS empatan en lo bien que encajan (incluido el
  // caso de que ninguno encaje en absoluto), no tenemos una base real para
  // elegir uno en vez de otro sin mas contexto. En vez de arriesgarnos a un
  // desempate silencioso que puede acertar o no, ofrecemos 2-3 opciones
  // reales de Nueva York y que el cliente elija.
  const tiedHotels = scored.filter(
    (s) => s.score === best.score && s.coverage === best.coverage && s.r.destination?.destType === 'HOTEL'
  );
  const distinctTiedIds = new Set(tiedHotels.map((s) => s.r.destination?.destId));
  if (distinctTiedIds.size >= 2) {
    return {
      needsDisambiguation: true,
      options: tiedHotels.slice(0, 3).map((s) => s.r.displayInfo?.title).filter(Boolean),
    };
  }

  const destType = best.r.destination?.destType ?? null;
  const wasSpecificHotel = destType === 'HOTEL';
  const destId = best.r.destination?.destId ?? null;
  const hotelName = best.r.displayInfo?.title ?? null;
  const bestIndex = candidateIndexOf(best.r);
  for (let i = 0; i <= bestIndex; i++) {
    await destInput.press('ArrowDown');
    await page.waitForTimeout(150);
  }
  await destInput.press('Enter');
  return { wasSpecificHotel, destId, destType, hotelName };
}

// Titi Hotels solo trabaja Nueva York; si el cliente da un nombre ambiguo sin
// contexto de ciudad ("Plaza", "Row"...), forzamos "New York" para que la
// busqueda no se vaya a una propiedad homonima en otra ciudad.
function scopeToNewYork(query) {
  if (/new york|nueva york|\bnyc\b/i.test(query)) return query;
  return `${query} New York`;
}

// Solo la parte de "elegir destino" de la busqueda (home -> calentar ->
// escribir -> autocompletado). Separado de runRealSearch para poder
// reutilizarlo en resolveHotelId, que solo necesita identificar el hotel
// (para RapidAPI) sin llegar a elegir fechas ni pulsar Buscar - mucho mas
// rapido que una busqueda completa.
async function openAndSelectDestination(page, query, { preferArea = false } = {}) {
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

  // El modal de "Genius / inicia sesion" puede aparecer con retraso (a veces
  // justo despues del scroll de calentamiento), tapando el buscador. Lo
  // cerramos otra vez aqui, justo antes de clicar, y reintentamos si aun asi
  // el clic falla por el overlay.
  await dismissOverlays(page);
  await page.waitForTimeout(300);

  const destInput = page.locator('input[name="ss"]').first();
  try {
    await destInput.click({ timeout: 8000 });
  } catch {
    await dismissOverlays(page);
    await page.waitForTimeout(500);
    await destInput.click({ timeout: 8000, force: true });
  }
  await destInput.fill('');
  const destinationResult = await selectBestDestination(page, destInput, query, { preferArea });
  return destinationResult;
}

async function runRealSearch(page, { query, checkin, checkout, preferArea = false }) {
  const destinationResult = await openAndSelectDestination(page, query, { preferArea });
  if (destinationResult?.needsDisambiguation || destinationResult?.notFoundInNewYork) {
    return destinationResult;
  }
  await page.waitForTimeout(800);

  await pickCalendarDate(page, checkin);
  await pickCalendarDate(page, checkout);
  await page.waitForTimeout(500);

  const submit = page.getByRole('button', { name: /Buscar/i }).first();
  await submit.click({ timeout: 10000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);

  return {
    wasSpecificHotel: Boolean(destinationResult?.wasSpecificHotel),
    destId: destinationResult?.destId ?? null,
    hotelName: destinationResult?.hotelName ?? null,
  };
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

// "hotel"/"the" son ruido puro, se quitan siempre. "new"/"york"/"nyc" NO se
// quitan de forma fija: normalmente son relleno de ubicacion (todo en esta
// pagina ya es de Nueva York), pero a veces son parte real del nombre de
// marca del hotel (p.ej. "Row NYC", "Riu Plaza New York"). Cuales son "de
// relleno" depende de cada busqueda en concreto - ver computeEffectiveWords.
const STOPWORDS = new Set(['hotel', 'the']);

function relevantWords(text) {
  return text
    .toLowerCase()
    .split(/[\s,.-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Si una palabra de la busqueda aparece en la mayoria de los nombres que
// estamos comparando, no aporta nada para distinguir entre ellos (es "de
// relleno" para este conjunto concreto) - la quitamos. Si solo aparece en
// uno o dos, es probable que sea parte real del nombre de un hotel concreto
// y la dejamos contar a su favor.
function computeEffectiveWords(query, candidateTexts) {
  const rawWords = relevantWords(query);
  const candidateWordSets = candidateTexts.map((t) => relevantWords(t));
  const generic = new Set(
    rawWords.filter((w) => candidateWordSets.filter((words) => words.includes(w)).length / candidateWordSets.length > 0.6)
  );
  const filtered = rawWords.filter((w) => !generic.has(w));
  return filtered.length > 0 ? filtered : rawWords;
}

function scoreMatch(text, queryWords) {
  const words = relevantWords(text);
  return queryWords.reduce((acc, w) => acc + (words.includes(w) ? 1 : 0), 0);
}

// Que dos tarjetas empaten en numero de palabras coincidentes no significa que
// sean igual de buenas: "The Plaza, A Fairmont Hotel" y "Club Quarters Hotel
// ...New York" pueden empatar en "hotel"+"new york", pero el primero tiene
// mucha menos "paja" ajena a la busqueda. Preferir el precio mas barato en
// ese empate elegia sistematicamente el hotel equivocado cuando habia
// coincidencia de nombre. Medimos que fraccion del nombre de la tarjeta
// esta explicada por las palabras de la busqueda.
function titleCoverage(text, queryWords) {
  const words = relevantWords(text);
  if (words.length === 0) return 0;
  const matched = words.filter((w) => queryWords.includes(w)).length;
  return matched / words.length;
}

// Booking ya prioriza/pinea el hotel buscado entre las primeras tarjetas, asi
// que no hace falta recorrer las ~25-28 de toda la ciudad: nos limitamos a las
// primeras (MAX_CARDS) y hacemos toda la extraccion en una sola llamada de
// browser -> node (en vez de una ronda de ida y vuelta por cada dato de cada
// tarjeta), para no cargar de mas un contenedor con poca RAM.
const MAX_CARDS = 8;

async function extractBestCard(page, query, { requireNameMatch = false } = {}) {
  await page.waitForSelector('[data-testid="property-card"]', { timeout: 20000 });

  const rawCards = await page.evaluate((max) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="property-card"]')).slice(0, max);
    return cards.map((card) => {
      const name = card.querySelector('[data-testid="title"]')?.innerText ?? null;
      const priceText = card.querySelector('[data-testid="price-and-discounted-price"]')?.innerText ?? null;
      const fullText = card.innerText ?? '';
      return { name, priceText, fullText };
    });
  }, MAX_CARDS);

  const queryWords = computeEffectiveWords(
    query,
    rawCards.map((c) => c.name ?? '')
  );
  let bestMatch = null;
  let cheapestOverall = null;

  rawCards.forEach((raw, i) => {
    const { name, priceText, fullText } = raw;
    if (!priceText || !name) return;

    const numeric = Number(priceText.replace(/[^\d]/g, ''));
    if (!Number.isFinite(numeric) || numeric <= 0) return;

    const breakfastMentioned = /desayuno/i.test(fullText);

    let extraChargesNotice = null;
    const lines = fullText.split('\n');
    const priceLineIdx = lines.findIndex((l) => /^Precio /.test(l));
    const feeLine = lines.slice(priceLineIdx + 1, priceLineIdx + 3).find((l) => /impuesto|cargo|tasa/i.test(l));
    if (feeLine && !/^Incluye impuestos y cargos$/i.test(feeLine.trim())) {
      extraChargesNotice = feeLine.trim();
    }

    const matchScore = scoreMatch(name, queryWords);
    const coverage = titleCoverage(name, queryWords);
    const entry = { name, priceText, numeric, breakfastMentioned, extraChargesNotice, matchScore, coverage, cardIndex: i };

    // Cuando se busca un hotel concreto, "algo de coincidencia" no basta - dos
    // hoteles en el mismo barrio comparten palabras como "times"/"square" sin
    // ser el mismo sitio. Exigimos que casi TODAS las palabras distintivas de
    // la busqueda (las que ya sobrevivieron el filtro de palabras genericas)
    // aparezcan en esta tarjeta - no basta con que la tarjeta tenga una de
    // ellas entre otro monton de palabras propias de su nombre.
    const queryCoverage = queryWords.length > 0 ? matchScore / queryWords.length : 0;
    const passesBar = requireNameMatch ? queryCoverage >= 0.75 : matchScore > 0;

    if (
      passesBar &&
      (!bestMatch || matchScore > bestMatch.matchScore || (matchScore === bestMatch.matchScore && coverage > bestMatch.coverage))
    ) {
      bestMatch = entry;
    }
    if (!cheapestOverall || numeric < cheapestOverall.numeric) {
      cheapestOverall = entry;
    }
  });

  // Si buscabamos un hotel concreto y NINGUNA tarjeta coincide con su nombre,
  // es que ese hotel no tiene disponibilidad para esas fechas y Booking esta
  // mostrando alternativas en su lugar. Devolver la mas barata de esas
  // alternativas como si fuera el hotel pedido es justo lo que ha confundido
  // a mas de un cliente ("pedi el Millennium y me dio otro hotel"). Mejor
  // decir claramente que no hay disponibilidad en ESE hotel.
  if (requireNameMatch && !bestMatch) return null;

  const chosen = bestMatch ?? cheapestOverall;
  if (!chosen) return null;

  const card = page.locator('[data-testid="property-card"]').nth(chosen.cardIndex);
  return { ...chosen, card };
}

// Variante de extractBestCard para cuando NO hay un hotel concreto que
// buscar (preferArea) y RapidAPI no pudo dar varias opciones (p.ej. porque
// Booking resolvio la zona como "latlong" - un punto de un landmark como
// "Times Square" - y RapidAPI no acepta ese tipo de destino). En vez de
// elegir un unico "mejor" resultado, devuelve las `limit` tarjetas mas
// baratas tal cual, para que el cliente siga viendo varias opciones reales
// de la zona en vez de una sola elegida al azar.
async function extractTopCards(page, { limit = 3 } = {}) {
  await page.waitForSelector('[data-testid="property-card"]', { timeout: 20000 });

  const rawCards = await page.evaluate((max) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="property-card"]')).slice(0, max);
    return cards.map((card) => {
      const name = card.querySelector('[data-testid="title"]')?.innerText ?? null;
      const priceText = card.querySelector('[data-testid="price-and-discounted-price"]')?.innerText ?? null;
      const fullText = card.innerText ?? '';
      return { name, priceText, fullText };
    });
  }, MAX_CARDS);

  const entries = [];
  rawCards.forEach((raw, i) => {
    const { name, priceText, fullText } = raw;
    if (!priceText || !name) return;
    const numeric = Number(priceText.replace(/[^\d]/g, ''));
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    const breakfastMentioned = /desayuno/i.test(fullText);
    let extraChargesNotice = null;
    const lines = fullText.split('\n');
    const priceLineIdx = lines.findIndex((l) => /^Precio /.test(l));
    const feeLine = lines.slice(priceLineIdx + 1, priceLineIdx + 3).find((l) => /impuesto|cargo|tasa/i.test(l));
    if (feeLine && !/^Incluye impuestos y cargos$/i.test(feeLine.trim())) {
      extraChargesNotice = feeLine.trim();
    }
    entries.push({ name, priceText, numeric, breakfastMentioned, extraChargesNotice, cardIndex: i });
  });

  entries.sort((a, b) => a.numeric - b.numeric);
  const top = entries.slice(0, limit);

  const withPolicies = [];
  for (const entry of top) {
    const card = page.locator('[data-testid="property-card"]').nth(entry.cardIndex);
    const cancellationPolicy = await extractCancellationPolicy(card);
    withPolicies.push({ ...entry, cancellationPolicy });
  }
  return withPolicies;
}

async function extractCancellationPolicy(cardLocator) {
  try {
    const el = cardLocator.locator('text=/Cancelaci[oó]n gratuita|No reembolsable/i').first();
    return await el.innerText({ timeout: 1500 });
  } catch {
    return null;
  }
}

// Lanzamiento de navegador/contexto compartido entre checkBookingPrice
// (busqueda completa) y resolveHotelId (solo identificar el hotel, mas
// ligero) - misma configuracion anti-deteccion y de ahorro de memoria en
// ambos casos.
async function launchContext(headless) {
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
      // Recorte de memoria para contenedores pequeños (Render free = 512MB):
      // sin GPU, sin extensiones, sin trafico de fondo que no necesitamos.
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
      '--no-zygote',
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

  // Solo necesitamos el texto de la pagina (precios, nombres...), no como se ve,
  // ni sus mapas, anuncios o rastreadores. Bloquear todo eso reduce mucho el
  // consumo de memoria de Chromium, critico en un contenedor con RAM limitada
  // como el de Render.
  const BLOCKED_HOST_PATTERNS = [
    'maps.googleapis.com',
    'maps.gstatic.com',
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'googlesyndication.com',
    'facebook.net',
    'facebook.com',
    'criteo.com',
    'adnxs.com',
    'yieldlab.net',
    'trustpilot.com',
  ];
  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === 'image' || type === 'media' || type === 'font') {
      return route.abort();
    }
    if (BLOCKED_HOST_PATTERNS.some((h) => req.url().includes(h))) {
      return route.abort();
    }
    return route.continue();
  });

  return { browser, context };
}

/**
 * Version ligera: solo identifica el hotel (destId de Booking, que coincide
 * con el hotel_id que usa RapidAPI para hoteles) sin llegar a elegir fechas
 * ni pulsar Buscar. Mucho mas rapida que checkBookingPrice completo - se usa
 * para poder consultar despues el precio via RapidAPI en vez de scrapear.
 * @param {{query:string, headless?:boolean, preferArea?:boolean}} params
 */
export async function resolveHotelId({ query, headless = true, preferArea = false }) {
  const scopedQuery = scopeToNewYork(query);
  const { browser, context } = await launchContext(headless);
  const page = await context.newPage();
  try {
    const destinationResult = await openAndSelectDestination(page, scopedQuery, { preferArea });
    if (destinationResult?.needsDisambiguation) {
      return { needsDisambiguation: true, options: destinationResult.options };
    }
    if (destinationResult?.notFoundInNewYork) {
      return { notFoundInNewYork: true };
    }
    return {
      hotelId: destinationResult?.destId ?? null,
      hotelName: destinationResult?.hotelName ?? null,
      wasSpecificHotel: Boolean(destinationResult?.wasSpecificHotel),
      // Tipo de destino tal cual lo da Booking (HOTEL, CITY, DISTRICT,
      // LANDMARK...). Cuando no es un hotel concreto, priceChecker.js lo usa
      // para pedirle a RapidAPI varias opciones DENTRO de esa misma zona/
      // ciudad en vez de tener que adivinar por palabras clave.
      destType: destinationResult?.destType ?? null,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Consulta Booking.com y devuelve el precio mas barato que cumple los criterios.
 * @param {{query:string, checkin:string, checkout:string, adults?:string, rooms?:string, breakfast?:boolean, headless?:boolean, preferArea?:boolean}} params
 */
export async function checkBookingPrice({ query, checkin, checkout, adults = '2', rooms = '1', breakfast = false, headless = true, preferArea = false }) {
  if (!query || !checkin || !checkout) {
    throw new Error('query, checkin y checkout son obligatorios');
  }
  // El "New York" que añadimos nosotros es solo para que la busqueda de
  // destino no se vaya a otra ciudad - no debe contar a la hora de decidir
  // que TARJETA de resultados es el hotel pedido (si no, "new"/"york" infla
  // artificialmente la puntuacion de cualquier alternativa cuyo nombre las
  // incluya, diluyendo lo que de verdad distingue al hotel).
  const nameForMatching = query;
  query = scopeToNewYork(query);

  const { browser, context } = await launchContext(headless);
  const page = await context.newPage();

  try {
    const searchOutcome = await runRealSearch(page, { query, checkin, checkout, preferArea });
    if (searchOutcome?.needsDisambiguation) {
      return { found: false, needsDisambiguation: true, options: searchOutcome.options };
    }
    if (searchOutcome?.notFoundInNewYork) {
      return { found: false, notFoundInNewYork: true, reason: 'No se ha encontrado ese hotel en Nueva York' };
    }

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

    // preferArea sin hotel concreto resuelto: en vez de elegir un unico
    // "mejor" resultado (que seria arbitrario, no hay nombre con el que
    // comparar), se devuelven varias opciones reales de la zona - mismo
    // shape que usa el multiple:true de RapidAPI, para que el widget las
    // pinte igual sin cambios.
    if (preferArea && !searchOutcome?.wasSpecificHotel) {
      const topCards = await extractTopCards(page, { limit: 3 });
      if (topCards.length === 0) {
        return { found: false, reason: 'Sin resultados con disponibilidad para esos criterios', sourceUrl: page.url() };
      }
      return {
        found: true,
        multiple: true,
        breakfastRequested: breakfast,
        hotels: topCards.map((c) => ({
          found: true,
          hotel: c.name,
          totalPrice: c.priceText,
          breakfastMentionedOnCard: c.breakfastMentioned,
          extraChargesNotice: c.extraChargesNotice,
          cancellationPolicy: c.cancellationPolicy,
          checkin,
          checkout,
          adults,
          rooms,
        })),
        sourceUrl: page.url(),
      };
    }

    const best = await extractBestCard(page, nameForMatching, { requireNameMatch: searchOutcome?.wasSpecificHotel });
    if (!best) {
      const reason = searchOutcome?.wasSpecificHotel
        ? 'Ese hotel en concreto no tiene disponibilidad para esas fechas'
        : 'Sin resultados con disponibilidad para esos criterios';
      return { found: false, reason, sourceUrl: page.url() };
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
