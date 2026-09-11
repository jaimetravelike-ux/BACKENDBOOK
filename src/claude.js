// Integracion con Claude: lleva la conversacion con tono natural y extrae, turno a
// turno, los datos de busqueda (hotel/zona, fechas, habitaciones, desayuno) via
// tool use. No inventa disponibilidad ni precios - eso lo hace el agente de Booking
// por separado, una vez los datos estan completos.

import Anthropic from '@anthropic-ai/sdk';

// El SDK instalado (0.32.x) todavia trata el prompt caching como beta y
// necesita esta cabecera para activarlo con el cliente normal de mensajes.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
});
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const UPDATE_SLOTS_TOOL = {
  name: 'update_booking_slots',
  description:
    'Actualiza los datos de busqueda de hotel recogidos hasta ahora en la conversacion. Llamala cada vez que el cliente mencione o confirme cualquiera de estos datos, aunque sea parcial. No hace falta esperar a tener todos los datos para llamarla.',
  input_schema: {
    type: 'object',
    properties: {
      hotelQuery: {
        type: 'string',
        description: 'Nombre del hotel o zona/barrio que busca el cliente, tal cual lo menciona (p.ej. "Row NYC", "algo en Times Square").',
      },
      checkin: { type: 'string', description: 'Fecha de entrada, formato YYYY-MM-DD.' },
      checkout: { type: 'string', description: 'Fecha de salida, formato YYYY-MM-DD.' },
      adults: { type: 'string', description: 'Numero de adultos (por defecto 2 si no se especifica y hace falta un valor).' },
      rooms: { type: 'string', description: 'Numero de habitaciones (por defecto 1 si no se especifica y hace falta un valor).' },
      breakfast: { type: 'boolean', description: 'true si quiere desayuno incluido. false si expresamente no lo quiere, O si no ha dicho nada al respecto (por defecto se asume sin desayuno).' },
      noSpecificHotel: {
        type: 'boolean',
        description:
          'true si el cliente NO ha nombrado ningun hotel concreto por su nombre y lo que quiere es que le enseñes varias opciones de la zona. Esto incluye tanto "no quiero ninguno de esos, busca en la zona" (tras una desambiguacion) COMO la peticion inicial, desde el primer mensaje, cuando pide hoteles de una zona/barrio en general sin dar un nombre de hotel (p.ej. "los mejores hoteles cerca de Times Square", "algo con buena relacion calidad-precio en Chelsea", "cualquier hotel en Brooklyn", "hoteles cerca de X"). Ponlo a false (o no lo toques) SOLO cuando el cliente si menciona el nombre concreto de un hotel.',
      },
      pricePreference: {
        type: 'string',
        enum: ['barato', 'caro', 'calidad', 'calidad_precio'],
        description:
          'SOLO cuando el cliente busca varios hoteles de una zona (noSpecificHotel:true) y su forma de pedirlo dice algo sobre que criterio usar para elegir entre ellos. "barato" si prioriza el precio mas bajo por encima de todo (p.ej. "el mas barato", "algo economico", "que no sea caro"). "caro" SOLO si pide literalmente el precio mas alto/caro (p.ej. "el mas caro", "el de mayor presupuesto") - distinto de "calidad": aqui manda el precio, no las estrellas. "calidad" si prioriza lo mejor valorado/estrellas sin importar tanto el precio (p.ej. "el mejor valorado", "de lujo", "algo top", "5 estrellas", "los mas exclusivos"). "calidad_precio" si menciona explicitamente relacion calidad-precio, o simplemente no da ninguna pista de preferencia (este es el valor por defecto razonable). No lo actualices si el cliente busca un hotel concreto por su nombre.',
      },
    },
  },
  cache_control: { type: 'ephemeral' },
};

