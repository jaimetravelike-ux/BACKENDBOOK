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

  function startFactRotation(el) {
    let i = 1;
    const interval = setInterval(() => {
      el.textContent = NYC_FACTS[i % NYC_FACTS.length];
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
            if (resolved.result?.found && onResult) onResult(resolved.result);
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
    function scrollThreadToBottom() {
      heroThread.scrollTop = heroThread.scrollHeight;
      requestAnimationFrame(() => {
        heroThread.scrollTop = heroThread.scrollHeight;
      });
      setTimeout(() => {
        heroThread.scrollTop = heroThread.scrollHeight;
      }, 300);
    }

    function renderHeroMessage(role, text) {
      const el = document.createElement('div');
      el.className = `msg ${role}`;
      el.textContent = text;
      heroThread.appendChild(el);
      heroThread.classList.add('open');
      scrollThreadToBottom();
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

      const favKey = (result.hotel || 'hotel').toLowerCase();
      const favActive = isFavorite(favKey);

      const rating = ratingInfo(result.reviewScore);

      const metaParts = [];
      if (result.nights) metaParts.push(`${result.nights} noche${result.nights === 1 ? '' : 's'}`);
      if (result.adults) metaParts.push(`${result.adults} adulto${Number(result.adults) === 1 ? '' : 's'}`);
      if (result.rooms) metaParts.push(`${result.rooms} habitación${Number(result.rooms) === 1 ? '' : 'es'}`);

      const taxesLine = result.includedTaxesAmount
        ? `Impuestos y tasas incluidos: ${escapeHtml(result.includedTaxesAmount)}`
        : result.extraChargesNotice
          ? escapeHtml(result.extraChargesNotice)
          : '';

      wrap.innerHTML = `
        <div class="hotel-card-media">
          <button class="hotel-card-fav ${favActive ? 'active' : ''}" type="button" aria-label="Guardar en favoritos">
            <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10.1-9.1C.4 9 1.4 5.3 4.7 4.2c2-.7 4.1 0 5.3 1.7 1.2-1.7 3.3-2.4 5.3-1.7 3.3 1.1 4.3 4.8 2.8 7.7C19.5 16.4 12 21 12 21z"/></svg>
          </button>
          ${result.discount ? `<div class="hotel-card-discount">${escapeHtml(result.discount.label)}</div>` : ''}
          <div class="hotel-card-gallery">${slides}${dots}</div>
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
          ${metaParts.length ? `<div class="hotel-card-meta">${metaParts.join(' · ')}</div>` : ''}
          <div class="hotel-card-price">
            ${result.discount?.originalPrice ? `<div class="hotel-card-price-original">${escapeHtml(result.discount.originalPrice)}</div>` : ''}
            ${result.totalPrice ? `<div class="hotel-card-price-total">${escapeHtml(result.totalPrice)}</div>` : ''}
            ${result.pricePerNight ? `<div class="hotel-card-price-night">${escapeHtml(result.pricePerNight)} / noche</div>` : ''}
            ${taxesLine ? `<div class="hotel-card-price-taxes">${taxesLine}</div>` : ''}
          </div>
        </div>
      `;

      const favBtn = wrap.querySelector('.hotel-card-fav');
      favBtn.addEventListener('click', () => {
        const next = !favBtn.classList.contains('active');
        favBtn.classList.toggle('active', next);
        setFavorite(favKey, next);
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
        dotBtns.forEach((d) => d.addEventListener('click', () => show(Number(d.dataset.i))));
        const autoplay = setInterval(() => show(current + 1), 3500);
        wrap.addEventListener('mouseenter', () => clearInterval(autoplay));
      }

      heroThread.appendChild(wrap);
      scrollThreadToBottom();
      const firstImg = wrap.querySelector('.hotel-card-gallery img');
      if (firstImg && !firstImg.complete) {
        firstImg.addEventListener('load', scrollThreadToBottom, { once: true });
      }
    }

    function focusChatMode() {
      if (heroWrapper) heroWrapper.classList.add('chat-focused');
    }

    wireChat({
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
