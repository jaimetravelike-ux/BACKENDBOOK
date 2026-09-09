import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSession, slotsComplete, searchKey } from './sessionStore.js';
import { converse, phraseSearchResult } from './claude.js';
import { checkPrice } from './priceChecker.js';

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
    res.json({ sessionId, reply, result });
  } catch (err) {
    console.error(err);
    const { sessionId } = req.body ?? {};
    const session = getSession(sessionId);
    session.pendingSearch = false;
    res.status(500).json({ error: 'No se pudo comprobar el precio ahora mismo' });
  }
});

app.listen(PORT, () => {
  console.log(`Titi Hotels chatbot backend escuchando en http://localhost:${PORT}`);
});