// Parte fija del prompt: no depende de la fecha ni de los datos de la
// conversacion, asi que es identica en todas las llamadas y se puede
// cachear (cache_control ephemeral) para no pagar precio completo por ella
// en cada turno.
const STATIC_SYSTEM_PROMPT = `Eres el agente de atencion de BedCopilot, una agencia especializada solo en hoteles de Nueva York. Hablas por el chat de la web.

Tono: cercano y natural, como una persona real de la agencia (nunca como un formulario ni un bot robotico). Frases cortas, sin exceso de emojis, en español de España.

Tu unico objetivo en esta conversacion es recoger, de forma natural (no como un cuestionario rigido), estos datos:
- Hotel o zona/barrio de interes. Si el cliente nombra un hotel realmente iconico y sabes con total seguridad su nombre oficial completo (p.ej. "el Plaza" -> "The Plaza Hotel New York", "el Waldorf" -> "Waldorf Astoria New York"), pon ese nombre oficial al llamar a update_booking_slots. Para cualquier otro hotel del que NO estes 100% seguro del nombre exacto, usa las palabras tal cual las dijo el cliente, SIN inventar ni completar el nombre - es mejor pasar el texto literal del cliente que arriesgarte a mezclar el nombre con el de otro hotel parecido. Si el cliente elige un hotel concreto (de una lista, o cambiando de opinion despues de haber pedido la zona en general), llama tambien a update_booking_slots con noSpecificHotel:false.
- MUY IMPORTANTE - distingue desde el primer mensaje entre pedir un hotel concreto y pedir una zona: si el cliente NO da el nombre de ningun hotel y solo pide una zona/barrio en general (p.ej. "los mejores hoteles cerca de Times Square", "algo con buena relacion calidad-precio en Chelsea", "cualquier hotel en Brooklyn", "hoteles cerca de X"), llama a update_booking_slots con noSpecificHotel:true YA EN ESE MISMO TURNO, no esperes a que rechace una lista de hoteles primero - si esperas, la busqueda acaba resolviendo a un unico hotel al azar en vez de mostrarle varias opciones reales de la zona, que es justo lo que pidio.
- Si pide varios hoteles de una zona, fijate si menciona algun criterio para elegir entre ellos (el mas barato, el mejor valorado, buena relacion calidad-precio...) y llama a update_booking_slots con pricePreference acorde - no preguntes por esto si no lo menciona, simplemente detectalo cuando este presente.
- Fecha de entrada y de salida
- Numero de habitaciones y huespedes (si no lo dicen, asume 2 adultos y 1 habitacion, pero puedes confirmarlo de pasada). Si el cliente menciona niños, SUMALOS directamente al numero de adultos al llamar a update_booking_slots (p.ej. "2 adultos y 1 niño" -> adults:"3") - no hay forma de tratarlos por separado todavia, asi que cuentan como una persona mas sin mas. NUNCA preguntes la edad de los niños ni menciones que los estas contando como adultos - hazlo en silencio.
- Desayuno: NUNCA preguntes por esto durante la conversacion, aunque no lo haya mencionado. Llama siempre a update_booking_slots con breakfast:false salvo que el cliente ya haya dicho explicitamente que lo quiere con desayuno. Cuando des el resultado final, menciona de pasada que has buscado sin desayuno por defecto y que puedes volver a mirarlo con desayuno si lo prefiere - pero no lo preguntes antes de buscar, nunca te quedes esperando esa respuesta para lanzar la busqueda.

Si el cliente da fechas relativas ("el finde que viene", "en dos semanas"), calculalas usando la fecha actual indicada mas abajo, y usa siempre formato YYYY-MM-DD al llamar a la herramienta.

Llama a la herramienta update_booking_slots cada vez que el cliente aporte o confirme un dato nuevo, aunque sea parcial.

Cuando tengas ya hotel/zona + fecha de entrada + fecha de salida (los demas datos pueden quedar en su valor por defecto), NO sigas preguntando mas cosas: dile al cliente de forma natural que vas a comprobar el mejor precio ahora mismo y que le puede llevar un momento. No inventes ningun precio ni disponibilidad tu mismo - eso lo compruebas aparte. NUNCA menciones "Booking" ni ninguna web externa por su nombre - de cara al cliente, el precio lo comprueba BedCopilot.

Si el cliente pregunta algo que no tiene que ver con reservar un hotel en Nueva York, respondele brevemente y con amabilidad, y reconduce la conversacion hacia recoger esos datos.`;

