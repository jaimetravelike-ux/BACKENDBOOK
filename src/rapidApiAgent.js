// Agente aislado para RapidAPI. Dos usos:
//  1. checkRapidApiPrice: dado un hotel_id de Booking.com ya resuelto (via
//     bookingAgent.resolveHotelId, con Playwright), pedir el precio y el
//     desglose de cargos extra (resort fee, impuestos no incluidos...) de
//     ese hotel concreto.
//  2. searchMultipleHotels: cuando la busqueda NO apunta a un hotel concreto
//     (zona o "hoteles en Nueva York" en general), pedir varias opciones
//     reales dentro de esa misma zona/ciudad (las mas baratas), en vez de
//     que Playwright elija una sola en silencio.
//
// Si algo falla, tarda demasiado, o no encuentra disponibilidad, ambas
// funciones devuelven null: el llamador (priceChecker.js) debe caer
// entonces al agente de Playwright (bookingAgent.checkBookingPrice) como
// red de seguridad. Nunca lanzan fuera de aqui.
//
// NOTA HISTORICA: la primera version de este agente usaba el proveedor
// "apidojo" (properties/detail). Se cambio al proveedor "tipsters" porque
// apidojo devolvia soldout:1/block:[] de forma inconsistente para peticiones
// identicas (confirmado comparando directamente contra su propio playground,
// no era un problema de nuestros parametros). El endpoint de tipsters usado
// aqui (v1/hotels/search) es una busqueda de disponibilidad real, no una
// consulta de "detalle" de un hotel concreto, y no mostro ese problema en las
// pruebas. Los UFI/dest_id de Booking.com son los mismos entre ambos
// proveedores (confirmado: dest_id de Nueva York = 20088325 en los dos), y
// tambien coinciden con los dest_id/dest_type que da el propio autocompletado
// de Booking que usa bookingAgent.js (confirmado con datos reales).
//
// Esquema confirmado con datos reales (search hotels): cada hotel real en
// result[] tiene type:"property_card" y trae composite_price_breakdown con
// net_amount, gross_amount, all_inclusive_amount (el total real con todo
// incluido) y excluded_amount (impuestos/cargos no incluidos en
// gross_amount), ademas de items[] con el desglose linea a linea (kind:
// charge/discount, inclusion_type: included/excluded).

