// Punto de entrada unico para comprobar precio, usado por server.js. Decide
// entre RapidAPI (rapido, con desglose de cargos) y Playwright (mas lento
// pero probado y fiable) segun el caso:
//
// - Si el cliente pidio un HOTEL concreto (no una zona/barrio) y se resuelve
//   su hotel_id: se intenta primero RapidAPI. Si responde con disponibilidad,
//   se usa ese resultado (mas rapido, con cargos extra desglosados).
// - Si RapidAPI no responde, da timeout, o no tiene disponibilidad para esas
//   fechas: se cae a Playwright (bookingAgent.checkBookingPrice), que hace
//   la busqueda completa igual que antes.
// - Si la busqueda es por zona/barrio (no un hotel concreto), se va directo
//   a Playwright: RapidAPI necesita un hotel_id exacto, no sirve para
//   "cualquier hotel en Times Square".

import { resolveHotelId, checkBookingPrice } from './bookingAgent.js';
import { checkRapidApiPrice } from './rapidApiAgent.js';

/**
 * @param {{query:string, checkin:string, checkout:string, adults?:string, rooms?:string, breakfast?:boolean, headless?:boolean}} params
 */
export async function checkPrice({ query, checkin, checkout, adults = '2', rooms = '1', breakfast = false, headless = true }) {
  if (!query || !checkin || !checkout) {
    throw new Error('query, checkin y checkout son obligatorios');
  }

  const resolved = await resolveHotelId({ query, headless });

  if (resolved.needsDisambiguation) {
    return { found: false, needsDisambiguation: true, options: resolved.options };
  }
  if (resolved.notFoundInNewYork) {
    return { found: false, notFoundInNewYork: true, reason: 'No se ha encontrado ese hotel en Nueva York' };
  }

  if (resolved.wasSpecificHotel && resolved.hotelId) {
    const rapidResult = await checkRapidApiPrice({
      hotelId: resolved.hotelId,
      checkin,
      checkout,
      adults,
      rooms,
      breakfast,
    });
    if (rapidResult?.found) {
      return {
        ...rapidResult,
        hotel: rapidResult.hotel ?? resolved.hotelName ?? query,
        breakfastRequested: breakfast,
      };
    }
  }

  // Fallback: zona/barrio (no hotel concreto), o RapidAPI no disponible/sin
  // resultado para estas fechas - reutilizamos la busqueda completa de
  // Playwright tal cual, que ya resuelve el destino por su cuenta.
  return checkBookingPrice({ query, checkin, checkout, adults, rooms, breakfast, headless });
}
