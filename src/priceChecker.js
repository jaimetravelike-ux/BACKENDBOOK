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
import { geocodePlace } from './geocode.js';

// Cuantos hoteles cercanos se piden como candidatos a RapidAPI para la
// busqueda por cercania geografica - mas de los 3 que se devuelven al
// cliente, porque no todos tendran disponibilidad para esas fechas exactas.
// Con 8 candidatos casi siempre hay al menos 3 con hueco.
const GEO_CANDIDATE_POOL = 8;
const GEO_RESULTS_WANTED = 3;
// Antes de quedarnos con los 3 finales, reunimos al menos este numero de
// candidatos con disponibilidad real (si el dataset da para ello) para
// poder elegir los 3 segun la preferencia del cliente (barato/calidad/
// calidad-precio) en vez de simplemente los 3 primeros por cercania.
const GEO_RANKING_POOL = 5;

// Extrae el numero de un precio formateado tipo "2.067 €" - se asume
// formato es-ES (punto de miles), coherente con currency.js.
function parsePriceNumber(priceText) {
  if (!priceText) return null;
  const digits = String(priceText).replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

// Ordena los hoteles ya con precio en vivo segun lo que pida el cliente.
// 'barato': precio mas bajo primero. 'calidad': mejor nota primero. Por
// defecto (o 'calidad_precio'): mejor relacion nota/precio primero - el
// caso mas comun cuando no hay una preferencia clara.
function rankByPreference(hotels, pricePreference) {
  const withPrice = hotels.map((h) => ({ h, price: parsePriceNumber(h.totalPrice) }));
  const sorted = [...withPrice];
  if (pricePreference === 'barato') {
    sorted.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  } else if (pricePreference === 'calidad') {
    sorted.sort((a, b) => (b.h.reviewScore ?? 0) - (a.h.reviewScore ?? 0));
  } else {
    sorted.sort((a, b) => {
      const ratioA = a.price ? (a.h.reviewScore ?? 0) / a.price : 0;
      const ratioB = b.price ? (b.h.reviewScore ?? 0) / b.price : 0;
      return ratioB - ratioA;
    });
  }
  return sorted.map((x) => x.h);
}

// Antes de gastar llamadas reales a RapidAPI, reordena los candidatos del
// dataset local (ya filtrados por cercania) usando su referencePricePerNight
// orientativo - asi, si el cliente quiere "el mas barato", se pregunta antes
// a los candidatos que probablemente sean baratos en vez de ir a ciegas por
// cercania y arriesgarse a que los primeros con hueco sean los mas caros de
// la zona. Es solo el ORDEN en que se preguntan, no cambia cuales son
// candidatos validos (siguen siendo los mismos hoteles cercanos de siempre).
function orderCandidatesForQuerying(nearest, pricePreference) {
  const withRef = nearest.map((h, i) => ({ h, i, ref: h.referencePricePerNight }));
  const sorted = [...withRef];
  if (pricePreference === 'barato') {
    sorted.sort((a, b) => (a.ref ?? Infinity) - (b.ref ?? Infinity) || a.i - b.i);
  } else if (pricePreference === 'calidad') {
    sorted.sort((a, b) => (b.h.reviewScore ?? 0) - (a.h.reviewScore ?? 0) || a.i - b.i);
  } else if (pricePreference === 'calidad_precio') {
    sorted.sort((a, b) => {
      const ratioA = a.ref ? (a.h.reviewScore ?? 0) / a.ref : 0;
      const ratioB = b.ref ? (b.h.reviewScore ?? 0) / b.ref : 0;
      return ratioB - ratioA || a.i - b.i;
    });
  }
  // Sin preferencia: se deja el orden por cercania tal cual (el que ya
  // traia findNearestHotels).
  return sorted.map((x) => x.h);
}
// Consultarlos TODOS en paralelo satura el limite de peticiones por segundo
// del plan de RapidAPI (confirmado en produccion: "429 You have exceeded the
// rate limit per second for your plan, BASIC" - por eso a veces solo
// llegaban 2 de 3 en vez de los 3 pedidos). Se piden de uno en uno (cada uno
// ya hace 3 peticiones internas en paralelo: precio, fotos y detalle de
// habitacion), con una pausa entre hoteles, parando en cuanto se consiguen
// los 3 que hacen falta - prioriza que SIEMPRE lleguen 3 por encima de la
// velocidad maxima posible.
const GEO_BATCH_SIZE = 1;
const GEO_BATCH_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{query:string, checkin:string, checkout:string, adults?:string, rooms?:string, breakfast?:boolean, headless?:boolean, areaOnly?:boolean}} params
 */
