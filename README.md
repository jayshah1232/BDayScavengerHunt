# Scavenger Hunt

Self-hosted, real-time scavenger hunt for two teams — admin-assigned rosters, a guess-the-spot-then-do-a-task flow at each location, and live admin review.

## How it works

**One shared link, one game.** Everyone who opens the link joins the same session automatically — there's no "create a game" step. Not everyone has to join; the app just needs at least one person per team before you can start.

**Teams are entirely admin-assigned.** There's no drafting or self-picking — you build each team's roster (who's on it) on the Setup page ahead of time. As people join with matching names, they're placed onto their team automatically, instantly, with nothing for you to do live. If someone's name doesn't match the roster, they get a friendly prompt to double-check their spelling and try again themselves; there's no admin placement step to worry about mid-event.

**Each team has its own separate set of locations.** Team A and Team B don't have to visit the same places, in the same order, or even the same *number* of stops — you build two independent lists on the Setup page. This also means one team can finish before the other; the hunt only fully ends once both are done.

**Every location is guess-it-then-do-it.** Players first see a clue (e.g. "Tallest building in the city") and type in a guess for what the location is. Guesses are matched case-insensitively and ignore filler words like "the," so "CN Tower," "the CN tower," and "cn tower" all count — you can also list several accepted phrasings per location, separated by `|`. Once a team guesses correctly, the actual task appears (e.g. "Go to the base of the building and take a picture with the whole team") along with the photo/video upload — you approve or reject each submission (with a note) from the admin dashboard.

**Hints, one team-wide step at a time.** Everyone on a team sees the same clue and task at the same time. The moment *any* teammate guesses right, or *any* teammate's photo/video is approved, the whole team's screens update automatically — first one to finish moves everyone forward. If two teammates both submit around the same time, whichever gets approved first wins; the other becomes moot automatically so you're not stuck reviewing duplicates.

**Backups for when tech fails**, since this all runs on your server on event day:
- **Manual advance button**: on the admin dashboard, you can push any team straight to the next location without a guess or a submission at all — useful if someone just sends their proof straight into your WhatsApp group instead of fighting a slow upload.
- **Printable hint sheet**: open `/api/admin/hint-sheet` (linked from the dashboard) on a laptop and print it before the event — every clue, accepted guess, and task, in order, in case the server goes down and you need to run things manually via the group chat for a bit.

## Requirements

- Node.js 18+
- A server/VPS/Raspberry Pi you control, reachable from your friends' phones

If `npm start` crashes immediately with a low-level native error mentioning `better-sqlite3` or `better_sqlite3.node` (V8/GC assertion failures, segfaults), delete `node_modules` and `package-lock.json` and run `npm install` again. This happened once during development on a very new Node version (24.21.0) — `better-sqlite3` moved to N-API in its v13 line specifically to make its native binary portable across Node versions, and this project is pinned to that line or later.

## First-time setup

```bash
npm install
cp .env.example .env
```

Generate a session secret and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run the interactive bootstrap — this sets your gate question, admin password, and a minimal starting config so you can log in for the first time:

```bash
npm run setup
```

It walks you through:
1. The gate question/answer and your admin password
2. Team names and each team's roster (who's on it — this is the only way players end up on a team)
3. One placeholder location per team, just so the game has something valid to start with

**For the actual locations, use the web Setup page instead** — it's much faster than typing them into the terminal one field at a time. Log into `/admin`, then click **⚙️ Game Setup** on the dashboard. Each team has its own independent location list on this page — they don't need to match in count, order, or content. From there you can:

If you already know your full location list (names and order) but haven't written the clues/tasks yet, `npm run seed-locations` will pre-load `scripts/seed-locations.js`'s two lists — names and accepted guesses only — so you can fill in just the hint and task text on the Setup page afterward. Edit that file's two arrays to change the lists; it always requires the two teams to already exist (`npm run setup`) and replaces every location, so only run it before you've built out real hints/tasks.

- Add, remove, and reorder each team's locations independently with buttons (no need to re-run anything from the terminal)
- Set the location's name, the clue shown before guessing, the accepted guess(es), and the task shown once they guess right — see below
- Set an optional **elective hint** per location — see below
- Edit team names and the roster
- Update the gate question/answer or admin password any time (leave a field blank to keep it unchanged)
- **Reset Game** — clears all players and progress for a fresh test run, without touching your locations or settings

Setup is locked once the hunt has started — hit **Reset Game** first if you need to make changes mid-testing.

Start the app:

```bash
npm start
```

By default it listens on `127.0.0.1:3000` only — see deployment below to actually expose it.

## The elective hint system

Any location can have one optional extra hint, set in the Setup page. If a team gets stuck, they'll see a "Need an extra hint?" button — tapping it reveals the hint immediately (no admin involved) and is recorded permanently for that team at that location. It only counts once per team per location, no matter how many times they look back at it.

You'll see a running hint count per team on the dashboard, and the full breakdown (which locations, how many total) shows up in each team's post-game recap — useful if you want to factor "did they need help" into however you end up deciding a winner beyond just finish time.

## Deployment & security

The app never talks to the internet directly. It binds to `127.0.0.1`, and a reverse proxy (nginx or Caddy) — the one you already run — terminates HTTPS and forwards requests to it:

- Bad actors on the internet reach the proxy, not the app or the OS.
- The app only ever reads/writes its own `data/` (SQLite) and `uploads/` folders.
- Run it as its own non-root Linux user with no other permissions, as an extra layer.