// Parte dinamica: cambia en cada turno (fecha, datos ya recogidos), asi que
// va aparte y no se cachea.
function dynamicSystemSuffix(slots) {
  const today = new Date().toISOString().slice(0, 10);
  return `Fecha actual: ${today}.

Datos que ya tienes de turnos anteriores: ${JSON.stringify(slots)}`;
}

function systemPrompt(slots) {
  return [
    { type: 'text', text: STATIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicSystemSuffix(slots) },
  ];
}

// Marca el ultimo bloque del ultimo mensaje como punto de corte de cache
// (sin mutar los mensajes originales, que se siguen guardando tal cual en
// session.history). En una conversacion de varios turnos, el historial va
// creciendo pero su principio es siempre el mismo texto ya enviado antes -
// con esto, Anthropic reutiliza en cache todo ese principio identico y solo
// cobra precio completo por lo nuevo de este turno, en vez de repetir el
// precio completo de toda la conversacion cada vez que crece.
function withCacheBreakpoint(messages) {
  if (messages.length === 0) return messages;
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  const blocks =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : last.content.map((b) => ({ ...b }));
  const lastBlockIndex = blocks.length - 1;
  blocks[lastBlockIndex] = { ...blocks[lastBlockIndex], cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, lastIndex), { ...last, content: blocks }];
}

async function runTurn(messages, slots) {
  let currentMessages = [...messages];
  let finalText = '';
  const slotUpdates = {};

  for (let iteration = 0; iteration < 4; iteration++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: systemPrompt({ ...slots, ...slotUpdates }),
      tools: [UPDATE_SLOTS_TOOL],
      messages: withCacheBreakpoint(currentMessages),
    });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const textBlocks = response.content.filter((b) => b.type === 'text');
    finalText = textBlocks.map((b) => b.text).join('\n').trim() || finalText;

    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      break;
    }

    for (const tu of toolUses) {
      if (tu.name === 'update_booking_slots') {
        Object.assign(slotUpdates, tu.input);
      }
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      {
        role: 'user',
        content: toolUses.map((tu) => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'ok',
        })),
      },
    ];
  }

  return { text: scrubExternalMentions(finalText), slotUpdates };
}

// Red de seguridad: aunque el prompt le diga que no mencione "Booking", un
// modelo de lenguaje no cumple una instruccion asi el 100% de las veces. En
// vez de confiar solo en el prompt, reescribimos cualquier mencion antes de
// que le llegue al cliente.
function scrubExternalMentions(text) {
  if (!text) return text;
  return text
    .replace(/precio de referencia en booking(\.com)?/gi, 'precio de referencia')
    .replace(/en booking(\.com)?/gi, 'en nuestro sistema')
    .replace(/booking\.com/gi, 'nuestro sistema')
    .replace(/\bbooking\b/gi, 'nuestro sistema');
}

export async function converse(session, userMessage) {
  session.history.push({ role: 'user', content: userMessage });
  const { text, slotUpdates } = await runTurn(session.history, session.slots);
  Object.assign(session.slots, slotUpdates);
  session.history.push({ role: 'assistant', content: text });
  return text;
}

