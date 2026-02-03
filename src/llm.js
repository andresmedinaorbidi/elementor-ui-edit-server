const { GoogleGenerativeAI } = require('@google/generative-ai');

const KIT_SYSTEM_PROMPT = `You are a theme/kit editor for Elementor. You receive:
1. **kit_settings** — Object with:
   - **colors** (array): System colors. Each item has _id (e.g. "primary", "secondary"), title, and value (hex string, e.g. "#1e3a5f").
   - **typography** (array): System typography. Each item has _id (e.g. "primary", "text"), title, and typography_* fields (typography_font_family, typography_font_size with { unit, size }, typography_font_weight, typography_line_height, typography_letter_spacing, etc.).
2. **User instruction** — Natural language (e.g. "Make primary color darker blue", "Use Roboto for headings").

Output: A single JSON object with optional "colors" and "typography" arrays. Include ONLY the items you want to change.
- **colors**: Each object MUST have _id (preserve from request), title, and value (hex string, e.g. "#0d1f36"). Omit colors array or use [] if no color changes.
- **typography**: Each object MUST have _id (preserve from request). Include title if you have it, and only the typography_* fields you want to set (e.g. typography_font_family, typography_font_size, typography_font_weight). For font_size use object: { "unit": "px", "size": number }. Omit typography array or use [] if no typography changes.
Return ONLY valid JSON: { "colors": [...], "typography": [...] } or {} or { "colors": [], "typography": [] }. No markdown, no explanation.`;

const SYSTEM_PROMPT = `You are a precise editor. You receive:
1. **Dictionary** — JSON array of text/link slots. Each entry has: id, path, widget_type, optional field, text, and optional link_url. If link_url is present, you may return a link edit for that slot (new_url or new_link with url, optional is_external, nofollow).
2. **Image slots** (when provided) — JSON array of image/background slots: { id, path, slot_type, el_type, image_url, image_id? }. You may return image edits for these by id or path using new_image_url and/or new_attachment_id, or new_image: { url?, id? }.
3. **edit_capabilities** — Array of allowed edit types (e.g. ["text","url","image"]). Return ONLY edit types that are in this array. If "image" is missing, do not return image edits; if "url" is missing, do not return link edits.
4. **User instruction** — Natural language instruction.

Output: One JSON array of edits. Each edit must have "id" or "path" (same as in the input). Then include only the edit types that apply and are allowed:
- **Text:** new_text (string). Optional: field, item_index (0-based). For heading widgets use plain text; for text-editor use HTML.
- **Links:** new_url (string) or new_link (object with url, optional is_external, nofollow) for dictionary slots that have link_url.
- **Images:** new_image_url and/or new_attachment_id, or new_image: { url?, id? } for slots from image_slots.
Return only the JSON array, no other text. If no changes are needed, return [].`;

/**
 * Build combined prompt for Gemini (no separate system role; prepend system to user message).
 */
function buildPrompt(dictionary, instruction, image_slots = [], edit_capabilities = ['text']) {
  const parts = [
    `Dictionary:\n${JSON.stringify(dictionary)}`,
    `Edit capabilities (return only these types): ${JSON.stringify(edit_capabilities)}`,
    `User instruction: ${instruction}`
  ];
  if (image_slots && image_slots.length > 0) {
    parts.splice(1, 0, `Image slots:\n${JSON.stringify(image_slots)}`);
  }
  const userPart = parts.join('\n\n');
  return `${SYSTEM_PROMPT}\n\n${userPart}`;
}

/**
 * Build prompt for kit (theme) edit: kit_settings + instruction.
 */
function buildKitPrompt(kit_settings, instruction) {
  const userPart = `kit_settings:\n${JSON.stringify(kit_settings)}\n\nUser instruction: ${instruction}`;
  return `${KIT_SYSTEM_PROMPT}\n\n${userPart}`;
}

