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
  const { dictionary, instruction } = req.body || {};

  if (!Array.isArray(dictionary) || typeof instruction !== 'string' || !instruction.trim()) {
    return res.status(200).json({ error: 'Missing dictionary or instruction' });
  }

  try {
    const prompt = buildPrompt(dictionary, instruction);
    const raw = await callGemini(prompt);
    const edits = parseEditsFromLLM(raw, dictionary);
    return res.status(200).json({ edits });
  } catch (e) {
    return res.status(200).json({ error: e.message || 'LLM request failed' });
  }
});

app.listen(PORT, () => {
  console.log(`AI Edit Service listening on port ${PORT}`);
});
