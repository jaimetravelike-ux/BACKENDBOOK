// Modulo de pago con interruptor limpio mock/produccion. Mientras el banco
// aprueba los terminos legales de Redsys, USE_PAYMENT_MOCK=true (o no estar
// definida) hace que todo pago se resuelva contra un simulador local, sin
// tocar la logica que lo llama. El dia que lleguen las credenciales reales,
// basta con poner USE_PAYMENT_MOCK=false y rellenar las variables
// REDSYS_MERCHANT_CODE / REDSYS_TERMINAL / REDSYS_SECRET_KEY en Railway - el
// resto del codigo (quien llama a createPaymentRedirect) no cambia.
//
// Firma de Redsys: implementada siguiendo el algoritmo oficial (Guía de
// Integración - Redirección, "Cálculo de la firma"): diversificacion de la
// clave de comercio con 3DES-CBC usando el numero de pedido como IV/dato, y
// HMAC-SHA256 de los Ds_MerchantParameters en base64 con esa clave
// diversificada. No se ha podido probar contra el entorno de pruebas real de
// Redsys por no disponer de credenciales - antes de aceptar el primer pago
// real, verificar con el simulador de Redsys (entorno de test) que la firma
// generada aqui coincide con la esperada.

import crypto from 'node:crypto';

const isMock = () => process.env.USE_PAYMENT_MOCK !== 'false';

const REDSYS_URLS = {
  test: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  production: 'https://sis.redsys.es/sis/realizarPago',
};

// Codigos ISO-4217 numericos que usa Redsys (no el codigo de 3 letras).
const REDSYS_CURRENCY_CODES = { EUR: '978', USD: '840', GBP: '826' };

// --- Simulador local (mock) ---------------------------------------------

// Nunca hace una llamada real ni requiere credenciales. Simula siempre un
// pago aceptado, salvo que se le pida explicitamente que falle (util para
// probar el camino de error del checkout sin depender de Redsys).
function createMockPayment({ orderId, amount, currency, description, forceFail = false }) {
  console.log('[payment] MOCK: creando pago de prueba', { orderId, amount, currency, description });
  return {
    mock: true,
    orderId,
    // En real esto seria una redireccion a Redsys; en mock se puede usar
    // para enseñar una pantalla de "pago simulado" propia si hiciera falta.
    redirectUrl: null,
    status: forceFail ? 'error' : 'authorized',
    message: forceFail
      ? 'Pago simulado fallido (forceFail activado) - entorno de pruebas, sin cargo real.'
      : 'Pago simulado aceptado - entorno de pruebas, sin cargo real.',
  };
}

// --- Redsys real ----------------------------------------------------------

// Redsys entrega la clave de comercio en base64. Descodificada puede venir
// en 16 bytes (2-key triple DES) o 24 bytes (3-key) - Node exige 24 bytes
// para des-ede3-cbc, asi que si vienen 16 se completa repitiendo los
// primeros 8 (tecnica estandar de "extension de clave" documentada por
// Redsys y usada por sus SDKs oficiales).
function normalizeDesKey(rawKey) {
  if (rawKey.length === 24) return rawKey;
  if (rawKey.length === 16) return Buffer.concat([rawKey, rawKey.subarray(0, 8)]);
  throw new Error(`REDSYS_SECRET_KEY con longitud inesperada tras decodificar base64: ${rawKey.length} bytes (se esperan 16 o 24)`);
}

function diversifyKey(secretKeyBase64, orderId) {
  const key = normalizeDesKey(Buffer.from(secretKeyBase64, 'base64'));
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, Buffer.alloc(8, 0));
  cipher.setAutoPadding(false);
  const orderBuf = Buffer.from(orderId, 'utf8');
  const paddedLength = Math.ceil(orderBuf.length / 8) * 8 || 8;
  const padded = Buffer.concat([orderBuf, Buffer.alloc(paddedLength - orderBuf.length, 0)]);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function signRedsysParams(merchantParamsBase64, orderId, secretKeyBase64) {
  const orderKey = diversifyKey(secretKeyBase64, orderId);
  return crypto.createHmac('sha256', orderKey).update(merchantParamsBase64).digest('base64');
}

