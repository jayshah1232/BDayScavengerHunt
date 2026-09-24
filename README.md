# Scavenger Hunt

Self-hosted, real-time scavenger hunt for two teams — captain drafts or auto-assigned rosters, NFC tag or photo/video check-ins, and live admin review.

## How it works

**One shared link, one game.** Everyone who opens the link joins the same session automatically — there's no "create a game" step. Not everyone has to join; the app just needs at least one person per team before you can start.

**Teams: whoever picks first, for everyone.** The first person to tap either "Draft with captains" or "Let the app assign teams" locks that choice in for the whole group — nobody can back out and pick the other option afterward.

- **Draft mode**: you name two captains ahead of time. When they join the link (by typing their name), they're automatically recognized and become captains. Everyone else lands in a pool. Captains take turns picking players onto their team, live, in the app. If a captain never shows up, you (the admin) can promote a stand-in from the pool so the draft isn't stuck.
- **Auto-assign mode**: you pre-load a roster (who goes on which team) during setup. As people join with matching names, they're placed automatically — instantly, with nothing for you to do live. If someone's name doesn't match, they get a friendly prompt to double-check their spelling and try again themselves; there's no admin placement step to worry about mid-event.

**Each team has its own separate set of locations.** Team A and Team B don't have to visit the same places, in the same order, or even the same *number* of stops — you build two independent lists on the Setup page. This also means one team can finish before the other; the hunt only fully ends once both are done.

**Hints, one team-wide step at a time.** Everyone on a team sees the same hint at the same time. The moment *any* teammate's proof is approved (or *any* teammate taps the right NFC tag), the whole team's screens update automatically — first one to finish moves everyone forward. If two teammates both submit around the same time, whichever gets approved first wins; the other becomes moot automatically so you're not stuck reviewing duplicates.

**Two ways to verify a location**, configured per-location during setup:
- **Photo/video**: a player submits proof from their phone; you approve or reject it (with a note) from the admin dashboard.
- **NFC tag**: you place a rewritable NFC sticker at the location. Tapping it opens a page that instantly checks the team in — no admin needed — and can optionally ask a short question first (auto-graded). Every NFC location also has a manual backup code players can type in the app if a tag is missing, broken, or their phone won't read it.

**Backups for when tech fails**, since this all runs on your server on event day:
- **Manual advance button**: on the admin dashboard, you can push any team to the next hint without a submission at all — useful if someone just sends their proof straight into your WhatsApp group instead of fighting a slow upload.
- **Printable hint sheet**: open `/api/admin/hint-sheet` (linked from the dashboard) on a laptop and print it before the event — every hint, backup code, and answer, in order, in case the server goes down and you need to run things manually via the group chat for a bit.

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
2. Team names and captain names (captains only matter if the group ends up choosing draft mode — set them either way)
3. An optional pre-set roster, for if the group chooses auto-assign mode instead
4. One placeholder location per team, just so the game has something valid to start with

**For the actual locations, use the web Setup page instead** — it's much faster than typing them into the terminal one field at a time. Log into `/admin`, then click **⚙️ Game Setup** on the dashboard. Each team has its own independent location list on this page — they don't need to match in count, order, or content. From there you can:
- Add, remove, and reorder each team's locations independently with buttons (no need to re-run anything from the terminal)
- Pick **Photo/video** or **NFC tag** per location with a radio button — the NFC fields (backup code, question, answer) only show up when you pick NFC
- Set an optional **elective hint** per location — see below
- Edit team names, captains, and the auto-assign roster
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

## Setting up the NFC tags

If you used any NFC locations, setup prints a URL for each one, like:

```
Secret Garden: https://YOUR-DOMAIN/checkin.html?token=old-clocktower-a1b2c3
```

Swap in your real domain, then write that exact URL onto the tag using any generic NFC-writing app (e.g. "NFC Tools" on Android/iOS) — a plain URL/NDEF record, no special format needed. When someone taps the tag, their phone opens that page, which checks their team in automatically.

A few notes:
- Rewritable tags mean you can relocate/reuse them for a future hunt — just re-run setup (which generates fresh tokens) and rewrite the tags.
- Some phones (especially iPhones without background tag reading enabled) need the tag held against the *top* of the phone for a second, not just tapped quickly. Mention this to players, and lean on the backup code for anyone whose phone won't cooperate.
- The backup code always works as a manual substitute for tapping — it's in the app on the hint screen for any NFC-type location.

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

Open `http://localhost:3000` in a few different browser profiles/incognito windows to simulate different players (try both a draft-mode run and an auto-assign run), and `http://localhost:3000/admin` in another. Set `NODE_ENV=production` only once you've got the real deployment behind HTTPS running (see Deployment above and Troubleshooting below) — cookies won't survive over plain HTTP once that's set.

Do at least one full dry run with 3-4 real people on real phones before the event — NFC tag reading in particular varies a lot by phone model, and it's much better to discover that beforehand.

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