const RAPIDAPI_HOST = 'booking-com.p.rapidapi.com';
const TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nightsBetween(checkin, checkout) {
  const ms = new Date(checkout) - new Date(checkin);
  const nights = Math.round(ms / 86400000);
  return Number.isFinite(nights) && nights > 0 ? nights : null;
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

// Descuento real (precio tachado vs precio final), cuando Booking lo marca
// como tal - no lo inventamos si no viene en la respuesta.
function extractDiscount(breakdown) {
  const original = breakdown.strikethrough_amount?.value;
  const final = breakdown.all_inclusive_amount?.value ?? breakdown.gross_amount?.value;
  if (!original || !final || original <= final) return null;
  const percent = Math.round((1 - final / original) * 100);
  if (percent <= 0) return null;
  return {
    originalPrice: breakdown.strikethrough_amount?.amount_rounded ?? null,
    percent,
    label: breakdown.benefits?.[0]?.name ?? `-${percent}%`,
  };
}

const ROOM_NAME_TIMEOUT_MS = 3000;

// Construye un texto de politica de cancelacion legible en español a partir
// del bloque de tarifa de v1/hotels/room-list. Mucho mas detallado que el
// booleano is_free_cancellable de v1/hotels/search: aqui viene la fecha
// limite real de cancelacion gratuita (block.paymentterms.cancellation,
// confirmado con datos reales - cuando refundable:1 trae date_raw con la
// fecha limite en formato YYYY-MM-DD; cuando refundable:0 es no reembolsable).
function buildCancellationPolicy(block) {
  const cancellation = block?.paymentterms?.cancellation;
  if (!cancellation) return null;
  if (cancellation.refundable === 1) {
    if (cancellation.date_raw) {
      const deadline = new Date(`${cancellation.date_raw}T00:00:00`);
      if (!Number.isNaN(deadline.getTime())) {
        const formatted = deadline.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
        return `Cancelación gratuita hasta el ${formatted}`;
      }
    }
    return 'Cancelación gratuita';
  }
  return 'No reembolsable';
}

// v1/hotels/room-list da el nombre real de la habitacion concreta que se
// esta reservando (p.ej. "Signature 1 King Bed"), algo que v1/hotels/search
// no trae (solo un unit_type_id interno sin nombre), y tambien la politica de
// cancelacion detallada de esa misma tarifa (ver buildCancellationPolicy).
// Devuelve los datos de la primera oferta (la que se corresponde con el
// precio ya mostrado) o valores null si falla/tarda - nunca bloquea ni rompe
// el flujo de precio.
// Regimen real de la tarifa (desayuno incluido, solo alojamiento...). El
// nombre exacto del campo en block.mealplan no esta confirmado todavia con
// datos reales (a diferencia de name_without_policy y paymentterms.cancellation,
// que ya se verificaron en su momento) - se prueban varias rutas plausibles
// y, si ninguna trae texto, se queda en null sin romper nada (igual que
// roomName/cancellationPolicy cuando fallan).
function buildMealPlanText(block) {
  const mp = block?.mealplan;
  const candidates = [
    typeof mp === 'string' ? mp : null,
    mp?.included_name,
    mp?.name,
    mp?.text,
    block?.mealplan_included_name,
    block?.block_text?.mealplan_included_name,
  ];
  const found = candidates.find((v) => typeof v === 'string' && v.trim());
  return found ? found.trim() : null;
}

async function fetchRoomDetails(hotelId, { checkin, checkout, adults }) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey || !hotelId) return { roomName: null, cancellationPolicy: null, mealPlanText: null };

  const url = new URL(`https://${RAPIDAPI_HOST}/v1/hotels/room-list`);
  url.searchParams.set('hotel_id', String(hotelId));
  url.searchParams.set('checkin_date', checkin);
  url.searchParams.set('checkout_date', checkout);
  url.searchParams.set('adults_number_by_rooms', String(adults || '2'));
  url.searchParams.set('units', 'metric');
  url.searchParams.set('currency', 'USD');
  url.searchParams.set('query', '');
  url.searchParams.set('locale', 'en-gb');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROOM_NAME_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': RAPIDAPI_HOST },
    });
    if (!res.ok) return { roomName: null, cancellationPolicy: null, mealPlanText: null };
    const json = await res.json();
    const offers = Array.isArray(json) ? json : [];
    const block = offers[0]?.block?.[0];
    const name = block?.name_without_policy ?? null;
    return {
      roomName: typeof name === 'string' && name.trim() ? name.trim() : null,
      cancellationPolicy: buildCancellationPolicy(block),
      mealPlanText: buildMealPlanText(block),
    };
  } catch (err) {
    console.warn('[rapidapi] detalles de habitacion: excepcion (se omite)', err?.name, err?.message);
    return { roomName: null, cancellationPolicy: null, mealPlanText: null };
  } finally {
    clearTimeout(timer);
  }
}

// Convierte un property_card crudo de RapidAPI en el formato enriquecido que
// ya sabe pintar el widget (mismo shape se use para un hotel concreto o
// como uno de varios resultados de una busqueda general).
// distance_to_cc viene en km (numero decimal) directamente del property_card
// de RapidAPI - es el mismo dato que usa la propia Booking para su "a X km
// del centro". Se formatea aqui para no repetir el redondeo en el widget.
function formatDistanceToCenter(hotel) {
  // Confirmado con datos reales: distance_to_cc suele venir vacio/0 para
  // este proveedor, pero distance_to_cc_formatted (texto ya formateado por
  // la propia Booking, ej. "2.8 km") SI trae valor.
  if (typeof hotel.distance_to_cc_formatted === 'string' && hotel.distance_to_cc_formatted.trim()) {
    return `A ${hotel.distance_to_cc_formatted.trim()} del centro`;
  }
  const km = hotel.distance_to_cc ?? hotel.distance;
  if (typeof km === 'number' && Number.isFinite(km) && km > 0) {
    const rounded = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
    const text = String(rounded).replace('.', ',');
    return `A ${text} km del centro`;
  }
  return null;
}