export async function phraseSearchResult(session, result) {
  let instruction;
  if (result.needsDisambiguation) {
    instruction = `No hay una unica coincidencia clara para el hotel que pidio el cliente. Estas son 2-3 opciones reales de Nueva York parecidas a lo que escribio: ${JSON.stringify(result.options)}.

Preguntale de forma breve y natural cual de esas es la que quiere, PERO tambien dale la opcion de no elegir ninguna y que busques varias opciones de la zona en general en su lugar. No sigas con la busqueda todavia - espera su respuesta. Si elige una de las opciones, usa ese nombre completo y exacto como hotelQuery al llamar a update_booking_slots. Si en cambio dice que no quiere un hotel concreto y prefiere la zona en general, llama a update_booking_slots con noSpecificHotel:true (deja hotelQuery igual, con el nombre de la zona/barrio que ya dio).`;
  } else if (result.notFoundInNewYork) {
    instruction = `No se ha encontrado ningun hotel en Nueva York que coincida con lo que pidio el cliente (puede que el nombre este incompleto, mal escrito, o que ese hotel simplemente no exista en Nueva York). Dile de forma breve y natural que no encuentras ese hotel en Nueva York (recuerda que BedCopilot solo trabaja hoteles de Nueva York) y preguntale el nombre completo del hotel o en que zona/barrio de Nueva York esta, para volver a intentarlo. NUNCA menciones "Booking" ni des el nombre de un hotel de otra ciudad como si fuera valido.`;
  } else if (result.multiple) {
    instruction = `La busqueda era por zona/ciudad en general (no un hotel concreto), asi que en vez de elegir uno solo se han encontrado ${result.hotels.length} opciones reales (las mas baratas) para esas fechas: ${JSON.stringify(result.hotels.map((h) => ({ hotel: h.hotel, city: h.city, totalPrice: h.totalPrice })))}.

El cliente va a ver, justo debajo de tu mensaje, ${result.hotels.length} TARJETAS VISUALES (una por hotel) con foto, nombre, ciudad, valoracion, precio y desglose - toda esa informacion numerica ya esta ahi, no la repitas ni la enumeres en el texto. Tu mensaje debe ser muy breve (1-2 frases): di que le traes unas opciones para elegir y preguntale cual le encaja mas o si quiere que acotes mas la busqueda (por ejemplo por zona o presupuesto). Menciona SOLO si el precio es sin desayuno por defecto (y que puedes volver a mirarlo con desayuno si quiere) - eso no sale en las tarjetas.

NUNCA menciones "Booking" ni ninguna web externa por su nombre - habla siempre en primera persona de BedCopilot.`;
  } else if (result.found) {
    const hasCard = Array.isArray(result.photos) && result.photos.length > 0;
    instruction = `Resultado real de la comprobacion de precio para esta busqueda (no lo inventes, usalo tal cual): ${JSON.stringify(result)}.

${
  hasCard
    ? `El cliente va a ver, justo debajo de tu mensaje, una TARJETA VISUAL con foto, nombre del hotel, ciudad, valoracion (estrellas y nota de opiniones), precio tachado/precio final, precio por noche, insignia de descuento si aplica, e impuestos/cargos incluidos. Toda esa informacion numerica YA esta en la tarjeta - no la repitas en el texto. Tu mensaje debe ser muy breve (2-3 frases): confirma que has encontrado el hotel (nombre corto esta bien) y pregunta si le encaja o quiere que mires otra cosa. Menciona SOLO si el precio es sin desayuno por defecto (y que puedes volver a mirarlo con desayuno si quiere) - eso no sale en la tarjeta. NO menciones estrellas, nota/valoracion, porcentaje de descuento, precio exacto, ni el desglose de tasas/resort fee: eso ya lo esta viendo.`
    : `Aqui no hay tarjeta visual (solo texto), asi que cuentaselo tu de forma natural y breve: confirma el nombre exacto del hotel encontrado (por si no coincide con lo que dijo, para que pueda corregirte), y el precio total para esas fechas. Si "breakfastRequested" es false, dile que el precio es sin desayuno por defecto y que puedes volver a mirarlo con desayuno incluido si lo prefiere. Si "extraChargesNotice" no es null, menciona ese cargo extra. Deja claro que es un precio de referencia, no el precio final de la reserva (eso se gestiona aparte).`
}

NUNCA menciones "Booking" ni ninguna web externa por su nombre - habla siempre en primera persona de BedCopilot (p.ej. "hemos encontrado", "nuestro precio", "te comparamos el precio").`;
  } else {
    instruction = `La comprobacion de precio no encontro disponibilidad con esos criterios exactos (motivo: ${result.reason}). Dile al cliente de forma natural que no has encontrado disponibilidad justo con esas fechas/criterios, y preguntale si quiere que pruebes con fechas u opciones distintas. NUNCA menciones "Booking" ni ninguna web externa por su nombre.`;
  }

  session.history.push({ role: 'user', content: instruction });
  const { text } = await runTurn(session.history, session.slots);
  session.history.push({ role: 'assistant', content: text });
  return text;
}
