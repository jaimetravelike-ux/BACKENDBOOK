import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSession, slotsComplete, searchKey } from './sessionStore.js';
import { converse, phraseSearchResult } from './claude.js';
import { checkPrice } from './priceChecker.js';
import { logTurn, logResolved, listConversations, logLead, listLeads } from './conversationLog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
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
    const { sessionId: incomingId, message } = req.body ?? {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Falta "message"' });
    }
    const sessionId = incomingId || randomUUID();
    const session = getSession(sessionId);

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
    const result = await checkPrice({
      query: slots.hotelQuery,
      checkin: slots.checkin,
      checkout: slots.checkout,
      adults: slots.adults || '2',
      rooms: slots.rooms || '1',
      breakfast: Boolean(slots.breakfast),
    });

    session.lastSearchedKey = searchKey(slots);
    session.pendingSearch = false;

    const reply = await phraseSearchResult(session, result);

    logResolved(sessionId, session, result);

    res.json({ sessionId, reply, result });
  } catch (err) {
    console.error(err);
    const { sessionId } = req.body ?? {};
    const session = getSession(sessionId);
    session.pendingSearch = false;
    res.status(500).json({ error: 'No se pudo comprobar el precio ahora mismo' });
  }
});

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
      <td><a href="mailto:${esc(row.email)}" style="color:#f2b705">${esc(row.email)}</a></td>
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
  body { font-family: system-ui, sans-serif; background: #15171c; color: #f0ece0; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #333; text-align: left; vertical-align: top; }
  th { color: #f2b705; position: sticky; top: 0; background: #15171c; }
  tr:hover { background: #1e2128; }
  .count { color: #a6a196; font-size: 12px; margin-bottom: 12px; }
</style></head>
<body>
  <h1>Solicitudes de reserva (${rows.length})</h1>
  <div class="count">Ordenadas por más reciente. Recarga la página para ver las nuevas. <a href="/admin/conversations?key=${esc(req.query.key)}" style="color:#f2b705">Ver conversaciones</a></div>
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

  const bodyRows = rows.map((row) => {
    const history = Array.isArray(row.history) ? row.history : [];
    const userMsgs = history.filter((m) => m.role === 'user');
    const lastUserMsg = userMsgs[userMsgs.length - 1]?.content ?? '';
    const slots = row.slots ?? {};
    const step = conversationStep(row);
    return `<tr>
      <td>${esc(new Date(row.updated_at).toLocaleString('es-ES'))}</td>
      <td>${history.length}</td>
      <td>${esc(lastUserMsg).slice(0, 160)}</td>
      <td>${esc(slots.hotelQuery)}</td>
      <td>${esc(slots.checkin)} → ${esc(slots.checkout)}</td>
      <td>${esc(slots.adults ?? '')} / ${esc(slots.rooms ?? '')}</td>
      <td>${esc(step)}</td>
    </tr>`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Conversaciones - BedCopilot</title>
<style>
  body { font-family: system-ui, sans-serif; background: #15171c; color: #f0ece0; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #333; text-align: left; vertical-align: top; }
  th { color: #f2b705; position: sticky; top: 0; background: #15171c; }
  tr:hover { background: #1e2128; }
  .count { color: #a6a196; font-size: 12px; margin-bottom: 12px; }
</style></head>
<body>
  <h1>Conversaciones (${rows.length})</h1>
  <div class="count">Ordenadas por última actividad. Recarga la página para ver las nuevas. <a href="/admin/leads?key=${esc(req.query.key)}" style="color:#f2b705">Ver solicitudes de reserva</a></div>
  <table>
    <thead><tr><th>Última actividad</th><th>Nº msgs</th><th>Último mensaje del cliente</th><th>Hotel/zona</th><th>Fechas</th><th>Adultos/Hab.</th><th>Paso</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`BedCopilot chatbot backend escuchando en http://localhost:${PORT}`);
});
