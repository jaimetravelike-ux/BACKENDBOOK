// Punto de entrada unico para comprobar precio, usado por server.js. Decide
// entre RapidAPI (rapido, con desglose de cargos) y Playwright (mas lento
// pero probado y fiable) segun el caso:
//
// - Si el cliente pidio un HOTEL concreto (no una zona/barrio), no pidio
//   desayuno, y se resuelve su hotel_id: se intenta primero RapidAPI. Si
//   responde con disponibilidad, se usa ese resultado (mas rapido, con
//   cargos extra desglosados).
// - Si RapidAPI no responde, da timeout, o no tiene disponibilidad para esas
//   fechas: se cae a Playwright (bookingAgent.checkBookingPrice), que hace
//   la busqueda completa igual que antes.
// - Si la busqueda es por zona/barrio (no un hotel concreto) y el cliente NO
//   pidio desayuno: se piden a RapidAPI 3 opciones reales (las mas baratas)
//   dentro de esa misma zona/ciudad, en vez de que Playwright elija una sola
//   en silencio entre los primeros resultados. Si RapidAPI no devuelve nada,
//   se cae a Playwright igualmente (comportamiento de siempre: una unica
//   opcion elegida por Playwright).
// - Si el cliente SI pidio desayuno (hotel concreto o zona), se va directo a
//   Playwright: el endpoint de RapidAPI que usamos (v1/hotels/search)
//   devuelve un unico precio "representativo" por hotel sin garantia de que
//   incluya desayuno - Playwright si sabe aplicar el filtro real "Desayuno
//   incluido" de Booking, asi que es la unica fuente fiable cuando el
//   desayuno importa.

import { resolveHotelId, checkBookingPrice } from './bookingAgent.js';
import { checkRapidApiPrice, searchMultipleHotels } from './rapidApiAgent.js';
import { findNearestHotels } from './geo.js';

/**
 * @param {{query:string, checkin:string, checkout:string, adults?:string, rooms?:string, breakfast?:boolean, headless?:boolean, areaOnly?:boolean}} params
 */
export async function checkPrice({ query, checkin, checkout, adults = '2', rooms = '1', breakfast = false, headless = true, areaOnly = false }) {
  if (!query || !checkin || !checkout) {
    throw new Error('query, checkin y checkout son obligatorios');
  }

  // areaOnly: el cliente ha dicho explicitamente que no quiere un hotel
  // concreto (normalmente tras una desambiguacion) - se le pide a Booking
  // que ignore sus sugerencias de tipo HOTEL y resuelva a la zona/distrito,
  // para que el flujo de varias opciones (searchMultipleHotels, mas abajo)
  // se dispare de verdad en vez de acabar siempre en un unico hotel cuyo
  // nombre coincidia por casualidad con la zona pedida.
  const resolved = await resolveHotelId({ query, headless, preferArea: areaOnly });
  console.log('[priceChecker] resolveHotelId ->', resolved);

  if (resolved.needsDisambiguation) {
    return { found: false, needsDisambiguation: true, options: resolved.options };
  }
  if (resolved.notFoundInNewYork) {
    return { found: false, notFoundInNewYork: true, reason: 'No se ha encontrado ese hotel en Nueva York' };
  }

  if (resolved.wasSpecificHotel && resolved.hotelId && !breakfast) {
    const rapidResult = await checkRapidApiPrice({
      hotelId: resolved.hotelId,
      checkin,
      checkout,
      adults,
      rooms,
    });
    if (rapidResult?.found) {
      console.log('[priceChecker] usando RapidAPI');
      return {
        ...rapidResult,
        hotel: rapidResult.hotel ?? resolved.hotelName ?? query,
        breakfastRequested: breakfast,
      };
    }
  } else if (breakfast) {
    console.log('[priceChecker] cliente pidio desayuno - va directo a Playwright (RapidAPI no garantiza desayuno incluido)');
  } else if (resolved.hotelId) {
    console.log('[priceChecker] no es un hotel especifico - probando 3 opciones via RapidAPI en esa zona/ciudad');
    const multi = await searchMultipleHotels({
      destId: resolved.hotelId,
      destType: resolved.destType,
      checkin,
      checkout,
      adults,
      rooms,
      limit: 3,
    });
    if (multi?.length) {
      console.log('[priceChecker] usando RapidAPI (multiples opciones)', { count: multi.length });
      return { found: true, multiple: true, hotels: multi, breakfastRequested: breakfast };
    }
  } else {
    console.log('[priceChecker] sin destId resuelto - va directo a Playwright');
  }

  // Landmark/punto (p.ej. "Times Square"): RapidAPI no acepta destType
  // latlong, asi que ni el hotel concreto ni searchMultipleHotels de arriba
  // pudieron responder. Si Booking nos dio coordenadas reales del punto,
  // buscamos los hoteles reales mas cercanos en el dataset local y pedimos
  // su precio en vivo via RapidAPI (rapido) antes de caer al fallback lento
  // de Playwright.
  if (!breakfast && !resolved.wasSpecificHotel && typeof resolved.latitude === 'number' && typeof resolved.longitude === 'number') {
    const nearest = findNearestHotels({ latitude: resolved.latitude, longitude: resolved.longitude, limit: 3 });
    if (nearest.length > 0) {
      console.log('[priceChecker] usando busqueda por cercania geografica sobre el dataset local', {
        latitude: resolved.latitude,
        longitude: resolved.longitude,
        candidatos: nearest.map((h) => ({ name: h.name, distanceKm: h.distanceKm.toFixed(2) })),
      });
      const priced = await Promise.all(
        nearest.map((h) => checkRapidApiPrice({ hotelId: h.hotelId, checkin, checkout, adults, rooms }))
      );
      const found = priced.filter((p) => p?.found);
      if (found.length > 0) {
        console.log('[priceChecker] busqueda por cercania: precios en vivo obtenidos', { count: found.length });
        return { found: true, multiple: true, hotels: found, breakfastRequested: breakfast };
      }
      console.log('[priceChecker] busqueda por cercania: ningun hotel cercano tenia disponibilidad - va a Playwright');
    }
  }

  // Fallback: zona/barrio sin destId, o RapidAPI no disponible/sin resultado
  // para estas fechas - reutilizamos la busqueda completa de Playwright tal
  // cual, que ya resuelve el destino por su cuenta y elige una sola opcion.
  console.log('[priceChecker] usando fallback de Playwright');
  return checkBookingPrice({ query, checkin, checkout, adults, rooms, breakfast, headless, preferArea: areaOnly });
}