export async function checkPrice({ query, checkin, checkout, adults = '2', rooms = '1', breakfast = false, headless = true, areaOnly = false, pricePreference = null }) {
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

  // Landmark/zona (p.ej. "Times Square", "Chelsea"): ni el hotel concreto ni
  // searchMultipleHotels de arriba pudieron responder (o directamente no
  // habia destId). En vez de depender del autocompletado de Booking para
  // saber donde esta ese sitio - se demostro poco fiable para landmarks en
  // el paso rapido de resolveHotelId, fallaba incluso tras reintentar - lo
  // geocodificamos nosotros mismos con Nominatim (gratis, instantaneo, sin
  // depender de Playwright en absoluto). Con esas coordenadas, buscamos los
  // hoteles reales mas cercanos en el dataset local y pedimos su precio en
  // vivo en paralelo via RapidAPI, antes de caer al fallback lento de
  // Playwright.
  if (!breakfast && !resolved.wasSpecificHotel) {
    let coords =
      typeof resolved.latitude === 'number' && typeof resolved.longitude === 'number'
        ? { latitude: resolved.latitude, longitude: resolved.longitude }
        : null;

    if (!coords) {
      const geocoded = await geocodePlace(query);
      if (geocoded) {
        console.log('[priceChecker] geocodificado con Nominatim ->', geocoded);
        coords = geocoded;
      }
    }

    if (coords) {
      const nearest = findNearestHotels({ latitude: coords.latitude, longitude: coords.longitude, limit: GEO_CANDIDATE_POOL });
      if (nearest.length > 0) {
        const queryOrder = orderCandidatesForQuerying(nearest, pricePreference);
        console.log('[priceChecker] usando busqueda por cercania geografica sobre el dataset local', {
          ...coords,
          pricePreference,
          ordenConsulta: queryOrder.map((h) => ({ name: h.name, distanceKm: h.distanceKm.toFixed(2), referencePricePerNight: h.referencePricePerNight })),
        });
        const found = [];
        for (let i = 0; i < queryOrder.length && found.length < GEO_RANKING_POOL; i += GEO_BATCH_SIZE) {
          const batch = queryOrder.slice(i, i + GEO_BATCH_SIZE);
          const results = await Promise.all(
            batch.map((h) => checkRapidApiPrice({ hotelId: h.hotelId, checkin, checkout, adults, rooms }))
          );
          for (const r of results) {
            if (r?.found) found.push(r);
          }
          if (found.length >= GEO_RANKING_POOL) break;
          if (i + GEO_BATCH_SIZE < queryOrder.length) await sleep(GEO_BATCH_DELAY_MS);
        }
        if (found.length > 0) {
          const ranked = rankByPreference(found, pricePreference).slice(0, GEO_RESULTS_WANTED);
          console.log('[priceChecker] busqueda por cercania: precios en vivo obtenidos', {
            reunidos: found.length,
            devueltos: ranked.length,
            pricePreference,
          });
          return { found: true, multiple: true, hotels: ranked, breakfastRequested: breakfast };
        }
        console.log('[priceChecker] busqueda por cercania: ningun hotel cercano tenia disponibilidad - va a Playwright');
      }
    }
  }

  // Fallback: zona/barrio sin destId, o RapidAPI no disponible/sin resultado
  // para estas fechas - reutilizamos la busqueda completa de Playwright tal
  // cual, que ya resuelve el destino por su cuenta y elige una sola opcion.
  console.log('[priceChecker] usando fallback de Playwright');
  return checkBookingPrice({ query, checkin, checkout, adults, rooms, breakfast, headless, preferArea: areaOnly });
}
