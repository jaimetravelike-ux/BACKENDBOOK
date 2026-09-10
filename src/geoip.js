// Geolocalizacion de IP para saber de que pais/ciudad viene cada visitante
// nuevo del chat. Usa ipwho.is (gratis, sin API key). Nunca lanza excepcion -
// un fallo aqui no debe romper la respuesta del chat al cliente.

const GEO_TIMEOUT_MS = 3000;

function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  const clean = ip.replace('::ffff:', '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  if (/^10\./.test(clean)) return true;
  if (/^192\.168\./.test(clean)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)) return true;
  return false;
}

export async function lookupGeo(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return { country: null, city: null };
  }

  const clean = ip.replace('::ffff:', '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}`, { signal: controller.signal });
    if (!res.ok) return { country: null, city: null };
    const json = await res.json();
    if (!json.success) return { country: null, city: null };
    return {
      country: typeof json.country === 'string' ? json.country : null,
      city: typeof json.city === 'string' ? json.city : null,
    };
  } catch (err) {
    console.warn('[geoip] no se pudo geolocalizar la IP (se omite)', err?.name, err?.message);
    return { country: null, city: null };
  } finally {
    clearTimeout(timer);
  }
}

// Etiqueta legible de por donde llego el visitante, a partir del referrer y
// de parametros utm_* si vienen en la URL de aterrizaje.
export function computeTrafficSource({ referrer, utmSource, utmMedium }) {
  if (utmSource) {
    const src = utmSource.charAt(0).toUpperCase() + utmSource.slice(1);
    return utmMedium ? `${src} (${utmMedium})` : src;
  }
  if (!referrer) return 'Directo (sin referido)';
  let host = '';
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return 'Directo (sin referido)';
  }
  if (host.includes('google.')) return 'Google (búsqueda orgánica)';
  if (host.includes('instagram.com')) return 'Instagram';
  if (host.includes('facebook.com') || host.includes('fb.com')) return 'Facebook';
  if (host.includes('t.co') || host.includes('twitter.com') || host.includes('x.com')) return 'Twitter/X';
  return host || 'Directo (sin referido)';
}

// A partir de la URL completa de aterrizaje, extrae utm_source/medium/campaign
// si estan presentes. Nunca lanza - una URL rara simplemente no aporta utms.
export function parseUtmParams(landingUrl) {
  if (!landingUrl) return { utmSource: null, utmMedium: null, utmCampaign: null };
  try {
    const url = new URL(landingUrl);
    return {
      utmSource: url.searchParams.get('utm_source'),
      utmMedium: url.searchParams.get('utm_medium'),
      utmCampaign: url.searchParams.get('utm_campaign'),
    };
  } catch {
    return { utmSource: null, utmMedium: null, utmCampaign: null };
  }
}
