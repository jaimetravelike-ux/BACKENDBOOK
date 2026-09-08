(function () {
  const scriptTag = document.currentScript;
  const API_URL = (scriptTag && scriptTag.getAttribute('data-api-url')) || 'http://localhost:8787';

  const STORAGE_KEY = 'titiChatSessionId';
  const HISTORY_KEY = 'titiChatHistory';

  function getSessionId() {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  function loadHistory() {
    try {
      return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveHistory(history) {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

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
    <div class="titi-chat-inputrow">
      <input type="text" placeholder="Escribe tu mensaje..." />
      <button class="titi-chat-send">Enviar</button>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector('.titi-chat-messages');
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

  async function postJSON(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    sendBtn.disabled = true;
    inputEl.disabled = true;

    renderMessage('user', text);
    const typingEl = renderMessage('typing', 'Escribiendo...');

    try {
      const sessionId = getSessionId();
      const { reply, pendingSearch } = await postJSON('/api/chat', { sessionId, message: text });
      typingEl.remove();
      renderMessage('bot', reply);

      if (pendingSearch) {
        const checkingEl = renderMessage('typing', 'Comprobando el mejor precio...');
        try {
          const resolved = await postJSON('/api/chat/resolve', { sessionId });
          checkingEl.remove();
          renderMessage('bot', resolved.reply);
        } catch {
          checkingEl.remove();
          renderMessage('bot', 'No he podido comprobar el precio justo ahora. ¿Lo intentamos de nuevo en un momento?');
        }
      }
    } catch {
      typingEl.remove();
      renderMessage('bot', 'Se me ha cortado la conexión. ¿Puedes escribirlo otra vez?');
    } finally {
      sendBtn.disabled = false;
      inputEl.disabled = false;
      inputEl.focus();
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
})();
