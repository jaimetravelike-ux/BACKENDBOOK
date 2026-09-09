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

/**
 * @param {{query:string, checkin:string, checkout:string, adults?:string, rooms?:string, breakfast?:boolean, headless?:boolean}} params
 */
export async function checkPrice({ query, checkin, checkout, adults = '2', rooms = '1', breakfast = false, headless = true }) {
  if (!query || !checkin || !checkout) {
    throw new Error('query, checkin y checkout son obligatorios');
  }

  const resolved = await resolveHotelId({ query, headless });
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

  // Fallback: zona/barrio sin destId, o RapidAPI no disponible/sin resultado
  // para estas fechas - reutilizamos la busqueda completa de Playwright tal
  // cual, que ya resuelve el destino por su cuenta y elige una sola opcion.
  console.log('[priceChecker] usando fallback de Playwright');
  return checkBookingPrice({ query, checkin, checkout, adults, rooms, breakfast, headless });
}
