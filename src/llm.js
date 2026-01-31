const { GoogleGenerativeAI } = require('@google/generative-ai');

const SYSTEM_PROMPT = `You are a precise editor. You receive a JSON array of page widgets, each with "id", "path", "widget_type", and "text".
Given the user instruction, return a JSON array of edits. Each edit must have "id" or "path" (same as in the input) and "new_text" (the new content for that widget).
Return only the JSON array, no other text. If no changes are needed, return [].
For heading widgets, new_text is plain text. For text-editor widgets, new_text can be HTML.`;

/**
 * Build combined prompt for Gemini (no separate system role; prepend system to user message).
 */
function buildPrompt(dictionary, instruction) {
  const userPart = `Dictionary:\n${JSON.stringify(dictionary)}\n\nUser instruction: ${instruction}`;
  return `${SYSTEM_PROMPT}\n\n${userPart}`;
}

/**
 * Call Gemini and return raw text (expected to be a JSON array string).
 */
async function callGemini(prompt) {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required');

  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  const result = await model.generateContent(prompt);
  const response = result.response;
  if (!response) throw new Error('No response from Gemini');
  return response.text() || '[]';
}

/**
 * Parse LLM output into edits array. Each edit has id?, path?, new_text.
 * Resolves id/path from dictionary when model returns only one.
 * Throws if raw is not valid JSON or parsed value is not an array.
 */
function parseEditsFromLLM(raw, dictionary) {
  let text = (raw || '').trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/;
  const match = text.match(codeBlock);
  if (match) text = match[1].trim();

  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error('Invalid LLM response');
  }
  if (!Array.isArray(arr)) throw new Error('Invalid LLM response');

  return arr
    .filter((item) => item && (item.id != null || item.path != null) && item.new_text != null)
    .map((item) => ({
      id: item.id ?? dictionary.find((d) => d.path === item.path)?.id ?? '',
      path: item.path ?? dictionary.find((d) => d.id === item.id)?.path ?? '',
      new_text: String(item.new_text)
    }))
    .filter((e) => e.id !== '' || e.path !== '');
}

module.exports = { buildPrompt, callGemini, parseEditsFromLLM };
