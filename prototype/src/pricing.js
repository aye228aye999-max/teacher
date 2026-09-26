// Цены Gemini 3.8 Live, USD за 1M токенов (платный тариф, сентябрь 2026).
// Размышления модели оплачиваются по цене аудиовыхода.
export const PRICES = {
  audioIn: 3.0,
  textIn: 0.75,
  audioOut: 12.0,
  textOut: 4.5,
};

function countByModality(details = []) {
  const out = { AUDIO: 0, TEXT: 0, OTHER: 0 };
  for (const d of details) {
    const key = d.modality === 'AUDIO' || d.modality === 'TEXT' ? d.modality : 'OTHER';
    out[key] += d.tokenCount || 0;
  }
  return out;
}

// Разбивает usageMetadata одного хода на токены и стоимость.
// Скидку за кеш не учитываем, так что оценка скорее завышена.
export function usageToCost(usage) {
  if (!usage) return { tokens: {}, cost: 0 };
  const prompt = countByModality(usage.promptTokensDetails);
  const response = countByModality(usage.responseTokensDetails);
  // Если разбивки по модальностям нет, считаем всё аудио — это дороже.
  if (!usage.promptTokensDetails && usage.promptTokenCount) prompt.AUDIO = usage.promptTokenCount;
  if (!usage.responseTokensDetails && usage.responseTokenCount) response.AUDIO = usage.responseTokenCount;
  const thoughts = usage.thoughtsTokenCount || 0;

  const tokens = {
    audioIn: prompt.AUDIO,
    textIn: prompt.TEXT + prompt.OTHER + (usage.toolUsePromptTokenCount || 0),
    audioOut: response.AUDIO + thoughts,
    textOut: response.TEXT + response.OTHER,
  };
  const cost =
    (tokens.audioIn * PRICES.audioIn +
      tokens.textIn * PRICES.textIn +
      tokens.audioOut * PRICES.audioOut +
      tokens.textOut * PRICES.textOut) /
    1e6;
  return { tokens, cost };
}
