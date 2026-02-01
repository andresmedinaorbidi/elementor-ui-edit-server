/**
 * Optional auth: require X-Service-Key header to match SERVICE_SECRET.
 * Only applied when SERVICE_SECRET is set (see index.js).
 */
function requireAuth(req, res, next) {
  const secret = process.env.SERVICE_SECRET;
  if (!secret) return next();

  const key = req.headers['x-service-key'];
  if (key !== secret) {
    console.warn('[POST /edits] Auth failed: invalid or missing X-Service-Key');
    return res.status(200).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { requireAuth };
