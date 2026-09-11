// Script de un solo uso (o refresco periodico manual): construye una base
// local de hoteles reales de Nueva York con su hotel_id, nombre, coordenadas,
// estrellas, nota de opiniones y barrio - TODO datos casi estaticos (un hotel
// no cambia de sitio de un dia para otro), nunca precios (que siempre se
// consultan en vivo, esto no los cachea).
//
// Uso: node scripts/build-nyc-hotel-dataset.js
// Requiere RAPIDAPI_KEY en el entorno (Railway ya la tiene; en local hace
// falta un .env con esa variable, ver .env.example).
//
// v1/hotels/search exige fechas de checkin/checkout (es un buscador de
// disponibilidad+precio, no un directorio de hoteles) - se usan solo como
// "excusa" para listar hoteles reales; el precio devuelto en la respuesta
// NO se guarda, solo la identidad/ubicacion del hotel.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAPIDAPI_HOST = 'booking-com.p.rapidapi.com';
const NYC_DEST_ID = 20088325; // confirmado con datos reales en rapidApiAgent.js
const PAGES = 10; // ~25 hoteles/pagina -> hasta ~250 hoteles distintos
const PAGE_DELAY_MS = 600; // no machacar el rate limit de RapidAPI

function futureDateRange() {
  // Fechas arbitrarias a 45 dias vista, 2 noches - solo para que la API
  // devuelva disponibilidad real. No afecta a los datos que nos interesan
  // (identidad/ubicacion del hotel).
  const checkin = new Date();
  checkin.setDate(checkin.getDate() + 45);
  const checkout = new Date(checkin);
  checkout.setDate(checkout.getDate() + 2);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { checkin: fmt(checkin), checkout: fmt(checkout) };
}

async function fetchPage(pageNumber, apiKey, { checkin, checkout }) {
  const url = new URL(`https://${RAPIDAPI_HOST}/v1/hotels/search`);
  url.searchParams.set('dest_type', 'city');
  url.searchParams.set('dest_id', String(NYC_DEST_ID));
  url.searchParams.set('checkin_date', checkin);
  url.searchParams.set('checkout_date', checkout);
  url.searchParams.set('adults_number', '2');
  url.searchParams.set('room_number', '1');
  url.searchParams.set('filter_by_currency', 'USD');
  url.searchParams.set('locale', 'en-gb');
  url.searchParams.set('units', 'metric');
  url.searchParams.set('order_by', 'popularity');
  url.searchParams.set('page_number', String(pageNumber));
  url.searchParams.set('include_adjacency', 'false');

  const res = await fetch(url, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': RAPIDAPI_HOST },
  });
  if (!res.ok) {
    console.warn(`[build-dataset] pagina ${pageNumber}: HTTP ${res.status}`);
    return [];
  }
  const json = await res.json();
  const results = Array.isArray(json?.result) ? json.result : [];
  return results.filter((r) => r?.type === 'property_card');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.error('Falta RAPIDAPI_KEY en el entorno. Aborta.');
    process.exit(1);
  }

  const dates = futureDateRange();
  console.log(`[build-dataset] usando fechas ${dates.checkin} -> ${dates.checkout} (solo para listar hoteles, no se guarda precio)`);

  const byId = new Map();

  for (let page = 0; page < PAGES; page++) {
    const cards = await fetchPage(page, apiKey, dates);
    if (cards.length === 0) {
      console.log(`[build-dataset] pagina ${page}: sin resultados, se para aqui`);
      break;
    }
    for (const c of cards) {
      if (!c.hotel_id || byId.has(c.hotel_id)) continue;
      if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number') continue;
      byId.set(c.hotel_id, {
        hotelId: c.hotel_id,
        name: c.hotel_name ?? null,
        latitude: c.latitude,
        longitude: c.longitude,
        stars: c.class ?? null,
        reviewScore: c.review_score ?? null,
        reviewCount: c.review_nr ?? null,
        district: typeof c.district === 'string' && c.district.trim() ? c.district.trim() : null,
      });
    }
    console.log(`[build-dataset] pagina ${page}: ${cards.length} tarjetas, ${byId.size} hoteles unicos acumulados`);
    await sleep(PAGE_DELAY_MS);
  }

  const dataset = [...byId.values()].sort((a, b) => (b.reviewScore ?? 0) - (a.reviewScore ?? 0));
  const outPath = path.join(__dirname, '..', 'src', 'data', 'nyc-hotels.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(dataset, null, 2), 'utf8');
  console.log(`[build-dataset] guardados ${dataset.length} hoteles en ${outPath}`);
}

main().catch((err) => {
  console.error('[build-dataset] fallo:', err);
  process.exit(1);
});
