require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { createServer } = require('http');
const { Server } = require('socket.io');

const { requireSameOrigin } = require('./middleware/auth');
const { db } = require('./db');
const gateRoutes = require('./routes/gate');
const playerRoutes = require('./routes/player');
const adminRoutes = require('./routes/admin');
const { router: gameRoutes } = require('./routes/game');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // bind to loopback; your reverse proxy fronts this
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error(
    '\nFATAL: Set a long random SESSION_SECRET in your .env file before starting.\n' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n'
  );
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1); // we sit behind nginx/caddy

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
}));

app.use(express.json({ limit: '1mb' }));

const sessionMiddleware = session({
  store: new SQLiteStore({ dir: DATA_DIR, db: 'sessions.sqlite' }),
  name: 'hunt.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24, // 24h — plenty for a single event
  },
});
app.use(sessionMiddleware);

// Defense-in-depth CSRF check for our JSON API (browser fetches send this header;
// a cross-site form post never will).
app.use('/api', requireSameOrigin);

app.use('/api/gate', gateRoutes);
app.use('/api/player', playerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/game', gameRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Never expose stack traces to clients.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: false }, // same-origin only
});
app.set('io', io);

const wrap = (middleware) => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

function syncRooms(socket) {
  const session = socket.request.session;
  if (!session) return;
  if (session.isAdmin) socket.join('admins');
  if (session.playerId) {
    // Team assignment can happen after this socket first connected (a roster
    // match on join) — always re-resolve from the players table rather than
    // trusting session state.
    const player = db.prepare('SELECT team_id FROM players WHERE id = ?').get(session.playerId);
    if (player && player.team_id) socket.join(`team-${player.team_id}`);
  }
}

io.on('connection', (socket) => {
  syncRooms(socket);
  socket.on('sync', () => syncRooms(socket));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Scavenger hunt server running at http://${HOST}:${PORT}`);
  console.log('Put this behind a reverse proxy (nginx/Caddy) with HTTPS — do not expose this port directly.');
  if (process.env.NODE_ENV === 'production') {
    console.log(
      'NODE_ENV=production is set, which requires real HTTPS (via your reverse proxy) to work at all — ' +
      'session cookies are marked secure and the browser/server will silently refuse to keep anyone logged in over plain HTTP. ' +
      'If you are testing locally without HTTPS yet, set NODE_ENV=development in .env instead, or the gate password will ' +
      'appear to always be "wrong" even though it is actually correct.'
    );
  }
});
