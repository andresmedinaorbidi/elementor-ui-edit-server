require('dotenv').config();
const express = require('express');
const { requireAuth } = require('./middleware/auth');
const { buildPrompt, callGemini, parseEditsFromLLM } = require('./llm');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Optional: apply shared-secret auth to /edits
if (process.env.SERVICE_SECRET) {
  app.use('/edits', requireAuth);
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/edits', async (req, res) => {
  const requestId = Math.random().toString(36).slice(2, 10);
  const { dictionary, instruction } = req.body || {};

  console.log(`[${requestId}] POST /edits - request received`);
  console.log(`[${requestId}] POST /edits - input:`, JSON.stringify({ dictionary, instruction }));

  if (!Array.isArray(dictionary) || typeof instruction !== 'string' || !instruction.trim()) {
    console.warn(`[${requestId}] POST /edits - validation failed: missing dictionary or instruction`);
    return res.status(200).json({ error: 'Missing dictionary or instruction' });
  }

  try {
    const prompt = buildPrompt(dictionary, instruction);
    const raw = await callGemini(prompt);
    const edits = parseEditsFromLLM(raw, dictionary);
    console.log(`[${requestId}] POST /edits - success, edits count:`, edits.length);
    console.log(`[${requestId}] POST /edits - output:`, JSON.stringify({ edits }));
    return res.status(200).json({ edits });
  } catch (e) {
    console.error(`[${requestId}] POST /edits - error:`, e.message);
    console.error(`[${requestId}] POST /edits - stack:`, e.stack);
    return res.status(200).json({ error: e.message || 'LLM request failed' });
  }
});

app.listen(PORT, () => {
  console.log(`AI Edit Service listening on port ${PORT}`);
});
