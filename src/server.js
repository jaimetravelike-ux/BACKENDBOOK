// Debe ser el primer import: cualquier modulo importado despues de este ya
// puede leer sus variables de entorno desde .env en local. En Railway no
// hace nada (ya inyecta las variables reales directamente), pero deja el
// proyecto listo para correr igual en un portatil que en produccion.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSession, hasSession, slotsComplete, searchKey } from './sessionStore.js';
import { converse, phraseSearchResult } from './claude.js';
import { checkPrice } from './priceChecker.js';
import { logTurn, logResolved, listConversations, logLead, listLeads, logContact, listContacts, getAnalyticsSummary } from './conversationLog.js';
import { upsertProviderRate, listProviderRates } from './providerRates.js';
import { sendContactNotification } from './mailer.js';
import { lookupGeo, computeTrafficSource, parseUtmParams } from './geoip.js';

// Red de seguridad a nivel de proceso: con todas las rutas ya protegidas por
// su propio try/catch (mas abajo) y con el listener de error del pool de
// Postgres (conversationLog.js / providerRates.js), no deberia llegar nunca
// una excepcion hasta aqui - pero si algo se escapa igualmente, queremos un
// log claro en vez de que Railway solo vea "el proceso murio" sin motivo.
process.on('unhandledRejection', (reason) => {
  console.error('[proceso] promesa rechazada sin capturar (revisar):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[proceso] excepcion sin capturar:', err);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Railway esta detras de un proxy - sin esto, req.ip da la IP interna del
// proxy en vez de la IP real del visitante, y la geolocalizacion sale mal.
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use('/widget', express.static(path.join(__dirname, '..', 'widget')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'test.html')));

const PORT = process.env.PORT || 8787;

app.get('/health', (_req, res) => res.json({ ok: true }));
// Marcador temporal para confirmar sin ambiguedad que un deploy concreto esta
// realmente en produccion (los builds de Railway a veces tardan mucho mas de
// lo esperado, o el auto-deploy no se dispara).
app.get('/version', (_req, res) => res.json({ marker: 'rapidapi-primary-v1' }));

// Un turno de conversacion normal. Si con este mensaje ya se completan los datos
// minimos (hotel/zona + fechas), la respuesta incluye pendingSearch:true - el
// widget entonces llama a /api/chat/resolve para disparar la consulta a Booking.
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId: incomingId, message, referrer, landingUrl } = req.body ?? {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Falta "message"' });
    }
    const sessionId = incomingId || randomUUID();
    const isNewSession = !hasSession(sessionId);
    const session = getSession(sessionId);

    if (isNewSession) {
      // Se calcula solo la primera vez que vemos esta sesion - de donde viene
      // el visitante no cambia turno a turno, y asi no repetimos la llamada
      // de geolocalizacion en cada mensaje.
      const ip = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const geo = await lookupGeo(ip);
      const { utmSource, utmMedium, utmCampaign } = parseUtmParams(landingUrl);
      session.visitorInfo = {
        country: geo.country,
        city: geo.city,
        referrer: referrer || null,
        utmSource,
        utmMedium,
        utmCampaign,
        trafficSource: computeTrafficSource({ referrer, utmSource, utmMedium }),
      };
    }

    const reply = await converse(session, message);

    const key = searchKey(session.slots);
    const readyForSearch = slotsComplete(session.slots) && key !== session.lastSearchedKey && !session.pendingSearch;
    if (readyForSearch) {
      session.pendingSearch = true;
    }

    logTurn(sessionId, session);

    res.json({ sessionId, reply, pendingSearch: readyForSearch });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del chat' });
  }
});

