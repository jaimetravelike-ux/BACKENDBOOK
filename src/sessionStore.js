// Estado de conversacion en memoria, por sesion. Vale para v1 (un solo proceso);
// si el bot crece a varias instancias, esto pasaria a Redis o similar.

const sessions = new Map();

const EMPTY_SLOTS = {
  hotelQuery: null, // lo que el cliente escribio (hotel o zona)
  checkin: null, // YYYY-MM-DD
  checkout: null, // YYYY-MM-DD
  adults: null,
  rooms: null,
  breakfast: null, // true | false | null (sin preferencia)
  // true si el cliente ha dicho explicitamente que no quiere un hotel
  // concreto (p.ej. tras una desambiguacion) y prefiere varias opciones de
  // la zona - ver preferArea en bookingAgent.js/priceChecker.js.
  noSpecificHotel: null,
  // 'barato' | 'calidad' | 'calidad_precio' | null (sin preferencia clara,
  // se trata como 'calidad_precio' al elegir entre varios hoteles de zona).
  pricePreference: null,
};

export function hasSession(sessionId) {
  return sessions.has(sessionId);
}

export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      history: [], // [{role: 'user'|'assistant', content: string}]
      slots: { ...EMPTY_SLOTS },
      lastSearchedKey: null, // evita relanzar la misma busqueda dos veces
      pendingSearch: false,
    });
  }
  return sessions.get(sessionId);
}

export function slotsComplete(slots) {
  return Boolean(slots.hotelQuery && slots.checkin && slots.checkout);
}

export function searchKey(slots) {
  return JSON.stringify([slots.hotelQuery, slots.checkin, slots.checkout, slots.adults, slots.rooms, slots.breakfast, slots.noSpecificHotel, slots.pricePreference]);
}
