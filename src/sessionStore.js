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
};

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
  return JSON.stringify([slots.hotelQuery, slots.checkin, slots.checkout, slots.adults, slots.rooms, slots.breakfast]);
}