// checkPrice() encadena varias esperas de Playwright que, cada una por
// separado, tiene su propio timeout razonable - pero si Booking se comporta
// mal en varios pasos seguidos (caso degradado, no el habitual), esas esperas
// se suman y el cliente puede quedarse literalmente minutos sin respuesta ni
// error, con la pantalla en blanco. Un limite duro aqui garantiza que el
// widget SIEMPRE recibe una respuesta a tiempo, buena o mala.
const PRICE_CHECK_TIMEOUT_MS = 55000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} supero los ${ms}ms de limite`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// El widget llama aqui justo despues de recibir pendingSearch:true. Puede tardar
// (el agente "navega" Booking de verdad), por eso va en su propia llamada: el
// widget ya mostro el "dame un momento" del turno anterior mientras espera esto.
app.post('/api/chat/resolve', async (req, res) => {
  try {
    const { sessionId } = req.body ?? {};
    const session = getSession(sessionId);
    if (!session.pendingSearch) {
      return res.status(409).json({ error: 'No hay ninguna busqueda pendiente para esta sesion' });
    }

    const { slots } = session;
    const result = await withTimeout(
      checkPrice({
        query: slots.hotelQuery,
        checkin: slots.checkin,
        checkout: slots.checkout,
        adults: slots.adults || '2',
        rooms: slots.rooms || '1',
        breakfast: Boolean(slots.breakfast),
      }),
      PRICE_CHECK_TIMEOUT_MS,
      'checkPrice'
    );

    // Solo se marca la busqueda como "ya hecha" si de verdad se resolvio algo
    // (se encontro precio, o se confirmo que no hay disponibilidad). Una
    // desambiguacion o un "no encontrado en Nueva York" NO es una respuesta
    // real todavia - si se marcara igual, el cliente podria quedarse sin
    // poder volver a buscar dentro de la misma conversacion en cuanto el
    // texto de hotel/zona no cambiara literalmente (p.ej. tras elegir "sin
    // hotel concreto, busca en la zona" despues de una desambiguacion).
    const isRealResolution = !result?.needsDisambiguation && !result?.notFoundInNewYork;
    if (isRealResolution) {
      session.lastSearchedKey = searchKey(slots);
    }
    session.pendingSearch = false;

    const reply = await phraseSearchResult(session, result);

    logResolved(sessionId, session, result);

    res.json({ sessionId, reply, result });
  } catch (err) {
    console.error(err);
    const { sessionId } = req.body ?? {};
    const session = getSession(sessionId);
    session.pendingSearch = false;
    res.status(504).json({ error: 'No se pudo comprobar el precio ahora mismo, tardo demasiado. Intentalo de nuevo en un momento.' });
  }
});

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Control de doble clic / reintento: si llega una peticion con los mismos
// datos en menos de DEDUPE_WINDOW_MS, se trata como la misma solicitud (se
// responde ok sin volver a guardar en BD ni reenviar el email). Basta con
// esto porque ambos formularios son de un solo paso, sin estado que pueda
// "ya estar procesandose" de verdad - el riesgo real es solo el duplicado
// por impaciencia o por un reintento automatico del navegador.
const DEDUPE_WINDOW_MS = 15000;
const recentSubmissions = new Map();

function isDuplicateSubmission(key) {
  const now = Date.now();
  if (recentSubmissions.size > 500) {
    for (const [k, t] of recentSubmissions) {
      if (now - t > DEDUPE_WINDOW_MS) recentSubmissions.delete(k);
    }
  }
  const last = recentSubmissions.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recentSubmissions.set(key, now);
  return false;
}

// Datos de contacto que el cliente deja directamente en la card del hotel
// (nombre + email), en vez de escribirlos por chat.
app.post('/api/lead', async (req, res) => {
  try {
    const { sessionId, name, email, hotel, city, checkin, checkout, adults, rooms, totalPrice } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Falta el nombre' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Email invalido' });
    }

    const dedupeKey = `lead:${sessionId || ''}:${email.trim().toLowerCase()}:${hotel || ''}:${checkin || ''}:${checkout || ''}`;
    if (isDuplicateSubmission(dedupeKey)) {
      return res.status(200).json({ ok: true });
    }

    await logLead({
      sessionId,
      name: name.trim(),
      email: email.trim(),
      hotel,
      city,
      checkin,
      checkout,
      adults,
      rooms,
      totalPrice,
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[api/lead] error', err);
    res.status(500).json({ error: 'No se pudo guardar la solicitud' });
  }
});

// Consulta directa desde el formulario de contacto de la web (sustituye al
// antiguo boton de WhatsApp): nombre, email, hotel/zona, fechas y mensaje.
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, hotelOrZone, checkin, checkout, message } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Falta el nombre' });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Email invalido' });
    }

    const dedupeKey = `contact:${(email || '').trim().toLowerCase()}:${name.trim().toLowerCase()}:${phone || ''}:${message || ''}`;
    if (isDuplicateSubmission(dedupeKey)) {
      return res.status(200).json({ ok: true });
    }

    await logContact({
      name: name.trim(),
      email: email ? email.trim() : null,
      phone,
      hotelOrZone,
      checkin,
      checkout,
      message,
    });

    await sendContactNotification({
      name: name.trim(),
      email: email ? email.trim() : null,
      phone,
      hotelOrZone,
      checkin,
      checkout,
      message,
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[api/contact] error', err);
    res.status(500).json({ error: 'No se pudo guardar la consulta' });
  }
});

app.get('/admin/contacts', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key) {
    return res.status(401).send('No autorizado. Añade ?key=... a la URL.');
  }

  let rows;
  try {
    rows = await listContacts({ limit: 300 });
  } catch (err) {
    console.error(err);
    return res.status(500).send('No se pudieron leer las consultas.');
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const bodyRows = rows.map((row) => `<tr>
      <td>${esc(new Date(row.created_at).toLocaleString('es-ES'))}</td>
      <td>${esc(row.name)}</td>
      <td><a href="mailto:${esc(row.email)}" style="color:#6c8cff">${esc(row.email)}</a></td>
      <td>${esc(row.hotel_or_zone)}</td>
      <td>${esc(row.checkin)} → ${esc(row.checkout)}</td>
      <td>${esc(row.message)}</td>
    </tr>`).join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Consultas de contacto - BedCopilot</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0e1533; color: #f0ece0; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #333; text-align: left; vertical-align: top; }
  th { color: #6c8cff; position: sticky; top: 0; background: #0e1533; }
  tr:hover { background: #141b3d; }
  .count { color: #a6a196; font-size: 12px; margin-bottom: 12px; }
</style></head>
<body>
  <h1>Consultas de contacto (${rows.length})</h1>
  <div class="count">Ordenadas por más reciente. <a href="/admin/leads?key=${esc(req.query.key)}" style="color:#6c8cff">Ver solicitudes de reserva</a> · <a href="/admin/conversations?key=${esc(req.query.key)}" style="color:#6c8cff">Ver conversaciones</a> · <a href="/admin/provider-rates?key=${esc(req.query.key)}" style="color:#6c8cff">Ver caché de precios</a> · <a href="/admin/analytics?key=${esc(req.query.key)}" style="color:#6c8cff">Ver analíticas</a></div>
  <table>
    <thead><tr><th>Fecha</th><th>Nombre</th><th>Email</th><th>Hotel/zona</th><th>Fechas</th><th>Mensaje</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body></html>`);
});

