// Busqueda de hoteles reales de Nueva York mas cercanos a un punto (lat/lng),
// usando el dataset local generado por scripts/build-nyc-hotel-dataset.js
// (src/data/nyc-hotels.json). Solo contiene identidad/ubicacion de cada
// hotel (nunca precio) - el precio se pide siempre en vivo aparte.
//
// Se usa cuando Booking resuelve una busqueda a un landmark/punto
// (dest_type=latlong, p.ej. "Times Square") que RapidAPI no puede aceptar
// directamente: en vez de caer al fallback lento de Playwright, calculamos
// aqui los hoteles reales mas cercanos y pedimos su precio en vivo via
// RapidAPI (rapido, ~2-4s por hotel en paralelo).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.join(__dirname, 'data', 'nyc-hotels.json');

let cachedDataset = null;
function loadDataset() {
  if (cachedDataset) return cachedDataset;
  try {
    const raw = readFileSync(DATASET_PATH, 'utf8');
    cachedDataset = JSON.parse(raw);
  } catch (err) {
    console.warn('[geo] no se pudo cargar el dataset local de hoteles NYC:', err.message);
    cachedDataset = [];
  }
  return cachedDataset;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Devuelve los `limit` hoteles del dataset local mas cercanos al punto dado,
 * ordenados por distancia. Filtra por calidad minima para no proponer
 * hoteles malos solo por estar cerca.
 * @param {{latitude:number, longitude:number, limit?:number, minStars?:number, minReviewScore?:number}} params
 */
export function findNearestHotels({ latitude, longitude, limit = 3, minStars = 3, minReviewScore = 6 }) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return [];
  const dataset = loadDataset();
  if (dataset.length === 0) return [];

  const withDistance = dataset
    .filter((h) => (h.stars ?? 0) >= minStars && (h.reviewScore ?? 0) >= minReviewScore)
    .map((h) => ({ ...h, distanceKm: haversineKm(latitude, longitude, h.latitude, h.longitude) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return withDistance.slice(0, limit);
}
