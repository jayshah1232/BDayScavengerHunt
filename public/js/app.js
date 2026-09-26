(() => {
  const $ = (id) => document.getElementById(id);
  const ALL_SCREENS = [
    'screen-gate', 'screen-join',
    'screen-waiting-room', 'screen-leaderboard', 'screen-game', 'screen-recap',
  ];
  function showOnly(id) {
    ALL_SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
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
        ? 'Whoa, slow down — too many tries. Chill for a sec and try again.' : "Nah, that's not it — try again.";
      $('gate-error').classList.remove('hidden');
    }
  });

  // ---- JOIN (pick your name from everyone who hasn't checked in yet) ----
  async function showJoinScreen() {
    // Clear any leftover team-name-page state so a later visit to the
    // waiting room re-populates fresh instead of keeping a stale value.
    $('team-name-input').value = '';
    $('team-name-status').classList.add('hidden');
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
      $('join-error').textContent = `Couldn't load the name list (${e.data?.error || e.message || 'unknown error'}) — try refreshing.`;
      $('join-error').classList.remove('hidden');
    }
  }

  $('join-submit').addEventListener('click', async () => {
    $('join-error').classList.add('hidden');
    const name = $('player-name-select').value;
    if (!name) { $('join-error').textContent = 'Pick a name first.'; $('join-error').classList.remove('hidden'); return; }
    try {
      await api('/api/player/join', { method: 'POST', body: JSON.stringify({ name }) });
      resolveScreen();
    } catch (e) {
      if (e.data?.error === 'name_taken') {
        $('join-error').textContent = "Someone already grabbed that name — here's the updated list.";
        $('join-error').classList.remove('hidden');
        loadJoinNames();
      } else {
        $('join-error').textContent = 'Something glitched — try again.';
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

    if (gs.gamePhase === 'ended') return loadRecap();
    if (gs.gamePhase === 'active') {
      showOnly('screen-game');
      return loadGameState();
    }

    $('wr-player-name').textContent = gs.me.name;
    $('wr-team-name').textContent = gs.team.name;
    $('wr-roster').textContent = `Roster so far: ${gs.team.members.map((m) => m.name).join(', ')}`;
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

  async function loadGameState() {
    const state = await api('/api/player/state');
    renderGame(state);
  }

  // Rendered into any status-area for a rejection — loud on purpose (item 2:
  // players need to actually notice, not just see a muted grey pill).
  function rejectedAlertHtml(note) {
    const shown = note ? escapeHtml(note) : 'No reason given';
    if (navigator.vibrate) navigator.vibrate([120, 60, 120, 60, 200]);
    return `<div class="rejected-alert">
      <span class="rejected-emoji">🚫</span>
      <div class="rejected-title">NAH FAM, REJECTED</div>
      <div class="rejected-note">${shown}. Run it back!</div>
    </div>`;
  }

  function renderGame(state) {
    $('game-title').textContent = state.gameTitle;
    $('game-leaderboard-link').classList.toggle('hidden', !cachedLeaderboardEnabled);
    clearInterval(gateCountdownTimer);

    const trail = $('trail');
    trail.innerHTML = '';
    for (let i = 0; i < state.total; i++) {
      const dot = document.createElement('div');
      dot.className = 'dot' + (i < state.progress ? ' done' : i === state.progress ? ' current' : '');
      trail.appendChild(dot);
    }
    $('trail-label').textContent = `${Math.min(state.progress, state.total)} of ${state.total} bagged`;

    $('guess-area').classList.add('hidden');
    $('task-area').classList.add('hidden');
    $('gate-area').classList.add('hidden');
    $('final-area').classList.add('hidden');
    $('extra-hint-area').classList.add('hidden');

    if (state.phase === 'gate') return renderGate(state);
    if (state.phase === 'final') return renderFinal(state);

    // 'guessing' or 'task'
    $('loc-name').textContent = `SPOT ${state.progress + 1} OF ${state.total}`;
    $('hint-text').textContent = state.location.hint;

    if (state.location.hasExtraHint) {
      $('extra-hint-area').classList.remove('hidden');
      if (state.location.extraHint) {
        $('extra-hint-btn').classList.add('hidden');
        $('extra-hint-text').textContent = `💡 ${state.location.extraHint}`;
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

    $('task-loc-name').textContent = `YOU FOUND IT: ${state.location.name}`;
    $('task-text').textContent = state.location.task;

    const statusArea = $('status-area');
    statusArea.innerHTML = '';
    if (state.pendingCount > 0) {
      statusArea.innerHTML = `<div class="status-pill status-pending">${state.pendingCount} submission${state.pendingCount > 1 ? 's' : ''} waiting on admin review…</div>`;
    } else if (state.lastRejectedNote !== null) {
      statusArea.innerHTML = rejectedAlertHtml(state.lastRejectedNote);
    }

    resetPhotoPicker();
    $('submit-btn').textContent = state.pendingCount > 0 ? 'Send another attempt' : 'Send it in';
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
        btn.textContent = 'Continue';
        return;
      }
      btn.disabled = true;
      btn.textContent = `Continue (${Math.ceil(remainingMs / 1000)})`;
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
      statusArea.innerHTML = `<div class="status-pill status-pending">${state.pendingCount} submission${state.pendingCount > 1 ? 's' : ''} waiting on admin review…</div>`;
    } else if (state.lastRejectedNote !== null) {
      statusArea.innerHTML = rejectedAlertHtml(state.lastRejectedNote);
    }
    resetFinalPhotoPicker();
    $('final-submit-btn').textContent = state.pendingCount > 0 ? 'Send another attempt' : 'Send it in';
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
      $('guess-error').textContent = "Nah, not it — run it back.";
      $('guess-error').classList.remove('hidden');
    } finally {
      $('guess-submit').disabled = false;
    }
  });

  function resetPhotoPicker() {
    selectedFile = null;
    $('photo-input').value = '';
    $('photo-preview').classList.add('hidden');
    $('photo-picker-text').textContent = 'Tap to snap or grab a pic/video';
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
    $('submit-btn').textContent = 'Sending…';
    try {
      const form = new FormData();
      form.append('media', selectedFile);
      await api('/api/player/submit', { method: 'POST', body: form, isForm: true });
      await loadGameState();
    } catch (e) {
      $('submit-error').textContent = e.data?.error === 'invalid_media'
        ? "That's not a pic or video, bud — try again."
        : "Didn't go through — try again.";
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
    $('final-photo-picker-text').textContent = 'Tap to snap or grab a pic/video';
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
    $('final-submit-btn').textContent = 'Sending…';
    try {
      const form = new FormData();
      form.append('media', finalSelectedFile);
      await api('/api/player/submit-final', { method: 'POST', body: form, isForm: true });
      await loadGameState();
    } catch (e) {
      $('final-submit-error').textContent = e.data?.error === 'invalid_media'
        ? "That's not a pic or video, bud — try again."
        : "Didn't go through — try again.";
      $('final-submit-error').classList.remove('hidden');
      $('final-submit-btn').disabled = false;
      $('final-submit-btn').textContent = originalLabel;
    }
  });

  // ---- WRONG PLAYER PICKED: free up the name and go back to the dropdown ----
  $('wr-switch-player-link').addEventListener('click', async () => {
    if (!confirm("Switch to a different name? This'll free up your current name for someone else to grab.")) return;
    try {
      await api('/api/player/switch', { method: 'POST' });
      resolveScreen();
    } catch (e) {
      alert("Couldn't switch — try again.");
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
      $('team-name-status').classList.remove('hidden');
      clearTimeout(teamNameStatusTimer);
      teamNameStatusTimer = setTimeout(() => $('team-name-status').classList.add('hidden'), 3000);
    } catch (e) {
      $('team-name-error').textContent = e.data?.error === 'hunt_already_started'
        ? "Hunt's already poppin' off — team names are locked now." : "Didn't save — try again.";
      $('team-name-error').classList.remove('hidden');
    }
  });

  // ---- OPT-IN LEADERBOARD ----
  async function loadLeaderboard() {
    try {
      const data = await api('/api/game/leaderboard');
      const list = $('leaderboard-list');
      list.innerHTML = '';
      data.teams.forEach((t) => {
        const div = document.createElement('div');
        div.className = 'admin-team-card';
        div.innerHTML = `<div class="row"><h3>${escapeHtml(t.name)}</h3><span class="muted">${t.progress} of ${t.total} found</span></div>`;
        list.appendChild(div);
      });
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

  async function loadRecap() {
    try {
      const data = await api('/api/game/recap');
      $('recap-title').textContent = data.isWinner
        ? 'Jeeeezz! Big up to the winners'
        : `Ah, ${data.winningTeamName || 'the other squad'} found the host first!`;

      const others = data.allTeamFinishes.filter((t) => t.name !== data.teamName);
      const finishedOthers = others.filter((t) => t.finishedRegular && t.totalSeconds != null);
      let summary = data.totalSeconds != null
        ? `${data.teamName} wrapped up their locations in ${formatDuration(data.totalSeconds)}, popping ${data.hintsUsed} extra hint${data.hintsUsed === 1 ? '' : 's'} along the way.`
        : `${data.teamName} didn't finish their locations before the hunt ended, popping ${data.hintsUsed} extra hint${data.hintsUsed === 1 ? '' : 's'} along the way.`;
      if (finishedOthers.length && data.totalSeconds != null) {
        const diffs = finishedOthers.map((t) => `${t.name} in ${formatDuration(t.totalSeconds)} (${t.hintsUsed} hint${t.hintsUsed === 1 ? '' : 's'})`);
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
        mediaEl.innerHTML = '<p class="muted">No pics or vids got approved, unfortunately.</p>';
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

      showOnly('screen-recap');
    } catch (e) {
      showOnly('screen-recap');
      $('recap-title').textContent = 'Recap';
      $('recap-summary').textContent = 'Could not load the recap — try refreshing.';
    }
  }

  $('extra-hint-btn').addEventListener('click', async () => {
    $('extra-hint-btn').disabled = true;
    try {
      const result = await api('/api/player/hint', { method: 'POST' });
      $('extra-hint-btn').classList.add('hidden');
      $('extra-hint-text').textContent = `💡 ${result.hint}`;
      $('extra-hint-text').classList.remove('hidden');
    } catch (e) {
      $('extra-hint-btn').disabled = false;
    }
  });

  initGate();
})();
