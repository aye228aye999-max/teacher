// Соединение с Gemini Live из браузера.
// Ключ API в браузер не попадает: локальный сервер выдаёт одноразовый токен (/api/token).

import { GoogleGenAI } from '@google/genai';
import { bytesToBase64 } from './audio.js';
import { INPUT_SAMPLE_RATE } from './config.js';
import { buildLiveConfig } from './live-config.js';

// baseUrl приходит только в тестовом режиме с имитацией Gemini (GEMINI_MOCK_URL).
async function fetchToken() {
  const res = await fetch('/api/token', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(body.error || `Не удалось получить токен (HTTP ${res.status})`);
  return body;
}

export class LiveLink {
  // handlers: onServerContent, onToolCall, onUsage, onStatus, onError
  constructor({ lesson, model, options, contextMode, handlers, log }) {
    this.lesson = lesson;
    this.model = model;
    this.options = options;
    // clientContent — контекст с ролями (модель/ученик); text — запасной вариант одной строкой.
    this.contextMode = contextMode;
    this.handlers = handlers;
    this.log = log;
    this.session = null;
    this.connId = 0; // сообщения от старых соединений игнорируем
    this.ready = false;
    this.closedByUs = false;
    this.reconnecting = false;
    this.resumeHandle = null;
    this.lastContext = null;
    this.lastContextAt = 0;
    this.pendingContext = null; // контекст, пришедший во время переподключения
  }

  async connect() {
    this.ready = false;
    const { token, baseUrl } = await fetchToken();
    const httpOptions = { apiVersion: 'v1alpha', ...(baseUrl ? { baseUrl } : {}) };
    const ai = new GoogleGenAI({ apiKey: token, httpOptions });
    const config = buildLiveConfig(this.lesson, { ...this.options, resumeHandle: this.resumeHandle });
    const id = ++this.connId;
    let setupOk = false;
    this.log('connect', { model: this.model, resume: Boolean(this.resumeHandle) });

    // SDK ждёт setupComplete и не завершается, если сервер закрыл соединение раньше.
    // Поэтому параллельно ждём закрытия и таймаута.
    let resolveSetup;
    let rejectSetup;
    const setupDone = new Promise((resolve, reject) => {
      resolveSetup = resolve;
      rejectSetup = reject;
    });
    const timer = setTimeout(() => rejectSetup(new Error('сервер не ответил за 20 секунд')), 20000);

    const connecting = ai.live.connect({
      model: this.model,
      config,
      callbacks: {
        onopen: () => {},
        onmessage: (msg) => {
          if (id !== this.connId) return;
          if (msg.setupComplete) {
            setupOk = true;
            resolveSetup();
          }
          this.handleMessage(msg);
        },
        onerror: (e) => {
          if (id !== this.connId) return;
          this.log('ws_error', { message: e?.message || String(e) });
        },
        onclose: (e) => {
          rejectSetup(new Error(e?.reason || `соединение закрыто (код ${e?.code})`));
          // Если сессия так и не запустилась, ошибку обработает тот, кто вызвал connect().
          if (id === this.connId && setupOk) this.handleClose(e);
        },
      },
    });
    try {
      await Promise.race([connecting, setupDone]);
      this.session = await connecting;
    } finally {
      clearTimeout(timer);
    }
    this.ready = true;
  }

  handleMessage(msg) {
    const upd = msg.sessionResumptionUpdate;
    if (upd?.resumable && upd.newHandle) this.resumeHandle = upd.newHandle;
    if (msg.goAway) {
      this.log('go_away', msg.goAway);
      this.reconnect();
    }
    if (msg.toolCall?.functionCalls?.length) this.handlers.onToolCall?.(msg.toolCall.functionCalls);
    if (msg.toolCallCancellation) this.log('tool_cancel', msg.toolCallCancellation);
    if (msg.serverContent) this.handlers.onServerContent?.(msg.serverContent);
    if (msg.usageMetadata) this.handlers.onUsage?.(msg.usageMetadata);
  }

  handleClose(e) {
    this.ready = false;
    this.log('ws_close', { code: e?.code, reason: e?.reason });
    if (this.closedByUs || this.reconnecting) return;

    // Соединение закрылось сразу после контекста с ролями — вероятно, модель
    // не принимает clientContent посреди сессии. Переходим на текстовый режим.
    const justSentContext = this.lastContext && performance.now() - this.lastContextAt < 3000;
    if (justSentContext && this.contextMode === 'clientContent') {
      this.log('context_fallback', { reason: e?.reason });
      this.contextMode = 'text';
      this.reconnect(true);
      return;
    }
    this.reconnect();
  }

  async reconnect(resendContext = false) {
    if (this.reconnecting || this.closedByUs) return;
    this.reconnecting = true;
    this.handlers.onStatus?.('reconnecting');
    const old = this.session;
    this.connId++; // события старого соединения больше не обрабатываем
    this.ready = false;
    try {
      old?.close();
    } catch {
      // уже закрыто
    }
    try {
      await this.connect();
      const ctx = this.pendingContext || (resendContext ? this.lastContext : null);
      this.pendingContext = null;
      if (ctx) this.sendContext(ctx);
      this.handlers.onStatus?.('connected');
    } catch (err) {
      this.handlers.onError?.(`Не удалось переподключиться: ${err.message}`);
    } finally {
      this.reconnecting = false;
    }
  }

  sendAudio(pcmBuffer) {
    if (!this.ready) return;
    this.session.sendRealtimeInput({
      audio: { data: bytesToBase64(pcmBuffer), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
    });
  }

  // ctx = { turns, text } из buildStepContext.
  sendContext(ctx) {
    this.lastContext = ctx;
    this.lastContextAt = performance.now();
    if (!this.ready) {
      this.pendingContext = ctx;
      return;
    }
    this.log('context', { mode: this.contextMode, text: ctx.text });
    if (this.contextMode === 'clientContent') {
      this.session.sendClientContent({ turns: ctx.turns, turnComplete: true });
    } else {
      this.session.sendRealtimeInput({ text: ctx.text });
    }
  }

  sendToolResponses(functionResponses) {
    if (!this.ready) return;
    this.session.sendToolResponse({ functionResponses });
  }

  close() {
    this.closedByUs = true;
    this.ready = false;
    this.connId++;
    try {
      this.session?.close();
    } catch {
      // уже закрыто
    }
  }
}
