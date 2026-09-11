// Conversion de precio (mostrado en USD por RapidAPI) a la moneda local del
// visitante, a partir del pais ya detectado por IP (geoip.js). Igual que el
// resto de integraciones externas del proyecto: si algo falla (API caida,
// pais no soportado...) se sigue mostrando el precio en USD tal cual, nunca
// se rompe la respuesta al cliente por esto.

// Mapeo pais (ISO alpha-2) -> moneda. null significa "no convertir" (el pais
// ya usa USD de forma oficial, como Panama, Ecuador o El Salvador, o es
// Estados Unidos). Centrado en el publico real de BedCopilot (España y
// Latinoamerica), mas los paises grandes de Europa como referencia.
const COUNTRY_CURRENCY = {
  ES: 'EUR',
  MX: 'MXN',
  AR: 'ARS',
  CO: 'COP',
  CL: 'CLP',
  PE: 'PEN',
  CR: 'CRC',
  GT: 'GTQ',
  HN: 'HNL',
  NI: 'NIO',
  DO: 'DOP',
  UY: 'UYU',
  PY: 'PYG',
  BO: 'BOB',
  VE: 'VES',
  PA: null, // Panama - usa USD oficialmente
  EC: null, // Ecuador - usa USD oficialmente
  SV: null, // El Salvador - usa USD oficialmente
  US: null, // ya esta en USD
  GB: 'GBP',
  FR: 'EUR',
  DE: 'EUR',
  IT: 'EUR',
  PT: 'EUR',
  NL: 'EUR',
  BR: 'BRL',
};

export function currencyForCountryCode(countryCode) {
  if (!countryCode) return null;
  return COUNTRY_CURRENCY[countryCode.toUpperCase()] ?? null;
}

// Tipos de cambio cacheados en memoria un dia entero - no hace falta mas
// precision para mostrar un precio orientativo, y evita depender de la API
// externa en cada busqueda de un cliente.
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const RATES_TIMEOUT_MS = 4000;
let ratesCache = { rates: null, fetchedAt: 0 };

async function getRates() {
  const now = Date.now();
  if (ratesCache.rates && now - ratesCache.fetchedAt < RATES_TTL_MS) {
    return ratesCache.rates;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATES_TIMEOUT_MS);
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: controller.signal });
    if (!res.ok) return ratesCache.rates;
    const json = await res.json();
    if (json.result !== 'success' || !json.rates) return ratesCache.rates;
    ratesCache = { rates: json.rates, fetchedAt: now };
    return ratesCache.rates;
  } catch (err) {
    console.warn('[currency] no se pudo actualizar el tipo de cambio (se sigue en USD)', err?.name, err?.message);
    return ratesCache.rates;
  } finally {
    clearTimeout(timer);
  }
}

// Devuelve una funcion convert(usdAmount) -> texto formateado en la moneda
// destino, o null si no se pudo (API caida sin cache previa, moneda sin
// tipo de cambio...). El llamador debe entonces dejar el precio en USD.
export async function getConverter(targetCurrency) {
  if (!targetCurrency || targetCurrency === 'USD') return null;
  const rates = await getRates();
  const rate = rates?.[targetCurrency];
  if (!rate) return null;

  let formatter;
  try {
    formatter = new Intl.NumberFormat('es-ES', { style: 'currency', currency: targetCurrency, maximumFractionDigits: 0 });
  } catch {
    return null; // codigo de moneda no valido para Intl - no debería pasar con el mapeo de arriba, pero por si acaso
  }

  return (usdAmount) => {
    if (typeof usdAmount !== 'number' || !Number.isFinite(usdAmount)) return null;
    return formatter.format(usdAmount * rate);
  };
}

// Sustituye cada importe "US$1,234" o "US$1,234.56" de un texto por su
// equivalente ya convertido. Si el texto no tiene importes en USD (p.ej. ya
// viene en EUR del fallback de Playwright), se devuelve tal cual - nunca se
// inventa una conversion sobre una moneda que no se sabe cual es.
export function convertUsdAmountsInText(text, convert) {
  if (!text || typeof text !== 'string' || !convert) return text;
  // El grupo de miles exige exactamente 3 digitos tras cada coma, para no
  // tragarse una coma que en realidad separa distintos importes en el mismo
  // texto (p.ej. "US$256, City tax: US$7" - sin esto, la "," final de "256,"
  // se comia como si fuera separador de miles y desaparecia del texto).
  return text.replace(/US\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/g, (match, numStr) => {
    const num = Number(numStr.replace(/,/g, ''));
    const converted = convert(num);
    return converted ?? match;
  });
}

// Aplica la conversion a todos los campos de precio conocidos de un
// resultado de busqueda (found:true simple, o found:true + multiple con
// varios hoteles). Los demas campos (needsDisambiguation, notFoundInNewYork,
// found:false...) no tienen precio y se devuelven sin tocar.
export function convertResultCurrency(result, convert) {
  if (!result || !convert) return result;

  const convertHotel = (h) => {
    if (!h) return h;
    const next = {
      ...h,
      totalPrice: convertUsdAmountsInText(h.totalPrice, convert),
      pricePerNight: convertUsdAmountsInText(h.pricePerNight, convert),
      includedTaxesAmount: convertUsdAmountsInText(h.includedTaxesAmount, convert),
      extraChargesNotice: convertUsdAmountsInText(h.extraChargesNotice, convert),
    };
    if (h.discount) {
      next.discount = { ...h.discount, originalPrice: convertUsdAmountsInText(h.discount.originalPrice, convert) };
    }
    return next;
  };

  if (Array.isArray(result.hotels)) {
    return { ...result, hotels: result.hotels.map(convertHotel) };
  }
  return convertHotel(result);
}