### Nginx reverse proxy example

```nginx
server {
    listen 443 ssl http2;
    server_name hunt.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/hunt.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hunt.yourdomain.com/privkey.pem;

    client_max_body_size 80m; # allow phone video uploads — match MAX_UPLOAD_MB in .env

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # needed for Socket.io
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Get a free cert with `certbot --nginx -d hunt.yourdomain.com`.

### Run it as a service (systemd)

```ini
# /etc/systemd/system/scavenger-hunt.service
[Unit]
Description=Scavenger Hunt
After=network.target

[Service]
Type=simple
User=huntapp
WorkingDirectory=/opt/scavenger-hunt
EnvironmentFile=/opt/scavenger-hunt/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/scavenger-hunt/data /opt/scavenger-hunt/uploads
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin huntapp
sudo cp -r . /opt/scavenger-hunt
sudo chown -R huntapp:huntapp /opt/scavenger-hunt
sudo systemctl enable --now scavenger-hunt
```

### Firewall

```bash
sudo ufw allow 80,443/tcp
sudo ufw deny 3000/tcp
```

### What's already built in, application-side

- Gate answer and admin password are bcrypt-hashed, never stored in plaintext.
- Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production (HTTPS-only).
- Rate limiting on the gate and admin login, so someone can't brute-force either secret.
- Uploaded photos/videos are verified server-side by inspecting the actual file bytes (not the filename or browser-reported type), given a random filename, and stored outside any web-executable path — visible only to admins via an authenticated route.
- Content-Security-Policy via Helmet blocks inline scripts and unapproved resource origins.
- A same-origin check rejects any state-changing request that didn't come from the app's own front end.

### A note on the gate question

It's a convenience filter, not real authentication. Don't post the link publicly, and keep the admin password different from the gate answer — the admin password is the secret that actually matters.

## Running the game

- Players go to `https://hunt.yourdomain.com/` — this is also the link you drop in the group chat to kick things off.
- You go to `https://hunt.yourdomain.com/admin` — same gate question, then your separate admin password.
- Two admins can be logged in at once (e.g. two phones); both see the same live queue.
- Once each team has at least one player, the dashboard's "Start the hunt" button lights up. Nothing shows hints until you press it — take your time getting teams sorted first.

### Mid-game admin tasks not covered by the dashboard UI

Rare edge cases you can fix by editing the database directly (`sqlite3 data/hunt.sqlite` or DB Browser for SQLite) rather than a UI, since they should come up rarely:

- **Move a player to the other team after the game has started**: `UPDATE players SET team_id = <id> WHERE name = '...';`
- **Rewind a team** (e.g. you approved something by mistake): `UPDATE teams SET current_stage = <n> WHERE name = '...';`
- **Add a location mid-game**: insert into `locations` with a `stage_order` greater than any existing one.

## Local testing before the event

```bash
npm install
cp .env.example .env   # fill in SESSION_SECRET; ships with NODE_ENV=development, correct for local testing
npm run setup
npm start
```

Open `http://localhost:3000` in a few different browser profiles/incognito windows to simulate different players (make sure their names match the roster you set up), and `http://localhost:3000/admin` in another. Set `NODE_ENV=production` only once you've got the real deployment behind HTTPS running (see Deployment above and Troubleshooting below) — cookies won't survive over plain HTTP once that's set.

Do at least one full dry run with 3-4 real people on real phones before the event — it's much better to catch any confusing clues or fussy guess-matching beforehand.

## Troubleshooting

### I forgot the admin password

```bash
npm run reset-admin-password
```

This only changes the admin password — it leaves your teams, locations, gate question, and any in-progress game completely untouched, and works even while the server is already running (no restart needed). Don't use `npm run setup` for this — that resets your teams and locations too.

### Re-running `npm run setup` fails with a "FOREIGN KEY constraint failed" error

Fixed as of this version — if you're still seeing this, you're on an older copy of the script. Re-running setup wipes and recreates your teams and locations, which requires clearing everything that references them (players, submissions, hint usage, activity history) first, in the right order. Re-running setup is always safe now, at any point, including after a full test run.

### "The gate password / admin password is always wrong, even though I'm sure it's right"

This is almost always **not actually a wrong password** — it's `NODE_ENV=production` set while testing over plain HTTP (no reverse proxy/HTTPS yet). Here's what's actually happening:

- `NODE_ENV=production` marks the login session cookie as HTTPS-only.
- Over plain HTTP, the server accepts your password correctly, but the cookie that would keep you logged in never actually gets saved.
- The very next request looks like you were never logged in at all — which the app can't tell apart from "wrong password," so you just get bounced back to the same screen with no explanation.

**Fix**: open `.env` and set `NODE_ENV=development` while you're testing without HTTPS. Switch it to `NODE_ENV=production` only once you have your real domain and reverse proxy (see Deployment above) actually running — that's the point at which secure cookies are supposed to kick in.

You can always confirm the password itself is stored and correct, independent of this cookie issue, by checking the hash directly:

```bash
sqlite3 data/hunt.sqlite "select key, value from settings where key like '%hash';"
```

You'll see `gate_answer_hash` and `admin_password_hash` — both bcrypt hashes (never plaintext). If you want to confirm a specific guess matches:

```bash
node -e "console.log(require('bcryptjs').compareSync('your guess here', 'PASTE_THE_HASH_HERE'))"
```

