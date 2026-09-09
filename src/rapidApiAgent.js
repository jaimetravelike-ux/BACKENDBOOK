// Agente aislado para RapidAPI (proveedor "Booking" de apidojo). Su unico
// trabajo es, dado un hotel_id de Booking.com ya resuelto (via
// bookingAgent.resolveHotelId), pedir el precio y el desglose de cargos
// extra (resort fee, impuestos no incluidos en el precio mostrado...) de
// forma rapida y estructurada - sin "navegar" Booking con un navegador real.
//
// Si esto falla, tarda demasiado, o no encuentra disponibilidad, devuelve
// null: el llamador (priceChecker.js) debe caer entonces al agente de
// Playwright (bookingAgent.checkBookingPrice) como red de seguridad. Nunca
// lanza fuera de aqui - cualquier fallo se trata como "no disponible via
// RapidAPI", nunca como error fatal de la conversacion.
//
// Esquema confirmado con datos reales de properties/detail (Hotel Edison
// Times Square, hotel_id=1169919): cada elemento de data.block[] trae
// product_price_breakdown con net_amount, gross_amount, all_inclusive_amount
// (el total real con todo incluido) y excluded_amount (impuestos/cargos no
// incluidos en gross_amount), ademas de items[] con el desglose linea a
// linea (kind: charge/discount, inclusion_type: included/excluded).

const RAPIDAPI_HOST = 'apidojo-booking-v1.p.rapidapi.com';
// UFI de la ciudad de Nueva York, confirmado en respuestas reales de
// properties/detail (campo wl_dest_id: "city::20088325").
const NYC_DEST_ID = '20088325';
const TIMEOUT_MS = 3000;

function pickBestBlock(blocks, { adults, rooms, breakfast }) {
  const wantedAdults = Number(adults) || 2;
  const wantedRooms = Number(rooms) || 1;

  const matchesCapacity = (b) => {
    const capacity = Number(b.nr_adults ?? b.max_occupancy ?? 0);
    const available = Number(b.room_count ?? 0);
    return capacity >= wantedAdults && available >= wantedRooms;
  };
  const matchesBreakfast = (b) => (breakfast ? Boolean(b.breakfast_included) : true);

  let pool = blocks.filter((b) => matchesCapacity(b) && matchesBreakfast(b));
  if (pool.length === 0) pool = blocks.filter(matchesCapacity);
  if (pool.length === 0) pool = blocks;
  if (pool.length === 0) return null;

  return pool.reduce((cheapest, b) => {
    const price = Number(b.product_price_breakdown?.all_inclusive_amount?.value ?? Infinity);
    const cheapestPrice = Number(cheapest?.product_price_breakdown?.all_inclusive_amount?.value ?? Infinity);
    return price < cheapestPrice ? b : cheapest;
  }, pool[0]);
}

// Los cargos ya vienen desglosados por Booking (incluidos y no incluidos en
// el precio base). Como usamos all_inclusive_amount como precio total, todos
// cuentan como "esto es lo que compone el total" - se lo mostramos al
// cliente igual que el aviso de cargos extra que ya daba el agente de
// Playwright, para mantener transparencia sobre resort fees/impuestos.
function buildExtraChargesSummary(breakdown) {
  if (!breakdown) return null;
  const chargeItems = (breakdown.items ?? []).filter((it) => it.kind === 'charge');
  if (chargeItems.length === 0) return null;
  const parts = chargeItems.map((it) => `${it.name}: ${it.item_amount?.amount_rounded ?? it.item_amount?.value}`);
  return `Incluye ${parts.join(', ')}`;
}

const MAX_PHOTOS = 5;

// Las fotos reales de la habitacion elegida viven en data.rooms[room_id].photos
// (confirmado con datos reales), no en el bloque de precio. Como ya sabemos
// exactamente que hotel es (hotel_id resuelto), estas fotos SI son del hotel
// correcto - a diferencia de las genericas de NYC que se usaban antes como
// respaldo cuando no habia forma fiable de saber la foto real.
function extractPhotos(data, roomId) {
  const photos = data?.rooms?.[roomId]?.photos;
  if (!Array.isArray(photos) || photos.length === 0) return [];
  return photos
    .slice(0, MAX_PHOTOS)
    .map((p) => p.url_original ?? p.url_max300)
    .filter(Boolean);
}

