// Звук в браузере: микрофон → PCM 16 кГц и проигрывание ответов и записей.

import { OUTPUT_SAMPLE_RATE } from './config.js';

// Порог громкости куска (RMS), выше которого считаем, что ученик говорит.
// Нужен только для замера паузы перед ответом, на распознавание не влияет.
const VOICE_RMS = 0.02;

export function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function rateFromMime(mime) {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? Number(m[1]) : OUTPUT_SAMPLE_RATE;
}

export class Mic {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = false; // отправлять ли звук в модель
    this.onChunk = null;
    this.lastVoiceAt = 0;
    this.level = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await this.ctx.audioWorklet.addModule('/pcm-capture-worklet.js');
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e) => {
      const { pcm, rms } = e.data;
      this.level = rms;
      if (rms > VOICE_RMS) this.lastVoiceAt = performance.now();
      if (this.enabled && this.onChunk) this.onChunk(pcm);
    };
    // Узел подключаем к выходу через нулевую громкость, иначе браузер может его не запускать.
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(this.ctx.destination);
  }

  stop() {
    this.enabled = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    this.mute?.disconnect();
  }
}

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.sources = new Set();
    this.nextTime = 0;
    this.drainWaiters = [];
    this.clip = null;
  }

  get playing() {
    return this.sources.size > 0;
  }

  // Кусок ответа модели: base64 с 16-битным PCM.
  playPcm16(b64, sampleRate = OUTPUT_SAMPLE_RATE) {
    const bytes = base64ToBytes(b64);
    const samples = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    const now = this.ctx.currentTime;
    if (this.nextTime < now + 0.03) this.nextTime = now + 0.03; // небольшой запас от рывков
    src.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.resolveDrain();
    };
  }

  // Ученик перебил: сразу замолкаем.
  flush() {
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // уже остановлен
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.resolveDrain();
  }

  waitDrained() {
    if (!this.sources.size) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  resolveDrain() {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    waiters.forEach((r) => r());
  }

  // Заранее записанная реплика (WAV). Промис завершается, когда запись доиграла.
  async playUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    await new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.out);
      src.onended = () => {
        this.clip = null;
        resolve();
      };
      this.clip = src;
      src.start();
    });
  }

  stopAll() {
    this.flush();
    if (this.clip) {
      try {
        this.clip.stop();
      } catch {
        // уже остановлен
      }
    }
  }
}
