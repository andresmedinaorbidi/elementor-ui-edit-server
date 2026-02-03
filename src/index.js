require('dotenv').config();
const path = require('path');
const express = require('express');
const { requireAuth } = require('./middleware/auth');
const { buildPrompt, buildKitPrompt, callGemini, parseEditsFromLLM, parseKitPatchFromLLM } = require('./llm');
const { addRequest, getRequests } = require('./store');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  const body = req.body || {};
  const { context_type, instruction } = body;

  console.log(`[${requestId}] POST /edits - request received`);
  if (context_type === 'kit') {
    // --- Kit (theme) edit ---
    const { kit_settings = {} } = body;
    console.log(`[${requestId}] POST /edits - kit edit, instruction length:`, instruction?.length);

    if (typeof instruction !== 'string' || !instruction.trim()) {
      console.warn(`[${requestId}] POST /edits - kit: validation failed: missing instruction`);
      addRequest(requestId, body, { error: 'Missing instruction for kit edit' }, 'kit');
      return res.status(200).json({ error: 'Missing instruction for kit edit' });
    }
    const ks = typeof kit_settings === 'object' && kit_settings !== null ? kit_settings : {};
    const colors = Array.isArray(ks.colors) ? ks.colors : [];
    const typography = Array.isArray(ks.typography) ? ks.typography : [];
    const normalizedKitSettings = { colors, typography };

    try {
      const prompt = buildKitPrompt(normalizedKitSettings, instruction.trim());
      const raw = await callGemini(prompt);
      const kit_patch = parseKitPatchFromLLM(raw);
      console.log(`[${requestId}] POST /edits - kit success, kit_patch keys:`, Object.keys(kit_patch));
      addRequest(requestId, body, { kit_patch }, 'kit');
      return res.status(200).json({ kit_patch });
    } catch (e) {
      console.error(`[${requestId}] POST /edits - kit error:`, e.message);
      addRequest(requestId, body, { error: e.message || 'Kit LLM request failed' }, 'kit');
      return res.status(200).json({ error: e.message || 'Kit LLM request failed' });
    }
  }

  // --- Page/template edit ---
  const {
    dictionary,
    image_slots = [],
    edit_capabilities = ['text']
  } = body;

  console.log(`[${requestId}] POST /edits - input:`, JSON.stringify({ dictionary, instruction, image_slots: image_slots?.length, edit_capabilities }));

  if (!Array.isArray(dictionary) || typeof instruction !== 'string' || !instruction.trim()) {
    console.warn(`[${requestId}] POST /edits - validation failed: missing dictionary or instruction`);
    addRequest(requestId, body, { error: 'Missing dictionary or instruction' }, 'page');
    return res.status(200).json({ error: 'Missing dictionary or instruction' });
  }
  const imageSlots = Array.isArray(image_slots) ? image_slots : [];
  const capabilities = Array.isArray(edit_capabilities) ? edit_capabilities : ['text'];
  if (imageSlots.length > 0 || capabilities.length > 1) {
    console.log(`[${requestId}] POST /edits - image_slots: ${imageSlots.length}, edit_capabilities:`, capabilities);
  }

  try {
    const prompt = buildPrompt(dictionary, instruction, imageSlots, capabilities);
    const raw = await callGemini(prompt);
    const edits = parseEditsFromLLM(raw, dictionary, imageSlots, capabilities);
    console.log(`[${requestId}] POST /edits - success, edits count:`, edits.length);
    console.log(`[${requestId}] POST /edits - output:`, JSON.stringify({ edits }));
    addRequest(requestId, body, { edits }, 'page');
    return res.status(200).json({ edits });
  } catch (e) {
    console.error(`[${requestId}] POST /edits - error:`, e.message);
    console.error(`[${requestId}] POST /edits - stack:`, e.stack);
    addRequest(requestId, body, { error: e.message || 'LLM request failed' }, 'page');
    return res.status(200).json({ error: e.message || 'LLM request failed' });
  }
});

app.get('/api/requests', (_req, res) => {
  res.status(200).json(getRequests());
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`AI Edit Service listening on port ${PORT}`);
});
