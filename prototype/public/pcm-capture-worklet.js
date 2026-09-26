// AudioWorklet: берёт звук с микрофона, пересэмплирует в 16 кГц,
// переводит в 16-битный PCM и отдаёт кусками по ~100 мс.
// Заодно считает громкость куска, чтобы замерять задержку ответа.

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 мс при 16 кГц
const CUTOFF_HZ = 7000; // срезаем всё выше, чтобы при понижении частоты не было призвуков

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // sampleRate — частота AudioContext
    // Двухкаскадный однополюсный фильтр нижних частот.
    this.alpha = this.ratio > 1 ? 1 - Math.exp((-2 * Math.PI * CUTOFF_HZ) / sampleRate) : 1;
    this.lp1 = 0;
    this.lp2 = 0;
    this.filtered = new Float32Array(128);
    this.pos = 0; // дробная позиция следующего выходного отсчёта во входном блоке
    this.prev = 0; // последний отфильтрованный отсчёт прошлого блока
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    if (this.filtered.length !== channel.length) this.filtered = new Float32Array(channel.length);
    const f = this.filtered;
    for (let n = 0; n < channel.length; n++) {
      this.lp1 += this.alpha * (channel[n] - this.lp1);
      this.lp2 += this.alpha * (this.lp1 - this.lp2);
      f[n] = this.lp2;
    }

    // Линейная интерполяция; индекс -1 — последний отсчёт прошлого блока.
    const get = (i) => (i < 0 ? this.prev : f[i]);
    while (this.pos < f.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s = get(i) + (get(i + 1) - get(i)) * frac;
      const clamped = Math.max(-1, Math.min(1, s));
      this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.sumSquares += clamped * clamped;
      if (this.outLen === CHUNK_SAMPLES) this.flush();
      this.pos += this.ratio;
    }
    this.pos -= f.length;
    this.prev = f[f.length - 1];
    return true;
  }

  flush() {
    const rms = Math.sqrt(this.sumSquares / this.outLen);
    const pcm = this.out.slice(0, this.outLen);
    this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    this.outLen = 0;
    this.sumSquares = 0;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
