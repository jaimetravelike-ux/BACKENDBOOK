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
    await pool.query(
      `INSERT INTO conversations (session_id, history, slots, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (session_id)
       DO UPDATE SET history = $2, slots = $3, updated_at = now()`,
      [sessionId, JSON.stringify(session.history), JSON.stringify(session.slots)],
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
    await pool.query(
      `INSERT INTO conversations (session_id, history, slots, resolved, result, updated_at)
       VALUES ($1, $2, $3, true, $4, now())
       ON CONFLICT (session_id)
       DO UPDATE SET history = $2, slots = $3, resolved = true, result = $4, updated_at = now()`,
      [sessionId, JSON.stringify(session.history), JSON.stringify(session.slots), JSON.stringify(result ?? null)],
    );
  } catch (err) {
    console.warn('[conversationLog] fallo guardando resolucion', err?.message);
  }
}

export async function listConversations({ limit = 200 } = {}) {
  if (!(await init())) return [];
  const { rows } = await pool.query(
    `SELECT session_id, created_at, updated_at, history, slots, resolved, result
     FROM conversations
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}
