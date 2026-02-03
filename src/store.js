/**
 * In-memory store of recent POST /edits request/response records.
 * Keeps the last N entries (newest first).
 */
const MAX_REQUESTS = 50;
const requests = [];

/**
 * @param {string} id - Request ID
 * @param {object} body - Raw request body
 * @param {object} response - Response payload sent (e.g. { edits }, { kit_patch }, { error })
 * @param {'kit'|'page'} contextType - 'kit' or 'page'
 */
function addRequest(id, body, response, contextType) {
  const record = {
    id,
    timestamp: new Date().toISOString(),
    body,
    response,
    contextType: contextType === 'kit' ? 'kit' : 'page'
  };
  requests.unshift(record);
  if (requests.length > MAX_REQUESTS) {
    requests.pop();
  }
}

/**
 * @returns {Array} List of request records (newest first)
 */
function getRequests() {
  return [...requests];
}

module.exports = { addRequest, getRequests };
