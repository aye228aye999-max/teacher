// Общие настройки прототипа. Работают и в браузере, и в Node-скриптах.

// Модели Gemini (сентябрь 2026).
export const LIVE_MODELS = {
  live: 'gemini-3.8-live',
  thinking: 'gemini-3.8-live-extended-thinking',
};
export const TTS_MODEL = 'gemini-3.8-flash-tts';

// Голос учителя. У TTS и Live общий набор голосов, поэтому записи
// и живой разговор звучат одним голосом.
export const TEACHER_VOICE = 'Kore';
// Голос «ученика» для автотеста (scripts/smoke-test.mjs).
export const STUDENT_TEST_VOICE = 'Puck';

// Сколько тишины (мс) считаем концом реплики. Ученики делают паузы
// посреди фразы, поэтому ждём дольше, чем обычный голосовой бот.
export const DEFAULT_SILENCE_MS = 1200;

// Формат аудио Live API.
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
