// Настройки сессии Gemini Live. Общий модуль для браузера и автотеста.

import { ActivityHandling, EndSensitivity, Modality } from '@google/genai';
import { DEFAULT_SILENCE_MS, TEACHER_VOICE } from './config.js';
import { buildSystemInstruction, LESSON_TOOLS } from './lesson-prompt.js';

export function buildLiveConfig(lesson, options = {}) {
  const {
    voice = TEACHER_VOICE,
    silenceMs = DEFAULT_SILENCE_MS,
    proactive = false,
    affective = false,
    resumeHandle,
  } = options;

  const config = {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    systemInstruction: buildSystemInstruction(lesson),
    tools: LESSON_TOOLS,
    // Расшифровка по умолчанию дословная (VERBATIM): ошибки ученика не «исправляются».
    inputAudioTranscription: { languageCodes: ['en-US', 'ru-RU'] },
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        // LOW: реже решаем, что ученик договорил, — терпеливее к паузам.
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        silenceDurationMs: silenceMs,
      },
      // Ученик может перебить Анну.
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
    },
    // Без сжатия аудиосессия ограничена 15 минутами.
    contextWindowCompression: { slidingWindow: {} },
    // Сервер периодически рвёт соединение: храним handle, чтобы продолжить с того же места.
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };
  if (proactive) config.proactivity = { proactiveAudio: true };
  if (affective) config.enableAffectiveDialog = true;
  return config;
}
