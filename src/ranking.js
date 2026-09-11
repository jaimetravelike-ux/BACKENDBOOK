// Ordena hoteles ya con precio en vivo segun la preferencia del cliente.
// Compartido entre priceChecker.js (busqueda por cercania geografica) y
// rapidApiAgent.js (busqueda por ciudad/zona con destId) para que el
// "barato"/"calidad"/"calidad_precio" del cliente se respete siempre, sea
// cual sea el camino que haya resuelto la busqueda.

// Extrae el numero de un precio formateado tipo "2.067 €" o "US$1,534" -
// funciona con separador de miles tanto en punto (es-ES) como en coma (en-US).
export function parsePriceNumber(priceText) {
  if (!priceText) return null;
  const digits = String(priceText).replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

/**
 * @param {object[]} hotels - ya con found:true, totalPrice, reviewScore, stars
 * @param {'barato'|'calidad'|'calidad_precio'|null} pricePreference
 */
export function rankByPreference(hotels, pricePreference) {
  const withPrice = hotels.map((h) => ({ h, price: parsePriceNumber(h.totalPrice) }));
  const sorted = [...withPrice];
  if (pricePreference === 'barato') {
    sorted.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  } else if (pricePreference === 'calidad') {
    // "Lujo"/"5 estrellas"/"exclusivo": las estrellas mandan (un 3 estrellas
    // con muy buena nota no es lo que se pide al pedir lujo), la nota de
    // opiniones solo desempata entre hoteles de la misma categoria.
    sorted.sort((a, b) => (b.h.stars ?? 0) - (a.h.stars ?? 0) || (b.h.reviewScore ?? 0) - (a.h.reviewScore ?? 0));
  } else {
    sorted.sort((a, b) => {
      const ratioA = a.price ? (a.h.reviewScore ?? 0) / a.price : 0;
      const ratioB = b.price ? (b.h.reviewScore ?? 0) / b.price : 0;
      return ratioB - ratioA;
    });
  }
  return sorted.map((x) => x.h);
}
