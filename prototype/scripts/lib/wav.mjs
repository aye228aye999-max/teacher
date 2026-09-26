// Минимальная работа с WAV (16-битный PCM, моно).

import { readFileSync } from 'node:fs';

export function pcm16ToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // размер блока fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // байт в секунду
  header.writeUInt16LE(2, 32); // байт на отсчёт
  header.writeUInt16LE(16, 34); // бит на отсчёт
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function readWav(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: не WAV`);
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      if (buf.readUInt16LE(body + 14) !== 16) throw new Error(`${file}: нужен 16-битный PCM`);
    } else if (id === 'data') {
      const data = buf.subarray(body, body + size);
      const all = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)));
      if (channels === 1) return { samples: all, sampleRate };
      const mono = new Int16Array(Math.floor(all.length / channels));
      for (let i = 0; i < mono.length; i++) mono[i] = all[i * channels];
      return { samples: mono, sampleRate };
    }
    offset = body + size + (size & 1);
  }
  throw new Error(`${file}: нет данных`);
}

// Линейная интерполяция; для теста речи этого достаточно.
export function resample(samples, from, to) {
  if (from === to) return samples;
  const out = new Int16Array(Math.floor((samples.length * to) / from));
  const ratio = from / to;
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const a = samples[j];
    const b = samples[Math.min(j + 1, samples.length - 1)];
    out[i] = Math.round(a + (b - a) * (pos - j));
  }
  return out;
}

export function durationSec(pcmBytes, sampleRate) {
  return pcmBytes / 2 / sampleRate;
}
