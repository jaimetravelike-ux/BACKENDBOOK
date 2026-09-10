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

// Agregados para el panel /admin/analytics: KPIs, serie temporal, top
// paises, origen de trafico y embudo de conversion. Varias queries en
// paralelo contra las mismas tablas ya existentes, sin tablas nuevas.
export async function getAnalyticsSummary() {
  if (!(await init())) {
    return {
      totalConversations: 0,
      totalLeads: 0,
      totalContacts: 0,
      totalResolved: 0,
      totalFound: 0,
      byDay: [],
      byCountry: [],
      byTrafficSource: [],
      funnel: { total: 0, gaveHotel: 0, gaveDates: 0, sawPrice: 0 },
    };
  }

  const [kpis, byDay, byCountry, byTrafficSource, funnel] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM conversations) AS total_conversations,
        (SELECT COUNT(*) FROM leads) AS total_leads,
        (SELECT COUNT(*) FROM contacts) AS total_contacts,
        (SELECT COUNT(*) FROM conversations WHERE resolved = true) AS total_resolved,
        (SELECT COUNT(*) FROM conversations WHERE resolved = true AND (result->>'found') = 'true') AS total_found
    `),
    pool.query(`
      SELECT TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS day, COUNT(*) AS count
      FROM conversations
      WHERE created_at >= now() - interval '30 days'
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `),
    pool.query(`
      SELECT country, COUNT(*) AS count
      FROM conversations
      WHERE country IS NOT NULL
      GROUP BY country
      ORDER BY count DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT traffic_source, COUNT(*) AS count
      FROM conversations
      WHERE traffic_source IS NOT NULL
      GROUP BY traffic_source
      ORDER BY count DESC
    `),
    pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE slots->>'hotelQuery' IS NOT NULL) AS gave_hotel,
        COUNT(*) FILTER (WHERE slots->>'checkin' IS NOT NULL AND slots->>'checkout' IS NOT NULL) AS gave_dates,
        COUNT(*) FILTER (WHERE resolved = true AND (result->>'found') = 'true') AS saw_price
      FROM conversations
    `),
  ]);

  const k = kpis.rows[0];
  const f = funnel.rows[0];

  return {
    totalConversations: Number(k.total_conversations),
    totalLeads: Number(k.total_leads),
    totalContacts: Number(k.total_contacts),
    totalResolved: Number(k.total_resolved),
    totalFound: Number(k.total_found),
    byDay: byDay.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
    byCountry: byCountry.rows.map((r) => ({ country: r.country, count: Number(r.count) })),
    byTrafficSource: byTrafficSource.rows.map((r) => ({ source: r.traffic_source, count: Number(r.count) })),
    funnel: {
      total: Number(f.total),
      gaveHotel: Number(f.gave_hotel),
      gaveDates: Number(f.gave_dates),
      sawPrice: Number(f.saw_price),
    },
  };
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