app.get('/admin/leads', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key) {
    return res.status(401).send('No autorizado. Añade ?key=... a la URL.');
  }

  let rows;
  try {
    rows = await listLeads({ limit: 300 });
  } catch (err) {
    console.error(err);
    return res.status(500).send('No se pudieron leer las solicitudes.');
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const bodyRows = rows.map((row) => `<tr>
      <td>${esc(new Date(row.created_at).toLocaleString('es-ES'))}</td>
      <td>${esc(row.name)}</td>
      <td><a href="mailto:${esc(row.email)}" style="color:#6c8cff">${esc(row.email)}</a></td>
      <td>${esc(row.hotel)}</td>
      <td>${esc(row.city)}</td>
      <td>${esc(row.checkin)} → ${esc(row.checkout)}</td>
      <td>${esc(row.adults ?? '')} / ${esc(row.rooms ?? '')}</td>
      <td>${esc(row.total_price)}</td>
    </tr>`).join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Solicitudes de reserva - BedCopilot</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0e1533; color: #f0ece0; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #333; text-align: left; vertical-align: top; }
  th { color: #6c8cff; position: sticky; top: 0; background: #0e1533; }
  tr:hover { background: #141b3d; }
  .count { color: #a6a196; font-size: 12px; margin-bottom: 12px; }
</style></head>
<body>
  <h1>Solicitudes de reserva (${rows.length})</h1>
  <div class="count">Ordenadas por más reciente. Recarga la página para ver las nuevas. <a href="/admin/conversations?key=${esc(req.query.key)}" style="color:#6c8cff">Ver conversaciones</a> · <a href="/admin/contacts?key=${esc(req.query.key)}" style="color:#6c8cff">Ver consultas de contacto</a> · <a href="/admin/provider-rates?key=${esc(req.query.key)}" style="color:#6c8cff">Ver caché de precios</a> · <a href="/admin/analytics?key=${esc(req.query.key)}" style="color:#6c8cff">Ver analíticas</a></div>
  <table>
    <thead><tr><th>Fecha</th><th>Nombre</th><th>Email</th><th>Hotel</th><th>Ciudad</th><th>Fechas</th><th>Adultos/Hab.</th><th>Precio</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body></html>`);
});

// Panel muy basico para ver las conversaciones guardadas: que se pregunto,
// en que dato se quedaron y si llegaron a ver un precio o no. Protegido con
// una clave simple por query string (?key=...) - no es un sistema de login
// de verdad, solo para que no quede completamente abierto a cualquiera.
function conversationStep(row) {
  const slots = row.slots ?? {};
  if (row.resolved) {
    return row.result?.found ? 'Vio un precio' : 'Busqueda sin resultado';
  }
  if (slots.checkin && slots.checkout) return 'Dio fechas, sin resolver aun';
  if (slots.hotelQuery) return 'Dio hotel/zona, sin fechas';
  return 'Solo el primer mensaje';
}

app.get('/admin/conversations', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key) {
    return res.status(401).send('No autorizado. Añade ?key=... a la URL.');
  }

  let rows;
  try {
    rows = await listConversations({ limit: 300 });
  } catch (err) {
    console.error(err);
    return res.status(500).send('No se pudo leer el registro de conversaciones.');
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const roleLabel = (role) => (role === 'user' ? 'Cliente' : 'BedCopilot');

  const bodyRows = rows.map((row) => {
    const history = Array.isArray(row.history) ? row.history : [];
    const userMsgs = history.filter((m) => m.role === 'user');
    const lastUserMsg = userMsgs[userMsgs.length - 1]?.content ?? '';
    const slots = row.slots ?? {};
    const step = conversationStep(row);
    const fullThread = history.map((m) => `<div class="msg ${esc(m.role)}"><b>${esc(roleLabel(m.role))}:</b> ${esc(m.content)}</div>`).join('\n');
    return `<tr>
      <td>${esc(new Date(row.updated_at).toLocaleString('es-ES'))}</td>
      <td>${history.length}</td>
      <td>${esc(lastUserMsg).slice(0, 160)}</td>
      <td>${esc(slots.hotelQuery)}</td>
      <td>${esc(slots.checkin)} → ${esc(slots.checkout)}</td>
      <td>${esc(slots.adults ?? '')} / ${esc(slots.rooms ?? '')}</td>
      <td>${esc(step)}</td>
      <td>${esc(row.country) || '—'}</td>
      <td>${esc(row.city) || '—'}</td>
      <td>${esc(row.traffic_source) || '—'}</td>
      <td><details><summary>Ver conversación</summary><div class="thread">${fullThread || '<i>Sin mensajes</i>'}</div></details></td>
    </tr>`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Conversaciones - BedCopilot</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0e1533; color: #f0ece0; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #333; text-align: left; vertical-align: top; }
  th { color: #6c8cff; position: sticky; top: 0; background: #0e1533; }
  tr:hover { background: #141b3d; }
  .count { color: #a6a196; font-size: 12px; margin-bottom: 12px; }
  details summary { cursor: pointer; color: #6c8cff; font-weight: 600; white-space: nowrap; }
  .thread { margin-top: 8px; max-width: 480px; max-height: 260px; overflow-y: auto; background: #0a0e21; border: 1px solid #333; border-radius: 6px; padding: 10px; }
  .thread .msg { padding: 6px 0; border-bottom: 1px solid #22263f; white-space: pre-wrap; font-size: 12.5px; }
  .thread .msg:last-child { border-bottom: none; }
  .thread .msg.user b { color: #6c8cff; }
  .thread .msg.assistant b { color: #38e1c6; }
</style></head>
<body>
  <h1>Conversaciones (${rows.length})</h1>
  <div class="count">Ordenadas por última actividad. Recarga la página para ver las nuevas. <a href="/admin/leads?key=${esc(req.query.key)}" style="color:#6c8cff">Ver solicitudes de reserva</a> · <a href="/admin/contacts?key=${esc(req.query.key)}" style="color:#6c8cff">Ver consultas de contacto</a> · <a href="/admin/provider-rates?key=${esc(req.query.key)}" style="color:#6c8cff">Ver caché de precios</a> · <a href="/admin/analytics?key=${esc(req.query.key)}" style="color:#6c8cff">Ver analíticas</a></div>
  <table>
    <thead><tr><th>Última actividad</th><th>Nº msgs</th><th>Último mensaje del cliente</th><th>Hotel/zona</th><th>Fechas</th><th>Adultos/Hab.</th><th>Paso</th><th>País</th><th>Ciudad</th><th>Origen</th><th>Hilo completo</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body></html>`);
});

// Escritura de la cache de precios por proveedor (RateHawk, TBO, Expedia...).
// La rellena un proceso de refresco con las cuentas B2B propias, no el cliente
// final - por eso va protegida con la misma clave admin, no es publica.
app.post('/admin/seed-provider-rate', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const {
    hotelName, provider, checkin, checkout,
    netPriceEur, currencyOriginal, netPriceOriginal,
    taxIncluded, extraFeeNote, regimen,
  } = req.body ?? {};

  if (!hotelName || !provider || !checkin || !checkout) {
    return res.status(400).json({ error: 'Faltan hotelName, provider, checkin o checkout' });
  }

  try {
    await upsertProviderRate({
      hotelName, provider, checkin, checkout,
      netPriceEur, currencyOriginal, netPriceOriginal,
      taxIncluded, extraFeeNote, regimen,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[admin/seed-provider-rate] error', err);
    res.status(500).json({ error: 'No se pudo guardar el precio' });
  }
});

app.get('/admin/provider-rates', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key) {
    return res.status(401).send('No autorizado. Añade ?key=... a la URL.');
  }

  let rows;
  try {
    rows = await listProviderRates({ limit: 500 });
  } catch (err) {
    console.error(err);
    return res.status(500).send('No se pudo leer la caché de precios.');
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const bodyRows = rows.map((row) => `<tr>
      <td>${esc(row.hotel_name)}</td>
      <td>${esc(row.provider)}</td>
      <td>${esc(row.checkin)} → ${esc(row.checkout)}</td>
      <td>${row.net_price_eur != null ? esc(row.net_price_eur) + ' €' : ''}</td>
      <td>${row.net_price_original != null ? esc(row.net_price_original) + ' ' + esc(row.currency_original) : ''}</td>
      <td>${row.tax_included === true ? 'Sí' : row.tax_included === false ? 'No' : ''}</td>
      <td>${esc(row.extra_fee_note)}</td>
      <td>${esc(row.regimen)}</td>
      <td>${esc(new Date(row.fetched_at).toLocaleString('es-ES'))}</td>
    </tr>`).join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Caché de precios - BedCopilot</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0e1533; color: #f0ece0; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #333; text-align: left; vertical-align: top; }
  th { color: #6c8cff; position: sticky; top: 0; background: #0e1533; }
  tr:hover { background: #141b3d; }
  .count { color: #a6a196; font-size: 12px; margin-bottom: 12px; }
</style></head>
<body>
  <h1>Caché de precios por proveedor (${rows.length})</h1>
  <div class="count">Ordenada por hotel y proveedor. <a href="/admin/leads?key=${esc(req.query.key)}" style="color:#6c8cff">Ver solicitudes de reserva</a> · <a href="/admin/contacts?key=${esc(req.query.key)}" style="color:#6c8cff">Ver consultas de contacto</a> · <a href="/admin/conversations?key=${esc(req.query.key)}" style="color:#6c8cff">Ver conversaciones</a> · <a href="/admin/analytics?key=${esc(req.query.key)}" style="color:#6c8cff">Ver analíticas</a></div>
  <table>
    <thead><tr><th>Hotel</th><th>Proveedor</th><th>Fechas</th><th>Precio neto EUR</th><th>Precio original</th><th>Tasa incluida</th><th>Nota tasa</th><th>Régimen</th><th>Consultado</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body></html>`);
});

// Panel visual con graficos (Chart.js via CDN) sobre los mismos datos que ya
// se guardan en conversations/leads/contacts - KPIs, serie temporal, top
// paises, origen de trafico y embudo de conversion.
app.get('/admin/analytics', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key) {
    return res.status(401).send('No autorizado. Añade ?key=... a la URL.');
  }

  let data;
  try {
    data = await getAnalyticsSummary();
  } catch (err) {
    console.error(err);
    return res.status(500).send('No se pudieron calcular las analíticas.');
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pctFound = data.totalResolved > 0 ? Math.round((data.totalFound / data.totalResolved) * 100) : 0;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Analíticas - BedCopilot</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  body { font-family: system-ui, sans-serif; background: #0e1533; color: #f0ece0; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  .count { color: #a6a196; font-size: 12px; margin-bottom: 20px; }
  .count a { color: #6c8cff; }
  .kpis { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
  .kpi { background: #141b3d; border: 1px solid #2a3060; border-radius: 10px; padding: 16px 22px; min-width: 150px; }
  .kpi .num { font-size: 30px; font-weight: 800; color: #6c8cff; }
  .kpi .label { font-size: 12px; color: #cfd6f7; margin-top: 4px; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .chart-card { background: #141b3d; border: 1px solid #2a3060; border-radius: 10px; padding: 18px; }
  .chart-card h2 { font-size: 14px; margin: 0 0 12px; color: #cfd6f7; }
  .chart-card.full { grid-column: 1 / -1; }
  canvas { max-height: 280px; }
  @media (max-width: 800px) { .charts { grid-template-columns: 1fr; } }
</style></head>
<body>
  <h1>Analíticas (${data.totalConversations} conversaciones)</h1>
  <div class="count">
    <a href="/admin/conversations?key=${esc(req.query.key)}">Ver conversaciones</a> ·
    <a href="/admin/leads?key=${esc(req.query.key)}">Ver solicitudes de reserva</a> ·
    <a href="/admin/contacts?key=${esc(req.query.key)}">Ver consultas de contacto</a> ·
    <a href="/admin/provider-rates?key=${esc(req.query.key)}">Ver caché de precios</a>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="num">${data.totalConversations}</div><div class="label">Conversaciones totales</div></div>
    <div class="kpi"><div class="num">${data.totalLeads}</div><div class="label">Solicitudes de reserva</div></div>
    <div class="kpi"><div class="num">${data.totalContacts}</div><div class="label">Consultas de contacto</div></div>
    <div class="kpi"><div class="num">${pctFound}%</div><div class="label">Conversaciones que vieron un precio</div></div>
  </div>

  <div class="charts">
    <div class="chart-card full">
      <h2>Conversaciones por día (últimos 30 días)</h2>
      <canvas id="chartDaily"></canvas>
    </div>
    <div class="chart-card">
      <h2>Top países</h2>
      <canvas id="chartCountry"></canvas>
    </div>
    <div class="chart-card">
      <h2>Origen del tráfico</h2>
      <canvas id="chartSource"></canvas>
    </div>
    <div class="chart-card full">
      <h2>Embudo de conversión</h2>
      <canvas id="chartFunnel"></canvas>
    </div>
  </div>

<script>
const analyticsData = ${JSON.stringify(data)};

Chart.defaults.color = '#cfd6f7';
Chart.defaults.borderColor = '#2a3060';

new Chart(document.getElementById('chartDaily'), {
  type: 'line',
  data: {
    labels: analyticsData.byDay.map(d => d.day),
    datasets: [{
      label: 'Conversaciones',
      data: analyticsData.byDay.map(d => d.count),
      borderColor: '#6c8cff',
      backgroundColor: 'rgba(108,140,255,0.15)',
      fill: true,
      tension: 0.3,
    }],
  },
  options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
});

new Chart(document.getElementById('chartCountry'), {
  type: 'bar',
  data: {
    labels: analyticsData.byCountry.map(d => d.country),
    datasets: [{ label: 'Conversaciones', data: analyticsData.byCountry.map(d => d.count), backgroundColor: '#6c8cff' }],
  },
  options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
});

new Chart(document.getElementById('chartSource'), {
  type: 'doughnut',
  data: {
    labels: analyticsData.byTrafficSource.map(d => d.source),
    datasets: [{ data: analyticsData.byTrafficSource.map(d => d.count), backgroundColor: ['#6c8cff', '#38e1c6', '#a78bfa', '#f4a261', '#e76f51', '#2a9d8f', '#e9c46a'] }],
  },
});

new Chart(document.getElementById('chartFunnel'), {
  type: 'bar',
  data: {
    labels: ['Entraron', 'Dieron hotel/zona', 'Dieron fechas', 'Vieron precio'],
    datasets: [{
      label: 'Conversaciones',
      data: [analyticsData.funnel.total, analyticsData.funnel.gaveHotel, analyticsData.funnel.gaveDates, analyticsData.funnel.sawPrice],
      backgroundColor: ['#6c8cff', '#7ea0ff', '#38e1c6', '#2ec4a6'],
    }],
  },
  options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
});
</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`BedCopilot chatbot backend escuchando en http://localhost:${PORT}`);
});
