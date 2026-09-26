(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scavenger-hunt-app' },
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

  // escapeHtml doesn't encode double quotes (fine for text nodes, not safe
  // inside a value="..." attribute) — the Setup page's editable fields need this.
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  async function initGate() {
    const q = await api('/api/gate/question');
    $('gate-question').textContent = q.question;
    if (q.passed) return afterGate();
  }

  $('gate-submit').addEventListener('click', async () => {
    hide('gate-error');
    const answer = $('gate-answer').value;
    if (!answer.trim()) return;
    try {
      await api('/api/gate/verify', { method: 'POST', body: JSON.stringify({ answer }) });
      afterGate();
    } catch (e) {
      $('gate-error').textContent = "That's not it — try again.";
      show('gate-error');
    }
  });

  function afterGate() { hide('screen-gate'); tryDashboard(); }

  async function tryDashboard() {
    try {
      await loadOverview();
      show('screen-dashboard');
      connectSocket();
    } catch (e) {
      show('screen-login');
    }
  }

  $('login-submit').addEventListener('click', async () => {
    hide('login-error');
    const password = $('admin-password').value;
    if (!password) return;
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
      hide('screen-login');
      await loadOverview();
      show('screen-dashboard');
      connectSocket();
    } catch (e) {
      $('login-error').textContent = e.data?.error === 'too_many_attempts'
        ? 'Too many attempts — wait a bit and try again.' : 'Incorrect password.';
      show('login-error');
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    location.reload();
  });

  // ---- Notifications (item 3): a beep + optional OS notification + a
  // flashing tab title, so the admin doesn't have to keep this tab focused
  // to know a submission or other update just came in. ----
  let notificationsEnabled = false;
  let titleFlashTimer = null;
  const BASE_TITLE = document.title;

  $('notify-btn').addEventListener('click', () => {
    if (!('Notification' in window)) { alert("This browser doesn't support notifications."); return; }
    Notification.requestPermission().then((perm) => {
      notificationsEnabled = perm === 'granted';
      $('notify-btn').textContent = notificationsEnabled ? '🔔 Notifications on' : "Couldn't enable — check your browser's site settings";
    });
  });

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) { /* no Web Audio support — silently skip the beep */ }
  }

  function flashTitle(text) {
    clearInterval(titleFlashTimer);
    let showingAlert = true;
    document.title = text;
    titleFlashTimer = setInterval(() => {
      document.title = showingAlert ? BASE_TITLE : text;
      showingAlert = !showingAlert;
    }, 1200);
    const stop = () => {
      clearInterval(titleFlashTimer);
      document.title = BASE_TITLE;
      window.removeEventListener('focus', stop);
    };
    window.addEventListener('focus', stop);
  }

  function notify(title, body) {
    beep();
    flashTitle(`🔔 ${title}`);
    if (notificationsEnabled && document.hidden) {
      try { new Notification(title, { body }); } catch (e) { /* ignore */ }
    }
  }

  let socket = null;
  function connectSocket() {
    if (socket) return;
    socket = io({ path: '/socket.io' });
    socket.on('new-submission', (data) => {
      notify(
        data.isFinal ? `🏁 FINAL submission — ${data.teamName}` : `New submission — ${data.teamName}`,
        `${data.submittedBy || 'Someone'} — ${data.locationName}`
      );
      loadOverview();
    });
    socket.on('submission-reviewed', loadOverview);
    socket.on('admin-activity', () => { notify('Update', 'Something happened — check the dashboard.'); loadOverview(); });
    socket.on('game-state-changed', () => { notify('Update', 'Game state changed.'); loadOverview(); });
  }

  async function loadOverview() {
    const data = await api('/api/admin/overview');
    renderLobby(data);
    renderTeams(data.teams);
    renderPending(data.pending);
    renderPendingFinal(data.pendingFinal);
    renderActivity(data.activity);
  }

  function renderLobby(data) {
    $('lobby-mode-text').textContent = `Teams are admin-assigned via the roster on the Setup page${data.gamePhase === 'active' ? ' · Hunt in progress' : data.gamePhase === 'ended' ? ' · Hunt ended' : ' · In the lobby'}`;
    $('leaderboard-toggle').checked = !!data.leaderboardEnabled;

    if (data.gamePhase === 'ended' && data.winningTeamName) {
      $('winner-banner-title').textContent = `🏆 ${data.winningTeamName} found the host and won!`;
      show('winner-banner');
    } else {
      hide('winner-banner');
    }

    const unassignedEl = $('unassigned-area');
    unassignedEl.innerHTML = '';
    if (data.unassigned.length) {
      const heading = document.createElement('p');
      heading.className = 'muted';
      heading.textContent = 'Not on a team yet:';
      unassignedEl.appendChild(heading);
      data.unassigned.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'admin-team-card';
        row.innerHTML = `<div class="row"><strong>${escapeHtml(p.name)}</strong></div>
          <p class="muted" style="margin-top:4px;">Doesn't match the roster — they can fix this themselves by re-entering their name, no action needed from you.</p>`;
        unassignedEl.appendChild(row);
      });
    }

    if (data.gamePhase === 'lobby') {
      show('start-hunt-btn');
      show('force-start-btn');
      $('start-hunt-btn').disabled = !data.canStart;
      if (!data.canStart) show('cant-start-note'); else hide('cant-start-note');
    } else {
      hide('start-hunt-btn');
      hide('cant-start-note');
      hide('force-start-btn');
    }
  }

  $('start-hunt-btn').addEventListener('click', async () => {
    if (!confirm('Start the hunt for everyone now?')) return;
    await api('/api/admin/start-hunt', { method: 'POST' });
    await loadOverview();
  });

  // Bypasses the "every team has a member and a location" check — useful for
  // last-minute cancellations or roster changes where you just want to go
  // with whatever the teams currently look like.
  $('force-start-btn').addEventListener('click', async () => {
    if (!confirm("Start the hunt right now with the teams exactly as they are — even if some have no members or no locations set up? Continue?")) return;
    await api('/api/admin/start-hunt', { method: 'POST' });
    await loadOverview();
  });

  $('leaderboard-toggle').addEventListener('change', async (e) => {
    try {
      await api('/api/admin/leaderboard-toggle', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
    } catch (err) {
      e.target.checked = !e.target.checked;
    }
  });

  function renderTeams(teams) {
    const el = $('teams-list');
    el.innerHTML = '';
    teams.forEach((t) => {
      const div = document.createElement('div');
      div.className = 'admin-team-card';
      const membersText = t.members.map((m) => escapeHtml(m.name)).join(', ') || 'No one yet';
      const quietNote = (t.quietMinutes != null && t.quietMinutes >= 15)
        ? `<p class="muted" style="margin-top:6px;">⚠️ Hasn't checked in for ${t.quietMinutes} minutes — might be worth a nudge.</p>` : '';
      const onRegularLocation = t.currentPhase === 'guessing' || t.currentPhase === 'task';
      let progressLine;
      if (t.currentPhase === 'gate') {
        progressLine = `Finished all ${t.total} locations — waiting out the gate timer`;
      } else if (t.currentPhase === 'final') {
        progressLine = `On the 🏁 FINAL bonus round`;
      } else {
        const phaseNote = t.currentPhase === 'guessing' ? 'guessing the spot' : t.currentPhase === 'task' ? 'on the task' : '';
        progressLine = `On location ${t.progress + 1} of ${t.total}: ${escapeHtml(t.currentLocation ? t.currentLocation.name : '—')}${phaseNote ? ` (${phaseNote})` : ''}`;
      }
      div.innerHTML = `
        <div class="row">
          <h3>${escapeHtml(t.name)}</h3>
          <span class="muted">${t.members.length} player${t.members.length === 1 ? '' : 's'}</span>
        </div>
        <p class="muted" style="margin-top:4px;">${membersText}</p>
        <p class="muted" style="margin-top:6px;">
          ${progressLine} — 💡 ${t.hintsUsed} hint${t.hintsUsed === 1 ? '' : 's'} used
        </p>
        ${quietNote}
        ${onRegularLocation ? `<button class="btn-secondary advance-btn" data-team="${t.id}" data-name="${escapeHtml(t.name)}" style="margin-top:8px;">Manually advance (WhatsApp backup)</button>` : ''}`;
      el.appendChild(div);
    });

    el.querySelectorAll('.advance-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const teamId = btn.dataset.team;
        const teamName = btn.dataset.name;
        const note = prompt(`Advance ${teamName} to the next hint without a submission. Optional note:`, '');
        if (note === null) return;
        btn.disabled = true;
        try {
          await api('/api/admin/advance-team', { method: 'POST', body: JSON.stringify({ teamId, note }) });
          await loadOverview();
        } catch (e) { btn.disabled = false; }
      });
    });
  }

  function renderPending(pending) {
    $('pending-count').textContent = pending.length ? `(${pending.length})` : '';
    const el = $('pending-list');
    el.innerHTML = '';
    if (!pending.length) {
      el.innerHTML = `<div class="empty-state">Nothing waiting on you right now.</div>`;
      return;
    }
    pending.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'submission-card';
      const media = s.media_kind === 'video'
        ? `<video src="/api/admin/image/${s.id}" controls playsinline></video>`
        : `<img src="/api/admin/image/${s.id}" loading="lazy" alt="Submission">`;
      div.innerHTML = `
        <div class="submission-meta"><strong>${escapeHtml(s.teamName)}</strong> — ${escapeHtml(s.locationName)}</div>
        <div class="submission-meta">Submitted by ${escapeHtml(s.playerName || 'unknown')}</div>
        ${s.adminNote ? `<div class="submission-meta">Admin note: ${escapeHtml(s.adminNote)}</div>` : ''}
        ${media}
        <div class="submission-actions">
          <button class="btn-approve" data-id="${s.id}" data-decision="approve">Approve</button>
          <button class="btn-danger" data-id="${s.id}" data-decision="reject">Reject</button>
        </div>`;
      el.appendChild(div);
    });

    el.querySelectorAll('button[data-decision]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const decision = btn.dataset.decision;
        let note = '';
        if (decision === 'reject') note = prompt('Optional note for the team (why it was rejected):', '') || '';
        btn.closest('.submission-card').querySelectorAll('button').forEach((b) => (b.disabled = true));
        try {
          await api(`/api/admin/review/${id}`, { method: 'POST', body: JSON.stringify({ decision, note }) });
          await loadOverview();
        } catch (e) {
          alert('Could not save that decision — try again.');
          await loadOverview();
        }
      });
    });
  }

  function renderPendingFinal(pendingFinal) {
    const card = $('pending-final-card');
    const el = $('pending-final-list');
    if (!pendingFinal.length) { hide(card); el.innerHTML = ''; return; }
    show(card);
    el.innerHTML = '';
    pendingFinal.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'submission-card';
      const media = s.media_kind === 'video'
        ? `<video src="/api/admin/final-image/${s.id}" controls playsinline></video>`
        : `<img src="/api/admin/final-image/${s.id}" loading="lazy" alt="Final submission">`;
      div.innerHTML = `
        <div class="submission-meta"><strong>${escapeHtml(s.teamName)}</strong> — FINAL CHALLENGE</div>
        <div class="submission-meta">Submitted by ${escapeHtml(s.playerName || 'unknown')}</div>
        ${media}
        <div class="submission-actions">
          <button class="btn-approve" data-id="${s.id}" data-decision="approve">Approve — END THE HUNT</button>
          <button class="btn-danger" data-id="${s.id}" data-decision="reject">Reject</button>
        </div>`;
      el.appendChild(div);
    });

    el.querySelectorAll('button[data-decision]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const decision = btn.dataset.decision;
        if (decision === 'approve' && !confirm('This ends the hunt RIGHT NOW for both teams — are you sure this is really the host?')) return;
        let note = '';
        if (decision === 'reject') note = prompt('Optional note for the team (why it was rejected):', '') || '';
        btn.closest('.submission-card').querySelectorAll('button').forEach((b) => (b.disabled = true));
        try {
          await api(`/api/admin/review-final/${id}`, { method: 'POST', body: JSON.stringify({ decision, note }) });
          await loadOverview();
        } catch (e) {
          alert('Could not save that decision — try again.');
          await loadOverview();
        }
      });
    });
  }

  function renderActivity(items) {
    const el = $('activity-list');
    el.innerHTML = '';
    if (!items.length) {
      el.innerHTML = `<div class="empty-state">Nothing yet.</div>`;
      return;
    }
    items.forEach((a) => {
      const div = document.createElement('div');
      div.className = 'submission-meta';
      div.textContent = `${a.ts.split(' ')[1] || a.ts} — ${a.message}`;
      el.appendChild(div);
    });
  }

  // ============ PHOTO ARCHIVE (item 1: every submission, any status) ============
  $('open-gallery-btn').addEventListener('click', async () => {
    hide('screen-dashboard');
    await loadGallery();
    show('screen-gallery');
  });
  $('gallery-back-btn').addEventListener('click', async () => {
    hide('screen-gallery');
    await loadOverview();
    show('screen-dashboard');
  });

  async function loadGallery() {
    const data = await api('/api/admin/gallery');
    const el = $('gallery-list');
    el.innerHTML = '';
    if (!data.submissions.length) {
      el.innerHTML = '<div class="card"><div class="empty-state">No submissions yet.</div></div>';
      return;
    }
    data.submissions.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'card';
      const src = s.kind === 'final' ? `/api/admin/final-image/${s.id}` : `/api/admin/image/${s.id}`;
      const media = s.media_kind === 'video'
        ? `<video src="${src}" controls playsinline></video>`
        : `<img src="${src}" loading="lazy" alt="Submission">`;
      const statusClass = s.status === 'approved' ? 'status-approved' : s.status === 'pending' ? 'status-pending' : '';
      div.innerHTML = `
        <div class="submission-meta"><strong>${escapeHtml(s.teamName)}</strong> — ${escapeHtml(s.locationName)}</div>
        <div class="submission-meta">By ${escapeHtml(s.playerName || 'unknown')} · ${escapeHtml(s.submitted_at)}</div>
        <span class="status-pill ${statusClass}">${escapeHtml(s.status)}</span>
        ${media}`;
      el.appendChild(div);
    });
  }

  // ============ SETUP PAGE ============
  let setupState = { teams: [], gamePhase: 'lobby' };

  $('open-setup-btn').addEventListener('click', async () => {
    hide('screen-dashboard');
    await loadSetup();
    show('screen-setup');
  });
  $('setup-back-btn').addEventListener('click', async () => {
    hide('screen-setup');
    await loadOverview();
    show('screen-dashboard');
  });

  async function loadSetup() {
    const data = await api('/api/admin/setup');
    setupState = {
      teams: data.teams.map((t) => ({
        name: t.name, rosterNames: t.rosterNames,
        locations: t.locations.map((l) => ({ ...l })),
      })),
      gamePhase: data.gamePhase,
    };
    $('setup-title').value = data.gameTitle;
    $('setup-gate-question').value = data.gateQuestion;
    $('setup-gate-answer').value = '';
    $('setup-admin-password').value = '';

    const locked = data.gamePhase !== 'lobby';
    $('setup-locked-note').classList.toggle('hidden', !locked);
    document.querySelectorAll('#screen-setup input, #screen-setup textarea, #screen-setup button')
      .forEach((el) => {
        if (el.id === 'setup-back-btn' || el.id === 'setup-reset-btn') return;
        el.disabled = locked;
      });

    renderSetupTeams();
  }

  function renderSetupTeams() {
    const el = $('setup-teams');
    el.innerHTML = '';
    setupState.teams.forEach((t, ti) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <h3 style="margin-bottom:14px;">Team ${ti + 1}</h3>
        <label>Team name</label>
        <input type="text" data-team="${ti}" data-field="name" value="${escapeAttr(t.name)}">
        <label>Roster — names for this team, comma-separated (this is how players get placed; there's no self-pick)</label>
        <input type="text" data-team="${ti}" data-field="rosterNames" value="${escapeAttr(t.rosterNames)}">

        <h4 style="margin:18px 0 4px;">Locations for this team</h4>
        <p class="muted" style="margin-bottom:14px;">In order — this is the order this team will visit them. Each team has its own separate list.</p>
        <div id="setup-locations-${ti}"></div>
        <button class="btn-secondary setup-add-location" data-team="${ti}" style="margin-top:6px;">+ Add location for Team ${ti + 1}</button>
      `;
      el.appendChild(card);
      renderSetupLocations(ti);
    });

    el.querySelectorAll('input[data-team]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const ti = Number(e.target.dataset.team);
        setupState.teams[ti][e.target.dataset.field] = e.target.value;
      });
    });
    el.querySelectorAll('.setup-add-location').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ti = Number(btn.dataset.team);
        setupState.teams[ti].locations.push({
          name: '', hint: '', guessAnswer: '', task: '', adminNote: '', extraHint: '',
        });
        renderSetupLocations(ti);
      });
    });
  }

  function renderSetupLocations(ti) {
    const el = document.getElementById(`setup-locations-${ti}`);
    if (!el) return;
    const locs = setupState.teams[ti].locations;
    el.innerHTML = '';
    locs.forEach((loc, i) => {
      const div = document.createElement('div');
      div.className = 'admin-team-card';
      div.innerHTML = `
        <div class="row" style="margin-bottom:10px;">
          <strong>Location ${i + 1}</strong>
          <div class="submission-actions" style="margin-top:0;">
            <button class="btn-secondary loc-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} style="padding:6px 10px;">↑</button>
            <button class="btn-secondary loc-down" data-i="${i}" ${i === locs.length - 1 ? 'disabled' : ''} style="padding:6px 10px;">↓</button>
            <button class="btn-danger loc-remove" data-i="${i}" style="padding:6px 10px;">Remove</button>
          </div>
        </div>
        <label>Name (the actual place — e.g. "CN Tower")</label>
        <input type="text" data-i="${i}" data-field="name" value="${escapeAttr(loc.name)}">
        <label>Clue shown to players before they guess</label>
        <input type="text" data-i="${i}" data-field="hint" value="${escapeAttr(loc.hint)}" placeholder="e.g. Tallest building in the city.">
        <label>Accepted guesses, separated by | (matched case-insensitively, ignoring words like "the")</label>
        <input type="text" data-i="${i}" data-field="guessAnswer" value="${escapeAttr(loc.guessAnswer)}" placeholder="e.g. CN Tower|CN|the tower">
        <label>Task — shown once they guess right, this is what they actually go do</label>
        <input type="text" data-i="${i}" data-field="task" value="${escapeAttr(loc.task)}" placeholder="e.g. Go to the base of the building and take a picture with the whole team.">
        <label>Private admin note (optional)</label>
        <input type="text" data-i="${i}" data-field="adminNote" value="${escapeAttr(loc.adminNote)}">
        <label>Extra elective hint (optional — players can choose to reveal this if stuck guessing)</label>
        <input type="text" data-i="${i}" data-field="extraHint" value="${escapeAttr(loc.extraHint)}">
      `;
      el.appendChild(div);
    });

    el.querySelectorAll('input[type="text"]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const i = Number(e.target.dataset.i);
        locs[i][e.target.dataset.field] = e.target.value;
      });
    });
    el.querySelectorAll('.loc-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        locs.splice(Number(btn.dataset.i), 1);
        renderSetupLocations(ti);
      });
    });
    el.querySelectorAll('.loc-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        [locs[i - 1], locs[i]] = [locs[i], locs[i - 1]];
        renderSetupLocations(ti);
      });
    });
    el.querySelectorAll('.loc-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        [locs[i], locs[i + 1]] = [locs[i + 1], locs[i]];
        renderSetupLocations(ti);
      });
    });
  }

  $('setup-save-btn').addEventListener('click', async () => {
    hide('setup-save-error');
    try {
      await api('/api/admin/setup', {
        method: 'POST',
        body: JSON.stringify({
          gameTitle: $('setup-title').value,
          gateQuestion: $('setup-gate-question').value,
          gateAnswer: $('setup-gate-answer').value,
          adminPassword: $('setup-admin-password').value,
          teams: setupState.teams,
        }),
      });
      $('setup-gate-answer').value = '';
      $('setup-admin-password').value = '';
      await loadSetup();
      alert('Saved!');
    } catch (e) {
      $('setup-save-error').textContent = e.data?.error === 'hunt_in_progress'
        ? 'The hunt has already started — reset the game before changing setup.'
        : e.data?.error === 'need_two_teams' ? 'Need exactly two teams.'
        : e.data?.error === 'need_locations' ? 'Every team needs at least one location.'
        : 'Could not save — try again.';
      show('setup-save-error');
    }
  });

  $('setup-reset-btn').addEventListener('click', async () => {
    if (!confirm('This clears all players and progress. Continue?')) return;
    try {
      await api('/api/admin/setup/reset', { method: 'POST' });
      await loadSetup();
      alert('Game reset — ready for a fresh start.');
    } catch (e) {
      alert('Could not reset — try again.');
    }
  });

  initGate();
})();
