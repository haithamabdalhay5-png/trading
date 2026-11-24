import { GoogleGenAI } from "@google/genai";

export function getGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL?.trim();
  if (!apiKey || !model) return null;
  return { apiKey, model };
}

export function createGeminiClient() {
  const config = getGeminiConfig();
  if (!config) return null;
  return new GoogleGenAI({ apiKey: config.apiKey });
}

export async function generateStructuredGeminiJson(input: {
  systemInstruction: string;
  contextJson: string;
  responseSchema: object;
  timeoutMs?: number;
}) {
  const config = getGeminiConfig();
  const client = createGeminiClient();
  if (!config || !client) throw new Error("GEMINI_NOT_CONFIGURED");

  const timeoutMs = input.timeoutMs ?? 25_000;
  const maxRetries = Math.max(0, Number(process.env.GEMINI_MAX_RETRIES ?? 1));
  let response: Awaited<ReturnType<typeof client.models.generateContent>> | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      response = await Promise.race([
        client.models.generateContent({
          model: config.model,
          contents: `${input.systemInstruction}\n\nMARKET_CONTEXT_JSON\n${input.contextJson}`,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: input.responseSchema,
          },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("GEMINI_TIMEOUT")), timeoutMs)),
      ]);
      break;
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  if (!response) throw new Error("GEMINI_EMPTY_RESPONSE");
  const text = response.text;
  if (!text) throw new Error("GEMINI_EMPTY_RESPONSE");
  return JSON.parse(text) as unknown;
}