// Barrio/zona (Times Square, Chelsea, Brooklyn...) para un badge compacto en
// la card. Confirmado con datos reales: hotel.district trae directamente el
// nombre del barrio (ej. "Chelsea").
function extractNeighborhood(hotel) {
  return typeof hotel.district === 'string' && hotel.district.trim() ? hotel.district.trim() : null;
}

function parseHotelCard(hotel, { checkin, checkout, adults, rooms }) {
  const breakdown = hotel.composite_price_breakdown;
  if (!breakdown) return null;
  const photo = hotel.max_photo_url ?? hotel.main_photo_url ?? null;
  const discount = extractDiscount(breakdown);

  return {
    found: true,
    hotel: hotel.hotel_name ?? null,
    city: hotel.city_name_en ?? hotel.city ?? null,
    neighborhood: extractNeighborhood(hotel),
    distanceToCenter: formatDistanceToCenter(hotel),
    stars: hotel.class ?? null,
    reviewScore: hotel.review_score ?? null,
    reviewScoreWord: hotel.review_score_word ?? null,
    reviewCount: hotel.review_nr ?? null,
    totalPrice: breakdown.all_inclusive_amount?.amount_rounded ?? null,
    pricePerNight: breakdown.gross_amount_per_night?.amount_rounded ?? null,
    includedTaxesAmount: breakdown.included_taxes_and_charges_amount?.amount_rounded ?? null,
    discount,
    nights: nightsBetween(checkin, checkout),
    breakfastMentionedOnCard: Boolean(hotel.hotel_include_breakfast),
    extraChargesNotice: buildExtraChargesSummary(breakdown),
    cancellationPolicy: hotel.is_free_cancellable ? 'Cancelación gratuita' : 'No reembolsable',
    // Se rellenan aparte (fetchRoomDetails) solo para hotel concreto - null
    // hasta entonces, y se quedan null si esa llamada falla o tarda demasiado.
    roomName: null,
    mealPlanText: null,
    // Solo una foto real por ahora (max_photo_url/main_photo_url) - a
    // diferencia del fallback generico de NYC, esta SI es del hotel
    // correcto porque la busqueda fue por su hotel_id/zona exacta.
    photos: photo ? [photo] : [],
    checkin,
    checkout,
    adults,
    rooms,
  };
}

const PHOTOS_TIMEOUT_MS = 3000;
const MAX_PHOTOS = 6;