/**
 * @param {{hotelId:string|number, checkin:string, checkout:string, adults?:string, rooms?:string, breakfast?:boolean}} params
 * @returns {Promise<object|null>} resultado con found:true, o null si no se pudo usar RapidAPI (el llamador debe caer a Playwright).
 */
export async function checkRapidApiPrice({ hotelId, checkin, checkout, adults = '2', rooms = '1', breakfast = false }) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.warn('[rapidapi] sin RAPIDAPI_KEY configurada - saltando a Playwright');
    return null;
  }
  if (!hotelId || !checkin || !checkout) {
    console.warn('[rapidapi] faltan parametros obligatorios', { hotelId, checkin, checkout });
    return null;
  }

  const url = new URL(`https://${RAPIDAPI_HOST}/properties/detail`);
  url.searchParams.set('hotel_id', String(hotelId));
  url.searchParams.set('dest_ids', NYC_DEST_ID);
  url.searchParams.set('search_type', 'CITY');
  url.searchParams.set('arrival_date', checkin);
  url.searchParams.set('departure_date', checkout);
  url.searchParams.set('adults', String(adults));
  url.searchParams.set('room_qty', String(rooms));
  url.searchParams.set('currency_code', 'USD');
  url.searchParams.set('languagecode', 'es');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': RAPIDAPI_HOST,
      },
    });
    if (!res.ok) {
      const bodySnippet = await res.text().catch(() => '');
      console.warn('[rapidapi] respuesta no OK', res.status, bodySnippet.slice(0, 300));
      return null;
    }

    const json = await res.json();
    const data = Array.isArray(json) ? json[0] : json;
    if (!data || data.soldout === 1 || !Array.isArray(data.block) || data.block.length === 0) {
      // Sin disponibilidad via RapidAPI para estas fechas/hotel - no es un
      // error, simplemente esta fuente no nos sirve ahora mismo.
      console.warn('[rapidapi] sin bloques disponibles', {
        hotelId,
        soldout: data?.soldout,
        blockCount: Array.isArray(data?.block) ? data.block.length : 'sin campo block',
      });
      return null;
    }

    const chosen = pickBestBlock(data.block, { adults, rooms, breakfast });
    const breakdown = chosen?.product_price_breakdown;
    if (!chosen || !breakdown) {
      console.warn('[rapidapi] no se encontro bloque/breakdown valido tras filtrar', { hotelId, adults, rooms });
      return null;
    }

    console.log('[rapidapi] OK', { hotelId, hotel: data.hotel_name, price: breakdown.all_inclusive_amount?.amount_rounded });
    return {
      found: true,
      hotel: data.hotel_name ?? null,
      totalPrice: breakdown.all_inclusive_amount?.amount_rounded ?? null,
      breakfastMentionedOnCard: Boolean(chosen.breakfast_included),
      extraChargesNotice: buildExtraChargesSummary(breakdown),
      cancellationPolicy:
        chosen.transactional_policy_data?.policies?.find((p) => p.policy_type_key === 'free_cancellation')?.text ?? null,
      // Fotos reales del hotel/habitacion (solo disponibles cuando el precio
      // viene de RapidAPI - el fallback de Playwright no las trae, el widget
      // debe seguir usando la foto generica de NYC en ese caso).
      photos: extractPhotos(data, chosen.room_id),
      checkin,
      checkout,
      adults,
      rooms,
    };
  } catch (err) {
    // Timeout, red caida, JSON invalido... cualquier fallo aqui se trata
    // igual que "sin disponibilidad" - nunca debe tumbar la conversacion.
    console.warn('[rapidapi] excepcion', err?.name, err?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
