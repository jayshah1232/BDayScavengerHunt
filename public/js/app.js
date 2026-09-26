(() => {
  const $ = (id) => document.getElementById(id);
  const ALL_SCREENS = [
    'screen-gate', 'screen-join',
    'screen-waiting-room', 'screen-ready', 'screen-leaderboard', 'screen-game', 'screen-recap',
  ];
  function showOnly(id) {
    ALL_SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
    // The slang/English tooltip only ever makes its first appearance on the
    // waiting-room screen (players have a moment of downtime there) — fade
    // it in once, and keep it out of the way everywhere else.
    if (id === 'screen-waiting-room') {
      maybeFadeInTooltip();
    } else {
      $('lang-tooltip').classList.remove('visible');
      $('lang-tooltip').classList.add('hidden');
    }
  }

  // ---- Toronto slang / overly-formal English toggle ----
  let englishMode = false;
  try { englishMode = localStorage.getItem('englishMode') === '1'; } catch (e) { /* ignore */ }

  // Pick the right string for the current mode. `formal` is optional — if a
  // spot in the app doesn't have (or need) a formal counterpart, this just
  // falls back to the slang version so nothing ever renders blank.
  function t(slang, formal) {
    return englishMode && formal ? formal : slang;
  }

  // Static copy that never gets reassigned dynamically — toggled in place by
  // id. Dynamic strings (built with runtime data) are handled inline at the
  // point they're rendered, using t() directly.
  const STATIC_TEXT = {
    'gate-h2': ['Ayyy saying mans are here to celebrate more life', 'Greetings — it appears we are gathered here today to celebrate an additional year of life.'],
    'gate-subtext': ["You got me cheesin where ever I am, styll. But you gotta prove you actually with the gang.", 'I find myself smiling regardless of my present whereabouts. However, you must first demonstrate that you are, in fact, a genuine member of our party.'],
    'gate-submit': ["Let's go", 'Kindly Proceed'],
    'join-h2': ['Ayo whose mans r u?', 'Greetings — might I inquire as to your identity?'],
    'join-subtext': ['Yo fam, tell me ur name, dawg. Mans are tryna get to knoe u styll.', 'My good friend, please do share your given name with me. We are rather eager to become acquainted with you.'],
    'join-empty-note': ["Looks like everyone's already checked in. If that's not you, holla at the admin.", 'It appears that everyone has already checked in. Should this not pertain to you, kindly contact the event administrator.'],
    'wr-hang-tight': ['Aight now hold up, fam. Game gonna start when the big boss starts it.', 'Please do remain patient. The game shall commence at such time as the event organizer deems appropriate.'],
    'wr-leaderboard-link': ['Peep the standings', 'View the Standings'],
    'wr-switch-player-link': ['Not you? Switch player', 'Not Yourself? Kindly Switch Players'],
    'team-name-submit': ['Save it', 'Kindly Save'],
    'leaderboard-h2': ['Standings', 'Current Standings'],
    'leaderboard-back': ['Back', 'Return'],
    'game-leaderboard-link': ['Peep the standings', 'View the Standings'],
    'extra-hint-btn': ['Stuck? Grab a hint', 'Experiencing Difficulty? Kindly Request Additional Assistance'],
    'guess-label': ['Where you think this is, fam?', "Might I inquire as to your assessment of this location's identity?"],
    'guess-submit': ['Lock it in', 'Confirm Selection'],
    'whatsapp-note-1': ['Upload being mad slow? Fire it into the WhatsApp group instead and get an admin to push you through.', 'Should your upload prove excessively slow, kindly forward it to the WhatsApp group instead, and request that an administrator advance you manually.'],
    'whatsapp-note-2': ['Upload being mad slow? Fire it into the WhatsApp group instead and get an admin to push you through.', 'Should your upload prove excessively slow, kindly forward it to the WhatsApp group instead, and request that an administrator advance you manually.'],
    'gate-loc-name': ['HOLD UP', 'PLEASE WAIT'],
    'gate-hint-text': ['Ah Ah We Aint Done Yet', 'We Are Not Yet Finished'],
    'gate-subtext-2': ['Ayyy mans figured it all out. Sayin mans are big brain, ahlie. But the game aint done yet...', 'Congratulations are in order — you have solved every challenge thus far, demonstrating considerable intellect. The game has not yet concluded, however...'],
    'final-loc-name': ['BONUS ROUND', 'SUPPLEMENTARY ROUND'],
    'final-hint-text': ['FIND ME YUH EEDIYATS', 'Kindly Locate Me, You Wonderful Individuals'],
    'recap-media-h3': ['Pics & vids', 'Photographs and Videos'],
    'ready-h2': ["Y'all Ready Or Nah?", 'Might I Inquire Whether Everyone Is Prepared?'],
    'ready-subtext': ["Hit the button when you're set. Once everyone's locked in, we go in 3.", 'Kindly press the button once you are prepared. Once every participant has done so, we shall commence in three seconds.'],
    'ready-btn': ["I'm Ready!", 'I Am Prepared'],
  };

  function applyStaticText() {
    Object.entries(STATIC_TEXT).forEach(([id, [slang, formal]]) => {
      const el = $(id);
      if (el) el.textContent = t(slang, formal);
    });
    $('lang-toggle-btn').textContent = englishMode ? '🧢' : '🧐';
    $('lang-toggle-btn').setAttribute('aria-label', englishMode ? 'Switch back to slang' : 'Translate to English');
    $('lang-tooltip-text').textContent = englishMode
      ? "In the event that the Queen's English proves indecipherable, tap here to convert the text into dirty street speak, you simpleton."
      : "Two twos mans can't pree what the yute's sayin? Tap dis to run proper English, beanaz. Top left real talk.";
  }

  // Persistent team-name badge in the masthead, visible from the moment a
  // player is placed on a team through to the recap at the end.
  function setTeamBadge(name) {
    const el = $('team-badge');
    if (name) {
      el.textContent = name;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  // The tooltip explaining the corner button — only ever appears once, on
  // the waiting-room screen (see showOnly()), faded in rather than popping
  // up abruptly, and remembered per-browser so it doesn't nag on every visit.
  let langTooltipDismissed = false;
  try { langTooltipDismissed = localStorage.getItem('langTooltipDismissed') === '1'; } catch (e) { /* ignore */ }
  let tooltipTriggered = false;

  function maybeFadeInTooltip() {
    if (langTooltipDismissed || tooltipTriggered) return;
    tooltipTriggered = true;
    const el = $('lang-tooltip');
    el.classList.remove('hidden');
    // Two rAFs so the browser paints the pre-transition (opacity: 0) state
    // before we add the class that animates it in — otherwise it can just
    // pop straight to visible with no fade.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
  }

  $('lang-tooltip-close').addEventListener('click', () => {
    langTooltipDismissed = true;
    try { localStorage.setItem('langTooltipDismissed', '1'); } catch (e) { /* ignore */ }
    $('lang-tooltip').classList.remove('visible');
    $('lang-tooltip').classList.add('hidden');
  });

  // Photo-picker placeholder text is shared by both the regular and final
  // submit flows, and gets reset by resetPhotoPicker()/resetFinalPhotoPicker()
  // — keep it in one place so both stay in sync with the toggle.
  function pickerPlaceholder() {
    return t('Tap to snap or grab a pic/video', 'Kindly Tap to Capture or Select a Photograph or Video');
  }

  $('lang-toggle-btn').addEventListener('click', () => {
    englishMode = !englishMode;
    try { localStorage.setItem('englishMode', englishMode ? '1' : '0'); } catch (e) { /* ignore */ }
    applyStaticText();
    refreshCurrentScreenText();
  });

  // Re-render whichever screen(s) we have cached data for, from that cache —
  // no network round-trip needed just to flip the language.
  function refreshCurrentScreenText() {
    if (lastGameState) renderGame(lastGameState);
    if (lastRecapData) renderRecap(lastRecapData);
    if (lastLeaderboardData) renderLeaderboardList(lastLeaderboardData);
    if (lastReadyState) renderReadyScreen(lastReadyState);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.isForm ? { 'X-Requested-With': 'scavenger-hunt-app' } : {
        'Content-Type': 'application/json',
        'X-Requested-With': 'scavenger-hunt-app',
      },
      body: opts.body,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { data, status: res.status });
    return data;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  let socket = null;
  function connectSocket() {
    if (socket) return;
    socket = io({ path: '/socket.io' });
    socket.on('game-state-changed', resolveScreen);
    socket.on('state-changed', () => {
      if (!$('screen-game').classList.contains('hidden')) loadGameState();
      else resolveScreen();
    });
  }
  function syncSocket() {
    if (socket && socket.connected) socket.emit('sync');
  }

  // ---- GATE ----
  async function initGate() {
    applyStaticText();
    try {
      const q = await api('/api/gate/question');
      $('game-title').textContent = q.gameTitle;
      $('gate-question').textContent = q.question;
      if (q.passed) return resolveScreen();
      showOnly('screen-gate');
    } catch (e) {
      showOnly('screen-gate');
    }
  }

  $('gate-submit').addEventListener('click', async () => {
    $('gate-error').classList.add('hidden');
    const answer = $('gate-answer').value;
    if (!answer.trim()) return;
    try {
      await api('/api/gate/verify', { method: 'POST', body: JSON.stringify({ answer }) });
      resolveScreen();
    } catch (e) {
      $('gate-error').textContent = e.data?.error === 'too_many_attempts'
        ? t('Whoa, slow down — too many tries. Chill for a sec and try again.', 'Please do slow down — you have made too many attempts. Kindly wait a moment and try again.')
        : t("Nah, that's not it — try again.", 'Regrettably, that is incorrect. Kindly try again.');
      $('gate-error').classList.remove('hidden');
    }
  });

  // ---- JOIN (pick your name from everyone who hasn't checked in yet) ----
  async function showJoinScreen() {
    // Clear any leftover team-name-page state so a later visit to the
    // waiting room re-populates fresh instead of keeping a stale value.
    $('team-name-input').value = '';
    $('team-name-status').classList.add('hidden');
    setTeamBadge(null);
    showOnly('screen-join');
    await loadJoinNames();
  }

  async function loadJoinNames() {
    try {
      const data = await api('/api/player/roster-names');
      const select = $('player-name-select');
      select.innerHTML = '';
      if (!data.available.length) {
        $('join-empty-note').classList.remove('hidden');
        select.classList.add('hidden');
        $('join-submit').disabled = true;
      } else {
        $('join-empty-note').classList.add('hidden');
        select.classList.remove('hidden');
        $('join-submit').disabled = false;
        data.available.forEach((n) => {
          const opt = document.createElement('option');
          opt.value = n;
          opt.textContent = n;
          select.appendChild(opt);
        });
      }
    } catch (e) {
      if (e.data?.error === 'gate_required') return; // gate screen will handle this
      $('join-empty-note').classList.add('hidden');
      $('player-name-select').classList.add('hidden');
      $('join-submit').disabled = true;
      $('join-error').textContent = t(
        `Couldn't load the name list (${e.data?.error || e.message || 'unknown error'}) — try refreshing.`,
        `Regrettably, the name list could not be loaded (${e.data?.error || e.message || 'unknown error'}) — kindly refresh the page.`
      );
      $('join-error').classList.remove('hidden');
    }
  }

  $('join-submit').addEventListener('click', async () => {
    $('join-error').classList.add('hidden');
    const name = $('player-name-select').value;
    if (!name) {
      $('join-error').textContent = t('Pick a name first.', 'Kindly select a name first.');
      $('join-error').classList.remove('hidden');
      return;
    }
    try {
      await api('/api/player/join', { method: 'POST', body: JSON.stringify({ name }) });
      resolveScreen();
    } catch (e) {
      if (e.data?.error === 'name_taken') {
        $('join-error').textContent = t("Someone already grabbed that name — here's the updated list.", 'Regrettably, another individual has already claimed that name — kindly consult the updated list.');
        $('join-error').classList.remove('hidden');
        loadJoinNames();
      } else {
        $('join-error').textContent = t('Something glitched — try again.', 'An error has occurred — kindly try again.');
        $('join-error').classList.remove('hidden');
      }
    }
  });

  let cachedLeaderboardEnabled = false;

  // ---- Master screen resolver — call after any state-changing action ----
  async function resolveScreen() {
    let gs;
    try {
      gs = await api('/api/game/state');
    } catch (e) {
      if (e.data?.error === 'gate_required') return showOnly('screen-gate');
      return showJoinScreen();
    }
    connectSocket();
    syncSocket();
    $('game-title').textContent = gs.gameTitle;
    cachedLeaderboardEnabled = !!gs.leaderboardEnabled;

    if (!gs.me) return showJoinScreen();

    // No team — shouldn't normally happen since the join dropdown only offers
    // roster names, but fall back to picking a name again just in case.
    if (!gs.team) return showJoinScreen();

    setTeamBadge(gs.team.name);

    if (gs.gamePhase === 'ended') return loadRecap();
    if (gs.gamePhase === 'ready') return renderReadyScreen(gs);
    if (gs.gamePhase === 'active') {
      showOnly('screen-game');
      return loadGameState();
    }

    $('wr-h2').innerHTML = `${t('Wagwan', 'Greetings')}, <span id="wr-player-name">${escapeHtml(gs.me.name)}</span>!`;
    $('wr-locked-in-text').innerHTML = `${t("You're locked in with", 'You have been securely assigned to')} <strong id="wr-team-name">${escapeHtml(gs.team.name)}</strong>.`;
    $('wr-roster').textContent = `${t('Roster so far', 'Current Roster')}: ${gs.team.members.map((m) => m.name).join(', ')}`;
    // Don't touch the input value or the "Saved!" status here — this runs
    // again the instant our own rename-team save broadcasts, which would
    // otherwise wipe out the save confirmation before anyone sees it.
    if (!$('team-name-input').value) $('team-name-input').value = gs.team.name;
    $('wr-leaderboard-link').classList.toggle('hidden', !cachedLeaderboardEnabled);
    return showOnly('screen-waiting-room');
  }

  // ---- GAME (guess the spot, then complete the task, then the gate, then the bonus round) ----
  let selectedFile = null;
  let finalSelectedFile = null;
  let gateCountdownTimer = null;
  let readyCountdownTimer = null;
  let lastGameState = null;
  let lastRecapData = null;
  let lastLeaderboardData = null;
  let lastReadyState = null;

  // ---- READY UP: shown once the admin starts the hunt, until everyone's
  // hit ready and the short countdown finishes. ----
  function renderReadyScreen(gs) {
    lastReadyState = gs;
    showOnly('screen-ready');
    clearInterval(readyCountdownTimer);

    const r = gs.ready;
    const btn = $('ready-btn');
    const statusArea = $('ready-status-area');
    statusArea.innerHTML = '';
    btn.classList.toggle('hidden', r.isReady);
    btn.disabled = false;

    if (r.countdownEndsAt) {
      const pill = document.createElement('div');
      pill.className = 'status-pill status-pending';
      statusArea.appendChild(pill);
      const tick = () => {
        const remainingMs = r.countdownEndsAt - Date.now();
        const secs = Math.max(0, Math.ceil(remainingMs / 1000));
        pill.textContent = t(`Starting in ${secs}...`, `Commencing in ${secs}...`);
        if (remainingMs <= 0) clearInterval(readyCountdownTimer);
      };
      tick();
      readyCountdownTimer = setInterval(tick, 250);
    } else if (r.isReady) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = r.notReady.length
        ? t(`Aight bet, you're locked in. Still waitin on: ${r.notReady.join(', ')}`, `Splendid — you are prepared. We continue to await: ${r.notReady.join(', ')}`)
        : t("Aight bet, you're locked in.", 'Splendid — you are prepared.');
      statusArea.appendChild(p);
    } else {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = t(`${r.readyCount} of ${r.totalToReady} ready so far.`, `${r.readyCount} of ${r.totalToReady} participants are currently prepared.`);
      statusArea.appendChild(p);
    }
  }

  $('ready-btn').addEventListener('click', async () => {
    $('ready-btn').disabled = true;
    try {
      await api('/api/game/ready', { method: 'POST' });
      resolveScreen();
    } catch (e) {
      $('ready-btn').disabled = false;
    }
  });

  async function loadGameState() {
    const state = await api('/api/player/state');
    lastGameState = state;
    renderGame(state);
  }

  // Rendered into any status-area for a rejection — loud on purpose (item 2:
  // players need to actually notice, not just see a muted grey pill).
  function rejectedAlertHtml(note) {
    const shown = note ? escapeHtml(note) : t('No reason given', 'No justification was provided');
    if (navigator.vibrate) navigator.vibrate([120, 60, 120, 60, 200]);
    return `<div class="rejected-alert">
      <span class="rejected-emoji">🚫</span>
      <div class="rejected-title">${t('NAH FAM, REJECTED', 'Regrettably, Declined')}</div>
      <div class="rejected-note">${shown}. ${t('Run it back!', 'Kindly attempt this once more.')}</div>
    </div>`;
  }

  function pendingStatusHtml(count) {
    return `<div class="status-pill status-pending">${t(
      `${count} submission${count > 1 ? 's' : ''} waiting on admin review…`,
      `${count} submission${count > 1 ? 's are' : ' is'} presently awaiting administrative review.`
    )}</div>`;
  }

  function renderGame(state) {
    lastGameState = state;
    $('game-title').textContent = state.gameTitle;
    setTeamBadge(state.team ? state.team.name : null);
    $('game-leaderboard-link').classList.toggle('hidden', !cachedLeaderboardEnabled);
    clearInterval(gateCountdownTimer);

    const trail = $('trail');
    trail.innerHTML = '';
    for (let i = 0; i < state.total; i++) {
      const dot = document.createElement('div');
      dot.className = 'dot' + (i < state.progress ? ' done' : i === state.progress ? ' current' : '');
      trail.appendChild(dot);
    }
    $('trail-label').textContent = t(
      `${Math.min(state.progress, state.total)} of ${state.total} bagged`,
      `${Math.min(state.progress, state.total)} of ${state.total} Locations Completed`
    );

    $('guess-area').classList.add('hidden');
    $('task-area').classList.add('hidden');
    $('gate-area').classList.add('hidden');
    $('final-area').classList.add('hidden');
    $('extra-hint-area').classList.add('hidden');

    if (state.phase === 'gate') return renderGate(state);
    if (state.phase === 'final') return renderFinal(state);

    // 'guessing' or 'task'
    $('loc-name').textContent = t(`SPOT ${state.progress + 1} OF ${state.total}`, `LOCATION ${state.progress + 1} OF ${state.total}`);
    $('hint-text').textContent = t(state.location.hint, state.location.hintEn);

    if (state.location.hasExtraHint) {
      $('extra-hint-area').classList.remove('hidden');
      if (state.location.extraHint) {
        $('extra-hint-btn').classList.add('hidden');
        $('extra-hint-text').textContent = `💡 ${t(state.location.extraHint, state.location.extraHintEn)}`;
        $('extra-hint-text').classList.remove('hidden');
      } else {
        $('extra-hint-btn').classList.remove('hidden');
        $('extra-hint-text').classList.add('hidden');
      }
    }

    const guessing = state.phase === 'guessing';
    $('guess-area').classList.toggle('hidden', !guessing);
    $('task-area').classList.toggle('hidden', guessing);

    if (guessing) {
      $('guess-input').value = '';
      $('guess-error').classList.add('hidden');
      return;
    }

    $('task-loc-name').textContent = t(`YOU FOUND IT: ${state.location.name}`, `You Have Successfully Located: ${state.location.name}`);
    $('task-text').textContent = t(state.location.task, state.location.taskEn);

    const statusArea = $('status-area');
    statusArea.innerHTML = '';
    if (state.pendingCount > 0) {
      statusArea.innerHTML = pendingStatusHtml(state.pendingCount);
    } else if (state.lastRejectedNote !== null) {
      statusArea.innerHTML = rejectedAlertHtml(state.lastRejectedNote);
    }

    resetPhotoPicker();
    $('submit-btn').textContent = state.pendingCount > 0
      ? t('Send another attempt', 'Submit Another Attempt')
      : t('Send it in', 'Submit for Review');
  }

  // ---- GATE: "Ah Ah We Aint Done Yet" — locked for GATE_WAIT_SECONDS after
  // finishing the regular locations, timed against the server's own
  // timestamp so a refresh resumes the countdown instead of restarting it. ----
  function renderGate(state) {
    $('gate-area').classList.remove('hidden');
    const btn = $('gate-continue-btn');

    function tick() {
      const remainingMs = (state.gateReadyAt || 0) - Date.now();
      if (remainingMs <= 0) {
        clearInterval(gateCountdownTimer);
        btn.disabled = false;
        btn.textContent = t('Continue', 'Proceed');
        return;
      }
      btn.disabled = true;
      btn.textContent = t(`Continue (${Math.ceil(remainingMs / 1000)})`, `Proceed (${Math.ceil(remainingMs / 1000)})`);
    }

    tick();
    gateCountdownTimer = setInterval(tick, 250);
  }

  $('gate-continue-btn').addEventListener('click', async () => {
    $('gate-continue-btn').disabled = true;
    try {
      await api('/api/game/continue-to-final', { method: 'POST' });
      await loadGameState();
    } catch (e) {
      await loadGameState(); // timer wasn't actually up yet — re-render to resync the countdown
    }
  });

  // ---- FINAL: the "FIND ME YUH EEDIYATS" bonus round ----
  function renderFinal(state) {
    $('final-area').classList.remove('hidden');
    const statusArea = $('final-status-area');
    statusArea.innerHTML = '';
    if (state.pendingCount > 0) {
      statusArea.innerHTML = pendingStatusHtml(state.pendingCount);
    } else if (state.lastRejectedNote !== null) {
      statusArea.innerHTML = rejectedAlertHtml(state.lastRejectedNote);
    }
    resetFinalPhotoPicker();
    $('final-submit-btn').textContent = state.pendingCount > 0
      ? t('Send another attempt', 'Submit Another Attempt')
      : t('Send it in', 'Submit for Review');
  }

  // ---- GUESSING ----
  $('guess-submit').addEventListener('click', async () => {
    $('guess-error').classList.add('hidden');
    const guess = $('guess-input').value.trim();
    if (!guess) return;
    $('guess-submit').disabled = true;
    try {
      await api('/api/game/guess', { method: 'POST', body: JSON.stringify({ guess }) });
      await loadGameState();
    } catch (e) {
      $('guess-error').textContent = t('Nah, not it — run it back.', 'Regrettably, that is incorrect. Kindly attempt this once more.');
      $('guess-error').classList.remove('hidden');
    } finally {
      $('guess-submit').disabled = false;
    }
  });

  function resetPhotoPicker() {
    selectedFile = null;
    $('photo-input').value = '';
    $('photo-preview').classList.add('hidden');
    $('photo-picker-text').textContent = pickerPlaceholder();
    $('submit-btn').disabled = true;
    $('submit-error').classList.add('hidden');
  }

  $('photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    selectedFile = file;
    $('photo-picker-text').textContent = file.name;
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        $('photo-preview').src = ev.target.result;
        $('photo-preview').classList.remove('hidden');
      };
      reader.readAsDataURL(file);
    } else {
      $('photo-preview').classList.add('hidden');
    }
    $('submit-btn').disabled = false;
  });

  $('submit-btn').addEventListener('click', async () => {
    if (!selectedFile) return;
    $('submit-error').classList.add('hidden');
    $('submit-btn').disabled = true;
    const originalLabel = $('submit-btn').textContent;
    $('submit-btn').textContent = t('Sending…', 'Transmitting…');
    try {
      const form = new FormData();
      form.append('media', selectedFile);
      await api('/api/player/submit', { method: 'POST', body: form, isForm: true });
      await loadGameState();
    } catch (e) {
      $('submit-error').textContent = e.data?.error === 'invalid_media'
        ? t("That's not a pic or video, bud — try again.", 'Regrettably, that file is neither a photograph nor a video — kindly try again.')
        : t("Didn't go through — try again.", 'The submission did not go through — kindly try again.');
      $('submit-error').classList.remove('hidden');
      $('submit-btn').disabled = false;
      $('submit-btn').textContent = originalLabel;
    }
  });

  // ---- FINAL ROUND photo picker — same pattern as the regular one, posting
  // to /api/player/submit-final instead. ----
  function resetFinalPhotoPicker() {
    finalSelectedFile = null;
    $('final-photo-input').value = '';
    $('final-photo-preview').classList.add('hidden');
    $('final-photo-picker-text').textContent = pickerPlaceholder();
    $('final-submit-btn').disabled = true;
    $('final-submit-error').classList.add('hidden');
  }

  $('final-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    finalSelectedFile = file;
    $('final-photo-picker-text').textContent = file.name;
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        $('final-photo-preview').src = ev.target.result;
        $('final-photo-preview').classList.remove('hidden');
      };
      reader.readAsDataURL(file);
    } else {
      $('final-photo-preview').classList.add('hidden');
    }
    $('final-submit-btn').disabled = false;
  });

  $('final-submit-btn').addEventListener('click', async () => {
    if (!finalSelectedFile) return;
    $('final-submit-error').classList.add('hidden');
    $('final-submit-btn').disabled = true;
    const originalLabel = $('final-submit-btn').textContent;
    $('final-submit-btn').textContent = t('Sending…', 'Transmitting…');
    try {
      const form = new FormData();
      form.append('media', finalSelectedFile);
      await api('/api/player/submit-final', { method: 'POST', body: form, isForm: true });
      await loadGameState();
    } catch (e) {
      $('final-submit-error').textContent = e.data?.error === 'invalid_media'
        ? t("That's not a pic or video, bud — try again.", 'Regrettably, that file is neither a photograph nor a video — kindly try again.')
        : t("Didn't go through — try again.", 'The submission did not go through — kindly try again.');
      $('final-submit-error').classList.remove('hidden');
      $('final-submit-btn').disabled = false;
      $('final-submit-btn').textContent = originalLabel;
    }
  });

  // ---- WRONG PLAYER PICKED: free up the name and go back to the dropdown ----
  $('wr-switch-player-link').addEventListener('click', async () => {
    const ok = await modalConfirm(t("Switch to a different name? This'll free up your current name for someone else to grab.", 'Would you care to switch to a different name? Doing so shall release your current name for another individual to claim.'));
    if (!ok) return;
    try {
      await api('/api/player/switch', { method: 'POST' });
      resolveScreen();
    } catch (e) {
      await modalAlert(t("Couldn't switch — try again.", 'Regrettably, the switch could not be completed — kindly try again.'));
    }
  });

  // ---- TEAM NAMING (waiting room, open until the hunt starts) ----
  let teamNameStatusTimer = null;
  $('team-name-submit').addEventListener('click', async () => {
    $('team-name-error').classList.add('hidden');
    $('team-name-status').classList.add('hidden');
    const name = $('team-name-input').value.trim();
    if (!name) return;
    try {
      await api('/api/game/rename-team', { method: 'POST', body: JSON.stringify({ name }) });
      $('wr-team-name').textContent = name;
      $('team-name-status').textContent = t('✅ Saved!', '✅ Successfully Saved');
      $('team-name-status').classList.remove('hidden');
      clearTimeout(teamNameStatusTimer);
      teamNameStatusTimer = setTimeout(() => $('team-name-status').classList.add('hidden'), 3000);
    } catch (e) {
      $('team-name-error').textContent = e.data?.error === 'hunt_already_started'
        ? t("Hunt's already poppin' off — team names are locked now.", 'The hunt has already commenced — team names are presently locked.')
        : t("Didn't save — try again.", 'Regrettably, this could not be saved — kindly try again.');
      $('team-name-error').classList.remove('hidden');
    }
  });

  // ---- OPT-IN LEADERBOARD ----
  function renderLeaderboardList(data) {
    lastLeaderboardData = data;
    const list = $('leaderboard-list');
    list.innerHTML = '';
    data.teams.forEach((team) => {
      const div = document.createElement('div');
      div.className = 'admin-team-card';
      div.innerHTML = `<div class="row"><h3>${escapeHtml(team.name)}</h3><span class="muted">${t(
        `${team.progress} of ${team.total} found`,
        `${team.progress} of ${team.total} Located`
      )}</span></div>`;
      list.appendChild(div);
    });
  }

  async function loadLeaderboard() {
    try {
      const data = await api('/api/game/leaderboard');
      renderLeaderboardList(data);
      showOnly('screen-leaderboard');
    } catch (e) {
      resolveScreen();
    }
  }
  $('wr-leaderboard-link').addEventListener('click', loadLeaderboard);
  $('game-leaderboard-link').addEventListener('click', loadLeaderboard);
  $('leaderboard-back').addEventListener('click', resolveScreen);

  // ---- POST-GAME RECAP ----
  function formatDuration(seconds) {
    if (seconds == null) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function renderRecap(data) {
    lastRecapData = data;
    setTeamBadge(data.teamName);
    $('recap-title').textContent = data.isWinner
      ? t('Jeeeezz! Big up to the winners', 'Congratulations Are Most Certainly in Order for the Victorious Team')
      : t(`Ah, ${data.winningTeamName || 'the other squad'} found the host first!`, `Regrettably, ${data.winningTeamName || 'the opposing team'} Located the Host First`);

    const others = data.allTeamFinishes.filter((tm) => tm.name !== data.teamName);
    const finishedOthers = others.filter((tm) => tm.finishedRegular && tm.totalSeconds != null);
    let summary = data.totalSeconds != null
      ? t(
        `${data.teamName} wrapped up their locations in ${formatDuration(data.totalSeconds)}, popping ${data.hintsUsed} extra hint${data.hintsUsed === 1 ? '' : 's'} along the way.`,
        `${data.teamName} completed their locations in a duration of ${formatDuration(data.totalSeconds)}, having availed themselves of ${data.hintsUsed} supplementary hint${data.hintsUsed === 1 ? '' : 's'} along the way.`
      )
      : t(
        `${data.teamName} didn't finish their locations before the hunt ended, popping ${data.hintsUsed} extra hint${data.hintsUsed === 1 ? '' : 's'} along the way.`,
        `${data.teamName} regrettably did not complete their locations prior to the conclusion of the hunt, having availed themselves of ${data.hintsUsed} supplementary hint${data.hintsUsed === 1 ? '' : 's'} along the way.`
      );
    if (finishedOthers.length && data.totalSeconds != null) {
      const diffs = finishedOthers.map((tm) => `${tm.name} ${t('in', 'in a duration of')} ${formatDuration(tm.totalSeconds)} (${tm.hintsUsed} hint${tm.hintsUsed === 1 ? '' : 's'})`);
      summary += ` (${diffs.join(', ')})`;
    }
    $('recap-summary').textContent = summary;

    const splitsEl = $('recap-splits');
    splitsEl.innerHTML = '';
    data.splits.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'submission-meta';
      row.textContent = `${s.locationName} — ${formatDuration(s.seconds)}${s.hintUsed ? ' 💡' : ''}`;
      splitsEl.appendChild(row);
    });

    const mediaEl = $('recap-media');
    mediaEl.innerHTML = '';
    const allMedia = [
      ...data.media.map((m) => ({ ...m, src: `/api/player/media/${m.id}` })),
      ...data.finalMedia.map((m) => ({ ...m, src: `/api/player/final-media/${m.id}` })),
    ];
    if (!allMedia.length) {
      mediaEl.innerHTML = `<p class="muted">${t('No pics or vids got approved, unfortunately.', 'Regrettably, no photographs or videos were approved.')}</p>`;
    }
    allMedia.forEach((m) => {
      const el = document.createElement(m.media_kind === 'video' ? 'video' : 'img');
      el.src = m.src;
      if (m.media_kind === 'video') el.controls = true;
      el.style.width = '100%';
      el.style.marginBottom = '10px';
      el.style.borderRadius = '6px';
      mediaEl.appendChild(el);
    });
  }

  async function loadRecap() {
    try {
      const data = await api('/api/game/recap');
      renderRecap(data);
      showOnly('screen-recap');
    } catch (e) {
      showOnly('screen-recap');
      $('recap-title').textContent = t('Recap', 'Summary');
      $('recap-summary').textContent = t('Could not load the recap — try refreshing.', 'Regrettably, the summary could not be loaded — kindly refresh the page.');
    }
  }

  $('extra-hint-btn').addEventListener('click', async () => {
    $('extra-hint-btn').disabled = true;
    try {
      const result = await api('/api/player/hint', { method: 'POST' });
      if (lastGameState) {
        lastGameState.location.extraHint = result.hint;
        lastGameState.location.extraHintEn = result.hintEn || null;
      }
      $('extra-hint-btn').classList.add('hidden');
      $('extra-hint-text').textContent = `💡 ${t(result.hint, result.hintEn)}`;
      $('extra-hint-text').classList.remove('hidden');
    } catch (e) {
      $('extra-hint-btn').disabled = false;
    }
  });

  initGate();
})();
