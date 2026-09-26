// Синтез речи через Gemini TTS.

import { TTS_MODEL } from '../../src/config.js';

export async function synthesize(ai, { text, voice, style }) {
  // Формат подсказки из руководства Gemini TTS: указания отдельно, текст после TRANSCRIPT.
  const prompt = style ? `### DIRECTOR'S NOTES\n${style}\n\n#### TRANSCRIPT\n${text}` : text;
  const res = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error(`TTS не вернул звук (finishReason: ${res.candidates?.[0]?.finishReason})`);
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1] || 24000);
  return { pcm: Buffer.from(part.inlineData.data, 'base64'), rate, usage: res.usageMetadata };
}
