const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getSetting } = require('../db');

const router = express.Router();

const gateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', message: 'Too many attempts. Try again later.' },
});

router.get('/question', (req, res) => {
  res.json({
    question: getSetting('gate_question', 'What is the password?'),
    gameTitle: getSetting('game_title', 'Scavenger Hunt'),
    passed: !!(req.session && req.session.gatePassed),
  });
});

router.post('/verify', gateLimiter, (req, res) => {
  const { answer } = req.body || {};
  if (typeof answer !== 'string' || !answer.trim()) {
    return res.status(400).json({ error: 'answer_required' });
  }
  const hash = getSetting('gate_answer_hash');
  if (!hash) return res.status(500).json({ error: 'not_configured' });

  const ok = bcrypt.compareSync(answer.trim().toLowerCase(), hash);
  if (!ok) return res.status(403).json({ error: 'incorrect' });

  req.session.gatePassed = true;
  res.json({ ok: true });
});

module.exports = router;