/**
 * Call Gemini and return raw text (expected to be a JSON array string for edits, or JSON object for kit).
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

function hasEditPayload(item) {
  return (
    item.new_text != null ||
    item.new_url != null ||
    item.new_link != null ||
    item.new_image_url != null ||
    item.new_attachment_id != null ||
    item.new_image != null
  );
}

function resolveIdPath(item, dictionary, image_slots) {
  const fromDict = dictionary.find((d) => d.path === item.path || d.id === item.id);
  const fromSlots = image_slots && image_slots.find((s) => s.path === item.path || s.id === item.id);
  const source = fromDict || fromSlots;
  return {
    id: item.id ?? source?.id ?? '',
    path: item.path ?? source?.path ?? ''
  };
}

function filterByCapabilities(edit, edit_capabilities) {
  const out = { id: edit.id, path: edit.path };
  if (edit_capabilities.includes('text') && edit.new_text != null) {
    out.new_text = edit.new_text;
    if (edit.field != null) out.field = edit.field;
    if (edit.item_index != null) out.item_index = edit.item_index;
  }
  if (edit_capabilities.includes('url')) {
    if (edit.new_url != null) out.new_url = edit.new_url;
    if (edit.new_link != null) out.new_link = edit.new_link;
  }
  if (edit_capabilities.includes('image')) {
    if (edit.new_image_url != null) out.new_image_url = edit.new_image_url;
    if (edit.new_attachment_id != null) out.new_attachment_id = edit.new_attachment_id;
    if (edit.new_image != null) out.new_image = edit.new_image;
  }
  const hasPayload = 'new_text' in out || 'new_url' in out || 'new_link' in out || 'new_image_url' in out || 'new_attachment_id' in out || 'new_image' in out;
  return hasPayload ? out : null;
}

/**
 * Parse LLM output into edits array. Each edit has id or path and one or more of:
 * new_text (optional field, item_index), new_url or new_link, new_image_url/new_attachment_id/new_image.
 * Resolves id/path from dictionary or image_slots when model returns only one.
 * Throws if raw is not valid JSON or parsed value is not an array.
 */
function parseEditsFromLLM(raw, dictionary, image_slots = [], edit_capabilities = ['text']) {
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

  const slots = Array.isArray(image_slots) ? image_slots : [];
  const caps = Array.isArray(edit_capabilities) ? edit_capabilities : ['text'];

  return arr
    .filter((item) => item && (item.id != null || item.path != null) && hasEditPayload(item))
    .map((item) => {
      const { id, path } = resolveIdPath(item, dictionary, slots);
      const edit = { id, path };
      if (item.new_text != null) {
        edit.new_text = String(item.new_text);
        if (item.field != null) edit.field = item.field;
        if (item.item_index != null) edit.item_index = item.item_index;
      }
      if (item.new_url != null) edit.new_url = item.new_url;
      if (item.new_link != null) edit.new_link = item.new_link;
      if (item.new_image_url != null) edit.new_image_url = item.new_image_url;
      if (item.new_attachment_id != null) edit.new_attachment_id = item.new_attachment_id;
      if (item.new_image != null) edit.new_image = item.new_image;
      return filterByCapabilities(edit, caps);
    })
    .filter((e) => e != null)
    .filter((e) => e.id !== '' || e.path !== '');
}

/**
 * Parse LLM output into kit_patch: { colors?, typography? }.
 * Preserves _id and title; validates color value is hex-like; allows typography_* fields.
 * Throws if raw is not valid JSON or structure is wrong.
 */
function parseKitPatchFromLLM(raw) {
  let text = (raw || '').trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/;
  const match = text.match(codeBlock);
  if (match) text = match[1].trim();

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('Invalid LLM response for kit');
  }
  if (obj == null || typeof obj !== 'object') throw new Error('Invalid LLM response for kit');

  const kit_patch = {};
  if (Array.isArray(obj.colors) && obj.colors.length > 0) {
    kit_patch.colors = obj.colors
      .filter((c) => c && typeof c === 'object' && c._id != null)
      .map((c) => ({
        _id: String(c._id),
        title: c.title != null ? String(c.title) : '',
        value: typeof c.value === 'string' ? c.value.trim() : (c.value != null ? String(c.value) : '')
      }))
      .filter((c) => c.value !== '');
  }
  if (Array.isArray(obj.typography) && obj.typography.length > 0) {
    kit_patch.typography = obj.typography
      .filter((t) => t && typeof t === 'object' && t._id != null)
      .map((t) => {
        const out = { _id: String(t._id) };
        if (t.title != null) out.title = String(t.title);
        Object.keys(t).forEach((k) => {
          if (k !== '_id' && k !== 'title' && k.startsWith('typography_') && t[k] !== undefined && t[k] !== null) {
            out[k] = t[k];
          }
        });
        return out;
      })
      .filter((t) => Object.keys(t).length > 1);
  }
  if (obj.settings != null && typeof obj.settings === 'object') {
    kit_patch.settings = obj.settings;
  }
  return kit_patch;
}

module.exports = { buildPrompt, buildKitPrompt, callGemini, parseEditsFromLLM, parseKitPatchFromLLM };
