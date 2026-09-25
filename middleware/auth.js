const { db } = require('../db');

function requireGate(req, res, next) {
  if (req.session && req.session.gatePassed) return next();
  return res.status(401).json({ error: 'gate_required' });
}

function requirePlayer(req, res, next) {
  if (req.session && req.session.playerId) return next();
  return res.status(401).json({ error: 'player_required' });
}

// Team membership is assigned by a roster match — never trust a cached
// session value for it. Always resolve fresh from the players table and attach it.
function requireTeam(req, res, next) {
  if (!req.session || !req.session.playerId) return res.status(401).json({ error: 'player_required' });
  const player = db.prepare('SELECT team_id FROM players WHERE id = ?').get(req.session.playerId);
  if (!player || !player.team_id) return res.status(401).json({ error: 'team_required' });
  req.teamId = player.team_id;
  return next();
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'admin_required' });
}

// Lightweight CSRF-style defense: for any state-changing request, require
// that it actually came from our own front end (same-origin fetch sets this header).
function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const requestedWith = req.get('X-Requested-With');
  if (requestedWith === 'scavenger-hunt-app') return next();
  return res.status(403).json({ error: 'bad_origin' });
}

module.exports = { requireGate, requirePlayer, requireTeam, requireAdmin, requireSameOrigin };
