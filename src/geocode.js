// Geocodifica un nombre de sitio (landmark, barrio...) a coordenadas reales,
// sin depender del autocompletado de Booking (que hoy demostro ser poco
// fiable para landmarks en el paso rapido de resolveHotelId - ver commits
// anteriores). Usa Nominatim (OpenStreetMap), gratis y sin API key, igual
// que open-er-api.com para las divisas en currency.js.
//
// Restringido a la caja geografica de Nueva York para evitar resolver, por
// ejemplo, "Chelsea" a Londres en vez de al barrio de Manhattan.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// left,top,right,bottom - cubre los 5 distritos de Nueva York con margen.
const NYC_VIEWBOX = '-74.3,40.92,-73.65,40.49';
const USER_AGENT = 'BedCopilot/1.0 (contact@bedcopilot.com)';

/**
 * @param {string} query - texto libre, p.ej. "Times Square" o "Chelsea"
 * @returns {Promise<{latitude:number, longitude:number, displayName:string}|null>}
 */
export async function geocodePlace(query) {
  if (!query) return null;
  const scoped = /new york|nueva york|\bnyc\b/i.test(query) ? query : `${query}, New York`;

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', scoped);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('viewbox', NYC_VIEWBOX);
  url.searchParams.set('bounded', '1');

  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      console.warn('[geocode] Nominatim respondio con error', res.status);
      return null;
    }
    const results = await res.json();
    const first = Array.isArray(results) ? results[0] : null;
    if (!first) {
      console.warn('[geocode] Nominatim sin resultados para', scoped);
      return null;
    }
    const latitude = Number(first.lat);
    const longitude = Number(first.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude, displayName: first.display_name };
  } catch (err) {
    console.warn('[geocode] fallo consultando Nominatim:', err.message);
    return null;
  }
}
