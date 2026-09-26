import { GoogleGenAI } from '@google/genai';
import { defineConfig, loadEnv } from 'vite';

// Локальный эндпоинт /api/token: выдаёт браузеру одноразовый токен Gemini Live,
// чтобы ключ API оставался на компьютере и не попадал в страницу.
// GEMINI_MOCK_URL — адрес имитации Gemini для автотестов (scripts/mock-live-server.mjs).
function geminiTokenPlugin(apiKey, mockUrl) {
  return {
    name: 'gemini-token',
    configureServer(server) {
      server.middlewares.use('/api/token', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (mockUrl) {
          res.end(JSON.stringify({ token: 'mock-token', baseUrl: mockUrl }));
          return;
        }
        if (!apiKey) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Нет GEMINI_API_KEY: добавь его в файл prototype/.env' }));
          return;
        }
        try {
          const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
          const now = Date.now();
          const token = await ai.authTokens.create({
            config: {
              uses: 1,
              expireTime: new Date(now + 60 * 60 * 1000).toISOString(),
              newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
              httpOptions: { apiVersion: 'v1alpha' },
            },
          });
          res.end(JSON.stringify({ token: token.name }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: `Токен не выдан: ${err.message}` }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [geminiTokenPlugin(env.GEMINI_API_KEY, env.GEMINI_MOCK_URL)],
    server: { port: 5173 },
  };
});
