// Cache de precios netos por proveedor (RateHawk, TBO, Expedia...), refrescada
// de fondo con las cuentas B2B propias (no las del cliente final). En vez de
// comprobar en vivo 3 proveedores por cada busqueda de un cliente real (demasiado
// lento, 30-90s+), el sistema guarda aqui el ultimo precio neto conocido por
// hotel+fechas+proveedor, y usa el mas barato disponible para calcular margen y
// descuento en el momento de la busqueda real (que sigue mostrando el precio de
// Booking en vivo, como hasta ahora).

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
        CREATE TABLE IF NOT EXISTS provider_rates (
          id BIGSERIAL PRIMARY KEY,
          hotel_name TEXT NOT NULL,
          provider TEXT NOT NULL,
          checkin DATE NOT NULL,
          checkout DATE NOT NULL,
          net_price_eur NUMERIC,
          currency_original TEXT,
          net_price_original NUMERIC,
          tax_included BOOLEAN,
          extra_fee_note TEXT,
          regimen TEXT,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (hotel_name, provider, checkin, checkout)
        );
      `)
      .then(() => true)
      .catch((err) => {
        console.warn('[providerRates] no se pudo crear la tabla, se desactiva la cache', err?.message);
        return false;
      });
  }
  return ready;
}

// Guarda o actualiza el precio neto de un hotel/proveedor/fechas concretos.
// Lanza el error hacia arriba: quien siembra la cache (el endpoint admin) debe
// saber si de verdad se guardo o no, no fallar en silencio.
export async function upsertProviderRate(rate) {
  if (!(await init())) throw new Error('Postgres no configurado');
  await pool.query(
    `INSERT INTO provider_rates
       (hotel_name, provider, checkin, checkout, net_price_eur, currency_original, net_price_original, tax_included, extra_fee_note, regimen, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (hotel_name, provider, checkin, checkout)
     DO UPDATE SET
       net_price_eur = $5, currency_original = $6, net_price_original = $7,
       tax_included = $8, extra_fee_note = $9, regimen = $10, fetched_at = now()`,
    [
      rate.hotelName,
      rate.provider,
      rate.checkin,
      rate.checkout,
      rate.netPriceEur ?? null,
      rate.currencyOriginal ?? null,
      rate.netPriceOriginal ?? null,
      rate.taxIncluded ?? null,
      rate.extraFeeNote ?? null,
      rate.regimen ?? null,
    ],
  );
}

// Devuelve el precio en cache mas barato entre todos los proveedores para ese
// hotel+fechas exactos, o null si no hay ninguno todavia.
export async function getBestProviderRate(hotelName, checkin, checkout) {
  if (!(await init())) return null;
  const { rows } = await pool.query(
    `SELECT hotel_name, provider, checkin, checkout, net_price_eur, currency_original,
            net_price_original, tax_included, extra_fee_note, regimen, fetched_at
     FROM provider_rates
     WHERE hotel_name = $1 AND checkin = $2 AND checkout = $3
     ORDER BY net_price_eur ASC NULLS LAST
     LIMIT 1`,
    [hotelName, checkin, checkout],
  );
  return rows[0] ?? null;
}

export async function listProviderRates({ limit = 500 } = {}) {
  if (!(await init())) return [];
  const { rows } = await pool.query(
    `SELECT id, hotel_name, provider, checkin, checkout, net_price_eur, currency_original,
            net_price_original, tax_included, extra_fee_note, regimen, fetched_at
     FROM provider_rates
     ORDER BY hotel_name ASC, provider ASC, fetched_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}
