// Guarda cada conversacion en Postgres para poder revisarlas despues (que
// preguntan los clientes, en que dato se quedan atascados, cuantas llegan a
// ver un precio). Es un registro en paralelo al estado en memoria de
// sessionStore.js - si Postgres falla o no esta configurado, el chat sigue
// funcionando igual, solo se pierde el registro de esa conversacion.

import pg from 'pg';

const { Pool } = pg;

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

let ready = null;

function init() {
  if (!pool) return Promise.resolve(false);
  if (!ready) {
    ready = pool
      .query(`
        CREATE TABLE IF NOT EXISTS conversations (
          session_id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          history JSONB NOT NULL DEFAULT '[]',
          slots JSONB NOT NULL DEFAULT '{}',
          resolved BOOLEAN NOT NULL DEFAULT false,
          result JSONB
        );
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS country TEXT;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS city TEXT;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS referrer TEXT;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS utm_source TEXT;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS utm_medium TEXT;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS traffic_source TEXT;
        CREATE TABLE IF NOT EXISTS leads (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          session_id TEXT,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          hotel TEXT,
          city TEXT,
          checkin TEXT,
          checkout TEXT,
          adults TEXT,
          rooms TEXT,
          total_price TEXT
        );
        CREATE TABLE IF NOT EXISTS contacts (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT now(),
          name TEXT,
          email TEXT,
          phone TEXT,
          hotel_or_zone TEXT,
          checkin TEXT,
          checkout TEXT,
          message TEXT
        );
      `)
      .then(() => true)
      .catch((err) => {
        console.warn('[conversationLog] no se pudo crear la tabla, se desactiva el registro', err?.message);
        return false;
      });
  }
  return ready;
}

// Se llama tras cada turno normal de chat, para ir dejando el hilo y los
// datos recogidos hasta ahora. No lanza nunca - un fallo aqui no debe romper
// la conversacion del cliente.
export async function logTurn(sessionId, session) {
  try {
    if (!(await init())) return;
    const v = session.visitorInfo ?? {};
    await pool.query(
      `INSERT INTO conversations (session_id, history, slots, updated_at, country, city, referrer, utm_source, utm_medium, utm_campaign, traffic_source)
       VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (session_id)
       DO UPDATE SET history = $2, slots = $3, updated_at = now()`,
      [
        sessionId,
        JSON.stringify(session.history),
        JSON.stringify(session.slots),
        v.country ?? null,
        v.city ?? null,
        v.referrer ?? null,
        v.utmSource ?? null,
        v.utmMedium ?? null,
        v.utmCampaign ?? null,
        v.trafficSource ?? null,
      ],
    );
  } catch (err) {
    console.warn('[conversationLog] fallo guardando turno', err?.message);
  }
}

// Se llama cuando se resuelve una busqueda (con o sin exito), para marcar la
// conversacion como "llegada al final" y guardar el resultado.
export async function logResolved(sessionId, session, result) {
  try {
    if (!(await init())) return;
    const v = session.visitorInfo ?? {};
    await pool.query(
      `INSERT INTO conversations (session_id, history, slots, resolved, result, updated_at, country, city, referrer, utm_source, utm_medium, utm_campaign, traffic_source)
       VALUES ($1, $2, $3, true, $4, now(), $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (session_id)
       DO UPDATE SET history = $2, slots = $3, resolved = true, result = $4, updated_at = now()`,
      [
        sessionId,
        JSON.stringify(session.history),
        JSON.stringify(session.slots),
        JSON.stringify(result ?? null),
        v.country ?? null,
        v.city ?? null,
        v.referrer ?? null,
        v.utmSource ?? null,
        v.utmMedium ?? null,
        v.utmCampaign ?? null,
        v.trafficSource ?? null,
      ],
    );
  } catch (err) {
    console.warn('[conversationLog] fallo guardando resolucion', err?.message);
  }
}

export async function listConversations({ limit = 200 } = {}) {
  if (!(await init())) return [];
  const { rows } = await pool.query(
    `SELECT session_id, created_at, updated_at, history, slots, resolved, result,
            country, city, referrer, utm_source, utm_medium, utm_campaign, traffic_source
     FROM conversations
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

// Datos de contacto que el cliente deja directamente en la card del hotel
// (nombre + email), en vez de tener que escribirlos por chat. Si Postgres no
// esta disponible, se lanza el error hacia arriba - aqui SI hace falta que
// el llamador sepa que no se guardo, para poder avisar al cliente.
export async function logLead(lead) {
  if (!(await init())) throw new Error('Postgres no configurado');
  await pool.query(
    `INSERT INTO leads (session_id, name, email, hotel, city, checkin, checkout, adults, rooms, total_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      lead.sessionId ?? null,
      lead.name,
      lead.email,
      lead.hotel ?? null,
      lead.city ?? null,
      lead.checkin ?? null,
      lead.checkout ?? null,
      lead.adults ?? null,
      lead.rooms ?? null,
      lead.totalPrice ?? null,
    ],
  );
}

export async function listLeads({ limit = 300 } = {}) {
  if (!(await init())) return [];
  const { rows } = await pool.query(
    `SELECT id, created_at, name, email, hotel, city, checkin, checkout, adults, rooms, total_price
     FROM leads
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

// Consultas del formulario de contacto de la web (sustituye al antiguo boton
// de WhatsApp). Igual que logLead, lanza el error hacia arriba si falla -
// perder un contacto real debe ser visible, no silencioso.
export async function logContact(contact) {
  if (!(await init())) throw new Error('Postgres no configurado');
  await pool.query(
    `INSERT INTO contacts (name, email, phone, hotel_or_zone, checkin, checkout, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      contact.name,
      contact.email ?? null,
      contact.phone ?? null,
      contact.hotelOrZone ?? null,
      contact.checkin ?? null,
      contact.checkout ?? null,
      contact.message ?? null,
    ],
  );
}

export async function listContacts({ limit = 300 } = {}) {
  if (!(await init())) return [];
  const { rows } = await pool.query(
    `SELECT id, created_at, name, email, phone, hotel_or_zone, checkin, checkout, message
     FROM contacts
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}