// Endpoint dedicado de galeria (v1/hotels/photos) - de verdad tiene fotos
// reales del hotel (decenas), a diferencia de v1/hotels/search que solo trae
// una unica foto "representativa". Se llama en paralelo al precio para no
// alargar el tiempo de respuesta; si falla o tarda, se sigue con la unica
// foto que ya trae la busqueda de precio (nunca bloquea ni rompe nada).
async function fetchHotelPhotos(hotelId, apiKey) {
  const url = new URL(`https://${RAPIDAPI_HOST}/v1/hotels/photos`);
  url.searchParams.set('hotel_id', String(hotelId));
  url.searchParams.set('locale', 'en-gb');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PHOTOS_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': RAPIDAPI_HOST,
      },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const list = Array.isArray(json) ? json : [];
    return list
      .slice(0, MAX_PHOTOS)
      .map((p) => p.url_1440 ?? p.url_max ?? p.url_square60 ?? null)
      .filter(Boolean);
  } catch (err) {
    console.warn('[rapidapi] fotos: excepcion (se sigue solo con la foto principal)', err?.name, err?.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHotelSearch({ destType, destId, checkin, checkout, adults, rooms, orderBy, apiKey }) {
  const url = new URL(`https://${RAPIDAPI_HOST}/v1/hotels/search`);
  url.searchParams.set('dest_type', String(destType || 'city').toLowerCase());
  url.searchParams.set('dest_id', String(destId));
  url.searchParams.set('checkin_date', checkin);
  url.searchParams.set('checkout_date', checkout);
  url.searchParams.set('adults_number', String(adults));
  url.searchParams.set('room_number', String(rooms));
  url.searchParams.set('filter_by_currency', 'USD');
  url.searchParams.set('locale', 'en-gb');
  url.searchParams.set('units', 'metric');
  url.searchParams.set('order_by', orderBy);
  url.searchParams.set('page_number', '0');
  url.searchParams.set('include_adjacency', 'false');

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
    const results = Array.isArray(json?.result) ? json.result : [];
    return results.filter((r) => r?.type === 'property_card' && r?.composite_price_breakdown);
  } catch (err) {
    // Timeout, red caida, JSON invalido... cualquier fallo aqui se trata
    // igual que "sin disponibilidad" - nunca debe tumbar la conversacion.
    console.warn('[rapidapi] excepcion', err?.name, err?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{hotelId:string|number, checkin:string, checkout:string, adults?:string, rooms?:string}} params
 * @returns {Promise<object|null>} resultado con found:true, o null si no se pudo usar RapidAPI (el llamador debe caer a Playwright).
 */
export async function checkRapidApiPrice({ hotelId, checkin, checkout, adults = '2', rooms = '1' }) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.warn('[rapidapi] sin RAPIDAPI_KEY configurada - saltando a Playwright');
    return null;
  }
  if (!hotelId || !checkin || !checkout) {
    console.warn('[rapidapi] faltan parametros obligatorios', { hotelId, checkin, checkout });
    return null;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const [cards, galleryPhotos, roomDetails] = await Promise.all([
      fetchHotelSearch({
        destType: 'hotel',
        destId: hotelId,
        checkin,
        checkout,
        adults,
        rooms,
        orderBy: 'popularity',
        apiKey,
      }),
      fetchHotelPhotos(hotelId, apiKey),
      fetchRoomDetails(hotelId, { checkin, checkout, adults }),
    ]);
    const parsed = cards?.[0] ? parseHotelCard(cards[0], { checkin, checkout, adults, rooms }) : null;
    if (parsed) {
      // La galeria real (si llego a tiempo) sustituye a la unica foto
      // "representativa" que trae la busqueda de precio.
      if (galleryPhotos.length > 0) parsed.photos = galleryPhotos;
      parsed.roomName = roomDetails.roomName;
      // La politica detallada de room-list (con fecha limite si aplica)
      // sustituye al booleano generico de v1/hotels/search cuando esta
      // disponible - si esta llamada fallo/tardo, se queda el valor ya
      // puesto por parseHotelCard a partir de is_free_cancellable.
      if (roomDetails.cancellationPolicy) parsed.cancellationPolicy = roomDetails.cancellationPolicy;
      parsed.mealPlanText = roomDetails.mealPlanText;
      console.log('[rapidapi] OK', { hotelId, hotel: parsed.hotel, price: parsed.totalPrice, photos: parsed.photos.length, roomName: roomDetails.roomName, cancellationPolicy: parsed.cancellationPolicy, mealPlanText: parsed.mealPlanText, distanceToCenter: parsed.distanceToCenter });
      return parsed;
    }
    console.warn('[rapidapi] sin resultado con precio para este hotel_id', { hotelId, attempt });
    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }
  return null;
}

/**
 * Varias opciones reales (las mas baratas) dentro de una zona/ciudad, para
 * cuando la busqueda NO resuelve a un hotel concreto - en vez de que
 * Playwright elija uno solo en silencio entre los primeros resultados.
 * @param {{destId:string|number, destType?:string, checkin:string, checkout:string, adults?:string, rooms?:string, limit?:number}} params
 * @returns {Promise<object[]|null>} array de resultados con found:true (hasta `limit`), o null si no se pudo usar RapidAPI.
 */
export async function searchMultipleHotels({ destId, destType, checkin, checkout, adults = '2', rooms = '1', limit = 3 }) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey || !destId || !checkin || !checkout) {
    console.warn('[rapidapi] searchMultipleHotels: faltan parametros o RAPIDAPI_KEY', { destId, checkin, checkout });
    return null;
  }

  const cards = await fetchHotelSearch({
    destType,
    destId,
    checkin,
    checkout,
    adults,
    rooms,
    orderBy: 'price',
    apiKey,
  });
  if (!cards || cards.length === 0) {
    console.warn('[rapidapi] searchMultipleHotels sin resultados', { destId, destType });
    return null;
  }

  const parsed = cards
    .slice(0, limit)
    .map((c) => parseHotelCard(c, { checkin, checkout, adults, rooms }))
    .filter(Boolean);
  if (parsed.length === 0) return null;

  console.log('[rapidapi] searchMultipleHotels OK', { destId, destType, count: parsed.length });
  return parsed;
}
