(function () {
  const scriptTag = document.currentScript;
  const API_URL = (scriptTag && scriptTag.getAttribute('data-api-url')) || 'http://localhost:8787';

  const STORAGE_KEY = 'titiChatSessionId';

  function getSessionId() {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  async function postJSON(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Comprobar el precio de verdad tarda 15-40s (el agente navega Booking como
  // una persona). En vez de un "Comprobando..." estatico todo ese rato, vamos
  // rotando curiosidades de Nueva York - se siente mucho menos largo.
  const NYC_FACTS = [
    'Comprobando el mejor precio...',
    '¿Sabías que Central Park es más grande que Mónaco? 🗽',
    'El metro de Nueva York no cierra nunca: funciona las 24 horas, los 365 días del año.',
    'Times Square se llama así por el New York Times, que tuvo ahí su sede hace más de un siglo.',
    'Nueva York tiene más de 26.000 restaurantes - casi uno por cada 340 habitantes.',
    'El Empire State Building tiene su propio código postal.',
    'Casi el 40% de los neoyorquinos nacieron fuera de Estados Unidos.',
    'Ya casi está...',
  ];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Antes siempre empezaba por el mismo indice, asi que en una comprobacion
  // tipica (15-40s, ~4-9 curiosidades mostradas) casi siempre se veian las
  // mismas 2-3 primeras. Ahora se baraja el orden (menos el mensaje inicial,
  // que ya se ve antes de empezar a rotar) cada vez que se lanza.
  function startFactRotation(el) {
    const facts = shuffle(NYC_FACTS.slice(1));
    let i = 0;
    const interval = setInterval(() => {
      el.textContent = facts[i % facts.length];
      i++;
    }, 4200);
    return () => clearInterval(interval);
  }

  // Logica compartida de "enviar mensaje -> esperar respuesta -> si hace falta,
  // comprobar el precio real". La usan tanto el chat del hero como la burbuja
  // flotante, cada uno con su propio renderMessage().
  function wireChat({ formEl, inputEl, sendBtn, renderMessage, onFirstSend, onResult }) {
    let started = false;

    async function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      if (sendBtn) sendBtn.disabled = true;
      inputEl.disabled = true;

      if (!started && onFirstSend) {
        started = true;
        onFirstSend();
      }

      renderMessage('user', text);
      const typingEl = renderMessage('typing', 'Escribiendo...');

      try {
        const sessionId = getSessionId();
        const { reply, pendingSearch } = await postJSON('/api/chat', { sessionId, message: text });
        typingEl.remove();
        renderMessage('bot', reply);

        if (pendingSearch) {
          const checkingEl = renderMessage('typing', 'Comprobando el mejor precio...');
          const stopFacts = startFactRotation(checkingEl);
          try {
            const resolved = await postJSON('/api/chat/resolve', { sessionId });
            stopFacts();
            checkingEl.remove();
            renderMessage('bot', resolved.reply);
            if (resolved.result?.found && onResult) {
              if (resolved.result.multiple && Array.isArray(resolved.result.hotels)) {
                resolved.result.hotels.forEach((h) => onResult(h));
              } else {
                onResult(resolved.result);
              }
            }
          } catch {
            stopFacts();
            checkingEl.remove();
            renderMessage('bot', 'No he podido comprobar el precio justo ahora. ¿Lo intentamos de nuevo en un momento?');
          }
        }
      } catch {
        typingEl.remove();
        renderMessage('bot', 'Se me ha cortado la conexión. ¿Puedes escribirlo otra vez?');
      } finally {
        if (sendBtn) sendBtn.disabled = false;
        inputEl.disabled = false;
        inputEl.focus();
      }
    }

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage();
    });

    return { sendMessage };
  }

  // --- Modo hero: barra grande en la portada que se convierte en hilo ---
  const heroForm = document.getElementById('heroChatForm');
  if (heroForm) {
    const heroInput = document.getElementById('heroChatInput');
    const heroThread = document.getElementById('heroThread');
    const heroSend = heroForm.querySelector('.chatbar-send');
    const heroWrapper = document.querySelector('.hero-wrapper');

    // Fotos genericas de Nueva York que ya tiene la web (no la foto real del
    // hotel encontrado, para no depender de scrapear imagenes de Booking).
    const NYC_PHOTOS = [
      './assets/images/hero.jpg',
      './assets/images/mid.jpg',
      './assets/images/brook.jpg',
      './assets/images/upper.jpg',
      './assets/images/chelsea.jpg',
      './assets/images/economico.jpg',
    ];

    // El hilo tiene su propio scroll interno (no el de la pagina). Un solo
    // scrollTop=scrollHeight justo tras appendChild a veces se queda corto
    // porque el layout (fuentes, imagenes reservando su aspect-ratio) aun no
    // ha terminado - por eso reintentamos en el siguiente frame y otra vez
    // un poco despues, y ademas al cargar la primera imagen de la tarjeta.
    function scrollThreadToBottom(targetEl) {
      const doScroll = () => {
        heroThread.scrollTop = heroThread.scrollHeight;
        // scrollIntoView es mas fiable que mover solo heroThread.scrollTop:
        // tiene en cuenta el layout real del elemento (incluida su altura
        // final con la imagen ya calculada) y ajusta cualquier contenedor
        // con scroll por el camino, no solo heroThread.
        if (targetEl && targetEl.isConnected) {
          targetEl.scrollIntoView({ block: 'end', inline: 'nearest' });
        }
      };
      doScroll();
      requestAnimationFrame(doScroll);
      setTimeout(doScroll, 300);
      setTimeout(doScroll, 900);
      setTimeout(doScroll, 1800);
    }

    function renderHeroMessage(role, text) {
      const el = document.createElement('div');
      el.className = `msg ${role}`;
      el.textContent = text;
      heroThread.appendChild(el);
      heroThread.classList.add('open');
      scrollThreadToBottom(el);
      return el;
    }

    function escapeHtml(str) {
      return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Paleta de la nota (verde = mejor, rojo = peor), en la linea de las
    // insignias de rating que se ven en Booking/Civitatis.
    function ratingInfo(score) {
      if (score == null) return null;
      if (score >= 9) return { label: 'Excepcional', className: 'r-superb' };
      if (score >= 8) return { label: 'Muy bien', className: 'r-verygood' };
      if (score >= 7) return { label: 'Bien', className: 'r-good' };
      if (score >= 6) return { label: 'Aceptable', className: 'r-fair' };
      return { label: 'Regular', className: 'r-poor' };
    }

    function isFavorite(key) {
      try {
        return localStorage.getItem('titiFav:' + key) === '1';
      } catch {
        return false;
      }
    }
    function setFavorite(key, value) {
      try {
        if (value) localStorage.setItem('titiFav:' + key, '1');
        else localStorage.removeItem('titiFav:' + key);
      } catch {
        // localStorage no disponible (privado/bloqueado) - el corazon simplemente no se recuerda
      }
    }

    // Tarjeta de hotel al estilo Booking/Civitatis: carrusel + favorito,
    // nombre, ciudad, insignia de nota, insignia de descuento, precio
    // tachado + precio final, y desglose por noche/impuestos. Cuando el
    // precio viene de RapidAPI (result.photos con datos reales) se rellena
    // todo; cuando cae al fallback de Playwright, se muestra una version
    // reducida con foto generica y solo el precio total.
    function renderHotelCard(result) {
      const realPhotos = Array.isArray(result?.photos) ? result.photos.filter(Boolean) : [];
      const usingGenericPhoto = realPhotos.length === 0;
      const photos = usingGenericPhoto ? [NYC_PHOTOS[Math.floor(Math.random() * NYC_PHOTOS.length)]] : realPhotos;

      const wrap = document.createElement('div');
      wrap.className = 'hotel-card';

      const slides = photos
        .map((url, i) => `<img src="${url}" alt="${escapeHtml(result.hotel || 'Hotel')}" loading="lazy" class="${i === 0 ? 'active' : ''}" />`)
        .join('');
      const dots =
        photos.length > 1
          ? `<div class="hotel-card-dots">${photos.map((_, i) => `<button class="${i === 0 ? 'active' : ''}" data-i="${i}" aria-label="Foto ${i + 1}"></button>`).join('')}</div>`
          : '';
      const arrows =
        photos.length > 1
          ? `<button class="hotel-card-arrow prev" type="button" aria-label="Foto anterior">&#10094;</button>
             <button class="hotel-card-arrow next" type="button" aria-label="Foto siguiente">&#10095;</button>`
          : '';

      const favKey = (result.hotel || 'hotel').toLowerCase();
      const favActive = isFavorite(favKey);

      const rating = ratingInfo(result.reviewScore);

      const stayParts = [];
      if (result.nights) stayParts.push(`${result.nights} noche${result.nights === 1 ? '' : 's'}`);
      if (result.rooms) stayParts.push(`${result.rooms} habitación${Number(result.rooms) === 1 ? '' : 'es'}`);
      if (result.adults) stayParts.push(`${result.adults} adulto${Number(result.adults) === 1 ? '' : 's'}`);
      const stayLine = stayParts.length ? `Por ${stayParts.join(', ')}` : '';

      const taxesLine = result.includedTaxesAmount
        ? `Incluye tasas e impuestos (${escapeHtml(result.includedTaxesAmount)})`
        : result.extraChargesNotice
          ? escapeHtml(result.extraChargesNotice)
          : '';

      const hasPrice = Boolean(result.totalPrice);

      wrap.innerHTML = `
        <div class="hotel-card-media">
          <button class="hotel-card-fav ${favActive ? 'active' : ''}" type="button" aria-label="Guardar en favoritos">
            <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10.1-9.1C.4 9 1.4 5.3 4.7 4.2c2-.7 4.1 0 5.3 1.7 1.2-1.7 3.3-2.4 5.3-1.7 3.3 1.1 4.3 4.8 2.8 7.7C19.5 16.4 12 21 12 21z"/></svg>
          </button>
          ${result.discount ? `<div class="hotel-card-discount">${escapeHtml(result.discount.label)}</div>` : ''}
          <div class="hotel-card-gallery">${slides}${arrows}${dots}</div>
        </div>
        <div class="hotel-card-body">
          <div class="hotel-card-head">
            <div class="hotel-card-titles">
              <div class="hotel-card-name">${escapeHtml(result.hotel || '')}</div>
              ${result.city ? `<div class="hotel-card-city">${escapeHtml(result.city)}</div>` : ''}
            </div>
            ${
              rating
                ? `<div class="hotel-card-rating ${rating.className}">
                     <span class="hotel-card-rating-score">${result.reviewScore.toFixed(1)}</span>
                     <span class="hotel-card-rating-text">${rating.label}${result.reviewCount ? ` · ${result.reviewCount} opiniones` : ''}</span>
                   </div>`
                : ''
            }
          </div>
          ${
            hasPrice
              ? `<div class="hotel-card-price">
                   ${result.discount?.percent ? `<span class="hotel-card-price-badge">-${result.discount.percent}%</span>` : ''}
                   ${result.discount?.originalPrice ? `<div class="hotel-card-price-original">${escapeHtml(result.discount.originalPrice)}</div>` : ''}
                   <div class="hotel-card-price-total">${escapeHtml(result.totalPrice)}</div>
                   ${stayLine ? `<div class="hotel-card-price-stay">${stayLine}</div>` : ''}
                   ${result.pricePerNight ? `<div class="hotel-card-price-night">${escapeHtml(result.pricePerNight)} por noche</div>` : ''}
                   ${taxesLine ? `<div class="hotel-card-price-taxes">${taxesLine}</div>` : ''}
                 </div>`
              : ''
          }
          <div class="hotel-card-lead">
            <input class="hotel-card-lead-name" type="text" placeholder="Tu nombre" autocomplete="name" />
            <input class="hotel-card-lead-email" type="email" placeholder="Tu correo electrónico" autocomplete="email" />
            <div class="hotel-card-lead-error" hidden></div>
          </div>
          <button class="hotel-card-reserve" type="button">Reservar</button>
        </div>
      `;

      const favBtn = wrap.querySelector('.hotel-card-fav');
      favBtn.addEventListener('click', () => {
        const next = !favBtn.classList.contains('active');
        favBtn.classList.toggle('active', next);
        setFavorite(favKey, next);
      });

      const nameInput = wrap.querySelector('.hotel-card-lead-name');
      const emailInput = wrap.querySelector('.hotel-card-lead-email');
      const leadError = wrap.querySelector('.hotel-card-lead-error');
      const reserveBtn = wrap.querySelector('.hotel-card-reserve');

      // En vez de mandar al cliente de vuelta a escribir en el chat (nombre,
      // email...), se recogen aqui mismo en la card - mas rapido para el
      // cliente y llega ya estructurado, sin tener que interpretarlo de un
      // mensaje de texto libre.
      reserveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        const email = emailInput.value.trim();
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

        if (!name || !emailOk) {
          leadError.textContent = !name
            ? 'Escribe tu nombre para reservar.'
            : 'Escribe un correo electrónico válido.';
          leadError.hidden = false;
          (!name ? nameInput : emailInput).focus();
          return;
        }
        leadError.hidden = true;

        reserveBtn.disabled = true;
        reserveBtn.textContent = 'Enviando...';
        nameInput.disabled = true;
        emailInput.disabled = true;

        try {
          await postJSON('/api/lead', {
            sessionId: getSessionId(),
            name,
            email,
            hotel: result.hotel || null,
            city: result.city || null,
            checkin: result.checkin || null,
            checkout: result.checkout || null,
            adults: result.adults || null,
            rooms: result.rooms || null,
            totalPrice: result.totalPrice || null,
          });
          // Aqui termina el flujo por ahora: nombre y email son obligatorios
          // y, en cuanto haya pasarela de pago conectada, este es el punto
          // donde se redirigiria a pagar - no se manda ningun mensaje mas al
          // chat, la card se queda como confirmacion final por si misma. El
          // boton mantiene el texto "Reservar" (no "Solicitud enviada") a
          // peticion expresa - solo queda deshabilitado para no duplicar el
          // envio, con la confirmacion en el texto de abajo.
          reserveBtn.textContent = 'Reservar';
          leadError.hidden = true;
          leadError.className = 'hotel-card-lead-success';
          leadError.textContent = 'Gracias. En breve te contactamos para completar el pago.';
          leadError.hidden = false;
        } catch (err) {
          console.warn('[hotel-card] no se pudo enviar la solicitud de reserva', err);
          reserveBtn.disabled = false;
          reserveBtn.textContent = 'Reservar';
          nameInput.disabled = false;
          emailInput.disabled = false;
          leadError.textContent = 'No se pudo enviar. Inténtalo de nuevo en un momento.';
          leadError.hidden = false;
        }
      });

      if (photos.length > 1) {
        const imgs = wrap.querySelectorAll('.hotel-card-gallery img');
        const dotBtns = wrap.querySelectorAll('.hotel-card-dots button');
        let current = 0;
        const show = (i) => {
          current = (i + photos.length) % photos.length;
          imgs.forEach((img, idx) => img.classList.toggle('active', idx === current));
          dotBtns.forEach((d, idx) => d.classList.toggle('active', idx === current));
        };
        wrap.querySelector('.hotel-card-arrow.prev').addEventListener('click', () => show(current - 1));
        wrap.querySelector('.hotel-card-arrow.next').addEventListener('click', () => show(current + 1));
        dotBtns.forEach((d) => d.addEventListener('click', () => show(Number(d.dataset.i))));
        const autoplay = setInterval(() => show(current + 1), 3500);
        wrap.addEventListener('mouseenter', () => clearInterval(autoplay));
      }

      heroThread.appendChild(wrap);
      scrollThreadToBottom(wrap);
      const firstImg = wrap.querySelector('.hotel-card-gallery img');
      if (firstImg && !firstImg.complete) {
        firstImg.addEventListener('load', () => scrollThreadToBottom(wrap), { once: true });
      }
    }

    // En iOS Safari, "overflow:hidden" en el body NO evita el scroll/rebote
    // de fondo (es un bug conocido) - hay que fijar el body con position:fixed
    // y compensar con top:-scrollY, que es la tecnica que de verdad funciona
    // ahi. La clase chat-locked se deja tambien para el resto de navegadores.
    function focusChatMode() {
      if (heroWrapper) heroWrapper.classList.add('chat-focused');
      const scrollY = window.scrollY || window.pageYOffset || 0;
      document.body.dataset.lockedScrollY = String(scrollY);
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.classList.add('chat-locked');
      document.documentElement.classList.add('chat-locked');
    }

    // Deshace exactamente lo que hace focusChatMode, incluida la posicion de
    // scroll de la pagina de antes de entrar al chat (si no, al soltar el
    // position:fixed el navegador se iria arriba del todo).
    function exitChatMode() {
      if (heroWrapper) heroWrapper.classList.remove('chat-focused');
      const scrollY = Number(document.body.dataset.lockedScrollY || 0);
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.classList.remove('chat-locked');
      document.documentElement.classList.remove('chat-locked');
      window.scrollTo(0, scrollY);
    }

    const chatExitBtn = document.getElementById('chatExitBtn');
    if (chatExitBtn) {
      chatExitBtn.addEventListener('click', exitChatMode);
    }

    const heroChat = wireChat({
      formEl: heroForm,
      inputEl: heroInput,
      sendBtn: heroSend,
      renderMessage: renderHeroMessage,
      onFirstSend: focusChatMode,
      onResult: renderHotelCard,
    });

    document.querySelectorAll('.hero-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        heroInput.value = chip.dataset.text;
        heroInput.focus();
      });
    });

    // El resto de la web (barrios, CTA de siempre) puede pedir que se abra el
    // chat con un texto ya escrito, sin tener que tocar el input a mano.
    window.titiChatPrefill = function (text) {
      heroInput.value = text;
      heroForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => heroInput.focus(), 500);
    };

    return; // con chat en el hero no hace falta la burbuja flotante duplicada
  }

  // --- Modo burbuja flotante (paginas sin hero de chat) ---
  const css = `
    .titi-chat-launcher {
      position: fixed; bottom: 96px; right: 28px; z-index: 998;
      width: 58px; height: 58px; border-radius: 50%;
      background: #F2B705; color: #15171C; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 24px rgba(242,183,5,0.45);
      transition: transform 0.2s;
    }
    .titi-chat-launcher:hover { transform: scale(1.08); }
    .titi-chat-launcher svg { width: 26px; height: 26px; }

    .titi-chat-panel {
      position: fixed; bottom: 168px; right: 28px; z-index: 999;
      width: 360px; max-width: calc(100vw - 32px); height: 500px; max-height: 70vh;
      background: #FFFFFF; border-radius: 12px; overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.35);
      display: flex; flex-direction: column;
      font-family: 'Inter', -apple-system, sans-serif;
      opacity: 0; transform: translateY(12px); pointer-events: none;
      transition: opacity 0.2s, transform 0.2s;
    }
    .titi-chat-panel.open { opacity: 1; transform: none; pointer-events: auto; }

    .titi-chat-header {
      background: #15171C; color: #fff; padding: 16px 18px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .titi-chat-header-title { font-weight: 800; font-size: 14px; letter-spacing: 0.02em; text-transform: uppercase; }
    .titi-chat-header-sub { font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 2px; }
    .titi-chat-close { background: none; border: none; color: rgba(255,255,255,0.6); cursor: pointer; font-size: 18px; line-height: 1; padding: 4px; }
    .titi-chat-close:hover { color: #fff; }

    .titi-chat-messages {
      flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px;
      background: #F6F2E7;
    }
    .titi-chat-msg { max-width: 82%; padding: 10px 13px; border-radius: 10px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; }
    .titi-chat-msg.user { align-self: flex-end; background: #F2B705; color: #15171C; border-bottom-right-radius: 2px; }
    .titi-chat-msg.bot { align-self: flex-start; background: #fff; color: #15171C; border: 1px solid #EDE7D6; border-bottom-left-radius: 2px; }
    .titi-chat-msg.typing { align-self: flex-start; background: #fff; border: 1px solid #EDE7D6; color: #6B7280; font-style: italic; }

    .titi-chat-inputrow {
      display: flex; gap: 8px; padding: 12px; border-top: 1px solid #EDE7D6; background: #fff;
    }
    .titi-chat-inputrow input {
      flex: 1; border: 1.5px solid #EDE7D6; border-radius: 8px; padding: 10px 12px;
      font-size: 13.5px; font-family: inherit; outline: none;
    }
    .titi-chat-inputrow input:focus { border-color: #F2B705; }
    .titi-chat-send {
      background: #15171C; color: #F2B705; border: none; border-radius: 8px;
      padding: 0 16px; font-weight: 700; font-size: 13px; cursor: pointer;
    }
    .titi-chat-send:disabled { opacity: 0.5; cursor: default; }

    @media (max-width: 480px) {
      .titi-chat-panel { right: 16px; bottom: 148px; }
      .titi-chat-launcher { right: 16px; bottom: 84px; }
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const launcher = document.createElement('button');
  launcher.className = 'titi-chat-launcher';
  launcher.setAttribute('aria-label', 'Abrir chat de Titi Hotels');
  launcher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#15171C" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  const panel = document.createElement('div');
  panel.className = 'titi-chat-panel';
  panel.innerHTML = `
    <div class="titi-chat-header">
      <div>
        <div class="titi-chat-header-title">Titi Hotels</div>
        <div class="titi-chat-header-sub">Consulta tu hotel en Nueva York</div>
      </div>
      <button class="titi-chat-close" aria-label="Cerrar chat">&times;</button>
    </div>
    <div class="titi-chat-messages"></div>
    <form class="titi-chat-inputrow">
      <input type="text" placeholder="Escribe tu mensaje..." />
      <button class="titi-chat-send" type="submit">Enviar</button>
    </form>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector('.titi-chat-messages');
  const formEl = panel.querySelector('.titi-chat-inputrow');
  const inputEl = panel.querySelector('input');
  const sendBtn = panel.querySelector('.titi-chat-send');
  const closeBtn = panel.querySelector('.titi-chat-close');

  function renderMessage(role, text) {
    const el = document.createElement('div');
    el.className = `titi-chat-msg ${role}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  wireChat({ formEl, inputEl, sendBtn, renderMessage });

  function showGreetingIfEmpty() {
    if (messagesEl.children.length === 0) {
      renderMessage('bot', 'Hola! Soy del equipo de Titi Hotels. Cuéntame qué hotel o zona te interesa en Nueva York y para qué fechas, y te digo el precio más barato al momento.');
    }
  }

  let open = false;
  function togglePanel(force) {
    open = typeof force === 'boolean' ? force : !open;
    panel.classList.toggle('open', open);
    if (open) {
      showGreetingIfEmpty();
      inputEl.focus();
    }
  }

  launcher.addEventListener('click', () => togglePanel());
  closeBtn.addEventListener('click', () => togglePanel(false));
})();