// amount en unidades principales (p.ej. 150.5 = 150,50 USD) - Redsys exige
// el importe en la unidad minima (centimos) como string sin decimales.
function createRedsysPayment({ orderId, amount, currency, description }) {
  const merchantCode = process.env.REDSYS_MERCHANT_CODE;
  const terminal = process.env.REDSYS_TERMINAL;
  const secretKey = process.env.REDSYS_SECRET_KEY;
  const merchantUrl = process.env.REDSYS_MERCHANT_URL; // notificacion server-to-server
  const urlOk = process.env.REDSYS_URL_OK;
  const urlKo = process.env.REDSYS_URL_KO;

  if (!merchantCode || !terminal || !secretKey) {
    throw new Error('Faltan credenciales de Redsys (REDSYS_MERCHANT_CODE / REDSYS_TERMINAL / REDSYS_SECRET_KEY) - revisa las variables de entorno en Railway.');
  }

  const currencyCode = REDSYS_CURRENCY_CODES[currency];
  if (!currencyCode) {
    throw new Error(`Moneda no soportada por este modulo de Redsys: ${currency}`);
  }

  // DS_MERCHANT_ORDER: 4 a 12 caracteres, los 4 primeros numericos (regla de
  // Redsys) - se antepone un prefijo numerico fijo si el orderId propio no
  // empieza por digitos.
  const dsOrder = /^\d{4}/.test(orderId) ? orderId.slice(0, 12) : `0000${orderId}`.slice(0, 12);

  const merchantParams = {
    DS_MERCHANT_AMOUNT: String(Math.round(amount * 100)),
    DS_MERCHANT_ORDER: dsOrder,
    DS_MERCHANT_MERCHANTCODE: merchantCode,
    DS_MERCHANT_CURRENCY: currencyCode,
    DS_MERCHANT_TRANSACTIONTYPE: '0', // 0 = autorizacion estandar
    DS_MERCHANT_TERMINAL: terminal,
    DS_MERCHANT_MERCHANTURL: merchantUrl ?? '',
    DS_MERCHANT_URLOK: urlOk ?? '',
    DS_MERCHANT_URLKO: urlKo ?? '',
    DS_MERCHANT_PRODUCTDESCRIPTION: description ?? '',
  };

  const merchantParamsBase64 = Buffer.from(JSON.stringify(merchantParams), 'utf8').toString('base64');
  const signature = signRedsysParams(merchantParamsBase64, dsOrder, secretKey);
  const redsysEnv = process.env.REDSYS_ENV === 'production' ? 'production' : 'test';

  return {
    mock: false,
    orderId: dsOrder,
    // El backend/frontend que gestione el checkout real debe auto-enviar un
    // <form method="POST"> a formUrl con estos tres campos como inputs
    // ocultos - Redsys redirige al cliente a su propia pasarela de pago.
    formUrl: REDSYS_URLS[redsysEnv],
    formFields: {
      Ds_SignatureVersion: 'HMAC_SHA256_V1',
      Ds_MerchantParameters: merchantParamsBase64,
      Ds_Signature: signature,
    },
  };
}

// --- API publica ------------------------------------------------------------

/**
 * Punto de entrada unico: crea un pago (mock o Redsys real segun
 * USE_PAYMENT_MOCK) sin que el llamador necesite saber cual de los dos es.
 * @param {{orderId:string, amount:number, currency:'EUR'|'USD'|'GBP', description?:string, forceFail?:boolean}} params
 */
export function createPaymentRedirect({ orderId, amount, currency, description, forceFail = false }) {
  if (!orderId || typeof amount !== 'number' || !currency) {
    throw new Error('createPaymentRedirect necesita orderId, amount (numero) y currency');
  }
  if (isMock()) {
    return createMockPayment({ orderId, amount, currency, description, forceFail });
  }
  return createRedsysPayment({ orderId, amount, currency, description });
}

export function isPaymentMockActive() {
  return isMock();
}
