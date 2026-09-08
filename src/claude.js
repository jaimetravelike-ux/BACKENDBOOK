// Integracion con Claude: lleva la conversacion con tono natural y extrae, turno a
// turno, los datos de busqueda (hotel/zona, fechas, habitaciones, desayuno) via
// tool use. No inventa disponibilidad ni precios - eso lo hace el agente de Booking
// por separado, una vez los datos estan completos.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
    },
  },
};

function systemPrompt(slots) {
  const today = new Date().toISOString().slice(0, 10);
  return `Eres el agente de atencion de Titi Hotels, una agencia especializada solo en hoteles de Nueva York. Hablas por el chat de la web.

Tono: cercano y natural, como una persona real de la agencia (nunca como un formulario ni un bot robotico). Frases cortas, sin exceso de emojis, en español de España.

Tu unico objetivo en esta conversacion es recoger, de forma natural (no como un cuestionario rigido), estos datos:
- Hotel o zona/barrio de interes
- Fecha de entrada y de salida
- Numero de habitaciones y huespedes (si no lo dicen, asume 2 adultos y 1 habitacion, pero puedes confirmarlo de pasada)
- Si quiere desayuno incluido o no. Preguntalo una vez de pasada; si el cliente no contesta a eso o no lo menciona en ningun momento, NO insistas mas y llama a update_booking_slots con breakfast:false - por defecto se entiende que la busqueda es sin desayuno. Cuando des el resultado final, deja claro que has buscado sin desayuno por defecto, para que el cliente pueda corregirte si lo quiere con desayuno.

Hoy es ${today}. Si el cliente da fechas relativas ("el finde que viene", "en dos semanas"), calculalas tu y usa siempre formato YYYY-MM-DD al llamar a la herramienta.

Llama a la herramienta update_booking_slots cada vez que el cliente aporte o confirme un dato nuevo, aunque sea parcial.

Datos que ya tienes de turnos anteriores: ${JSON.stringify(slots)}

Cuando tengas ya hotel/zona + fecha de entrada + fecha de salida (los demas datos pueden quedar en su valor por defecto), NO sigas preguntando mas cosas: dile al cliente de forma natural que vas a comprobar el mejor precio ahora mismo y que le puede llevar un momento. No inventes ningun precio ni disponibilidad tu mismo - eso lo compruebas aparte. NUNCA menciones "Booking" ni ninguna web externa por su nombre - de cara al cliente, el precio lo comprueba Titi Hotels.

Si el cliente pregunta algo que no tiene que ver con reservar un hotel en Nueva York, respondele brevemente y con amabilidad, y reconduce la conversacion hacia recoger esos datos.`;
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
      messages: currentMessages,
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

  return { text: finalText, slotUpdates };
}

export async function converse(session, userMessage) {
  session.history.push({ role: 'user', content: userMessage });
  const { text, slotUpdates } = await runTurn(session.history, session.slots);
  Object.assign(session.slots, slotUpdates);
  session.history.push({ role: 'assistant', content: text });
  return text;
}

export async function phraseSearchResult(session, result) {
  const instruction = result.found
    ? `Resultado real de la comprobacion de precio para esta busqueda (no lo inventes, usalo tal cual): ${JSON.stringify(result)}.

Cuentaselo al cliente en un mensaje natural y breve: confirma el nombre exacto del hotel encontrado (por si no coincide con lo que dijo, para que pueda corregirte), y el precio total para esas fechas. Si "breakfastRequested" es false, dile que el precio es sin desayuno por defecto y que puedes volver a mirarlo con desayuno incluido si lo prefiere. Si "extraChargesNotice" no es null, menciona ese cargo extra. Deja claro que es un precio de referencia, no el precio final de la reserva (eso se gestiona aparte). NUNCA menciones "Booking" ni ninguna web externa por su nombre - habla siempre en primera persona de Titi Hotels (p.ej. "hemos encontrado", "nuestro precio", "te comparamos el precio").`
    : `La comprobacion de precio no encontro disponibilidad con esos criterios exactos (motivo: ${result.reason}). Dile al cliente de forma natural que no has encontrado disponibilidad justo con esas fechas/criterios, y preguntale si quiere que pruebes con fechas u opciones distintas. NUNCA menciones "Booking" ni ninguna web externa por su nombre.`;

  session.history.push({ role: 'user', content: instruction });
  const { text } = await runTurn(session.history, session.slots);
  session.history.push({ role: 'assistant', content: text });
  return text;
}
