(() => {
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['screen-loading', 'screen-question', 'screen-success', 'screen-error'];
  function show(id) { SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id)); }

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

  function showError(message) {
    $('error-text').textContent = message;
    show('screen-error');
  }

  $('back-to-hunt').addEventListener('click', () => { window.location.href = '/'; });
  $('error-back').addEventListener('click', () => { window.location.href = '/'; });

  async function init() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return showError('This link is missing its tag ID.');

    try {
      const result = await api('/api/game/checkin', { method: 'POST', body: JSON.stringify({ token }) });
      if (result.needsAnswer) {
        $('question-text').textContent = result.question;
        show('screen-question');
      } else {
        show('screen-success');
      }
    } catch (e) {
      const err = e.data?.error;
      if (err === 'player_required' || err === 'gate_required') {
        showError('Please open the main hunt link and join your team first, then tap the tag again.');
      } else if (err === 'not_current_location') {
        showError("This isn't your team's current location — check the hint in the app.");
      } else if (err === 'unknown_tag') {
        showError("This tag isn't part of the hunt.");
      } else if (err === 'already_finished') {
        showError('Your team already finished the hunt!');
      } else {
        showError('Could not check you in — try again or use the backup code in the app.');
      }
    }
  }

  $('answer-submit').addEventListener('click', async () => {
    $('answer-error').classList.add('hidden');
    const answer = $('answer-input').value.trim();
    if (!answer) return;
    try {
      await api('/api/game/checkin-answer', { method: 'POST', body: JSON.stringify({ answer }) });
      show('screen-success');
    } catch (e) {
      $('answer-error').textContent = 'Not quite — try again.';
      $('answer-error').classList.remove('hidden');
    }
  });

  init();
})();
