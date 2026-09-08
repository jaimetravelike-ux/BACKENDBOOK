# Titi Hotels — chatbot (backend + widget)

Componentes 1 y 2 del proyecto: el widget de chat embebido en la web y el
orquestador que recoge los datos de la reserva y dispara la consulta a Booking
(componente 3, en `../titi-hotels-booking-agent`) cuando estan completos.

## Como funciona

1. El widget (`widget/chat-widget.js`) se embebe en la web con una etiqueta
   `<script>`. Abre un panel de chat flotante.
2. Cada mensaje del cliente se manda a `POST /api/chat`. El backend usa Claude
   para llevar la conversacion con tono natural y, turno a turno, va rellenando
   los datos que hacen falta: hotel/zona, fechas, habitaciones/huespedes y si
   quiere desayuno.
3. En cuanto hay hotel/zona + fechas, el backend responde ya con un mensaje tipo
   "dame un momento, compruebo Booking" y `pendingSearch: true`.
4. El widget entonces llama a `POST /api/chat/resolve`, que dispara el agente de
   Booking (puede tardar 20-40s, porque navega Booking de verdad) y devuelve la
   respuesta ya redactada por Claude con el precio encontrado.

No se conecta con TBO ni se genera ningun cobro - eso son fases futuras.

## Poner en marcha en local

```bash
cd titi-hotels-chatbot
npm install
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # PowerShell
npm start
```

El backend arranca en `http://localhost:8787`.

Para probar el widget suelto, crea un HTML de prueba:

```html
<script src="http://localhost:8787/../widget/chat-widget.js" data-api-url="http://localhost:8787"></script>
```

(o sirve `widget/chat-widget.js` como estatico desde el propio backend / desde
Netlify junto al resto de la web, y apunta `data-api-url` al backend desplegado).

## Desplegar el backend en Render

Netlify solo sirve estatico, asi que el backend necesita alojarse aparte. Este
repo ya trae un `Dockerfile` listo (Node + Chromium + dependencias de sistema
que pide Playwright), pensado para el servicio "Web Service" de Render:

1. Entra en [render.com](https://render.com) y crea una cuenta (o inicia sesion).
2. **New +** → **Web Service**.
3. Conecta tu cuenta de GitHub y selecciona este repositorio
   (`titi-hotels-chatbot`).
4. Render detectara el `Dockerfile` automaticamente (Environment: **Docker**).
   Si no lo detecta solo, elige manualmente "Docker" como entorno.
5. En **Environment Variables**, añade:
   - `ANTHROPIC_API_KEY` → tu clave de la API de Anthropic (genera una nueva,
     no reutilices ninguna que se haya compartido antes por chat).
   - (opcional) `ANTHROPIC_MODEL` si quieres forzar un modelo distinto.
6. Plan: el gratuito de Render sirve para probar, pero "duerme" tras unos
   minutos sin trafico y el primer mensaje tras despertar tarda mas (10-30s
   extra). Para uso real conviene el plan de pago mas basico (unos $7/mes).
7. Deploy. Cuando termine, Render te da una URL tipo
   `https://titi-hotels-chatbot.onrender.com` — esa es la que hay que poner en
   el widget (ver mas abajo).

## Integrarlo en la web (Netlify)

Copia `widget/chat-widget.js` al repo de la web (por ejemplo a
`assets/chat-widget.js`) y añade esto justo antes de `</body>` en
`index.html`, con la URL del backend de Render:

```html
<script
  src="./assets/chat-widget.js"
  data-api-url="https://titi-hotels-chatbot.onrender.com"
></script>
```

## Variables de entorno

- `ANTHROPIC_API_KEY` (obligatoria)
- `ANTHROPIC_MODEL` (opcional, por defecto `claude-sonnet-4-5`)
- `PORT` (opcional, por defecto `8787`)

## Limitaciones conocidas de esta v1

- Estado de conversacion en memoria (un solo proceso). Si se reinicia el
  backend, se pierden las conversaciones abiertas.
- El agente de Booking corre en el mismo proceso que el backend del chat; una
  consulta a Booking bloquea ese worker mientras dura (20-40s). Para mas
  volumen, convendria una cola de trabajos aparte.
- Necesita Playwright + Chromium instalados en el servidor donde corra esto
  (`npx playwright install chromium` dentro de `titi-hotels-booking-agent`).
