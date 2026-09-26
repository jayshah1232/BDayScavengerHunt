// In-page replacement for window.alert/confirm/prompt — native browser
// dialogs render inconsistently (or not at all) in mobile home-screen/PWA
// contexts, so every screen uses this modal instead. Expects the modal
// markup (#modal-overlay etc.) to already be present in the page's HTML.
(() => {
  const $ = (id) => document.getElementById(id);

  function openModal({ message, showInput, inputValue, showCancel, confirmText, cancelText }) {
    return new Promise((resolve) => {
      const overlay = $('modal-overlay');
      const messageEl = $('modal-message');
      const inputEl = $('modal-input');
      const confirmBtn = $('modal-confirm-btn');
      const cancelBtn = $('modal-cancel-btn');

      messageEl.textContent = message;
      inputEl.classList.toggle('hidden', !showInput);
      inputEl.value = inputValue || '';
      cancelBtn.classList.toggle('hidden', !showCancel);
      confirmBtn.textContent = confirmText || 'OK';
      cancelBtn.textContent = cancelText || 'Cancel';

      function cleanup() {
        overlay.classList.add('hidden');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('mousedown', onOverlayClick);
        inputEl.removeEventListener('keydown', onKeydown);
      }
      function onConfirm() {
        cleanup();
        resolve(showInput ? inputEl.value : true);
      }
      function onCancel() {
        cleanup();
        resolve(showInput ? null : false);
      }
      function onOverlayClick(e) {
        if (e.target === overlay) onCancel();
      }
      function onKeydown(e) {
        if (e.key === 'Enter' && showInput) onConfirm();
        if (e.key === 'Escape') onCancel();
      }

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('mousedown', onOverlayClick);
      inputEl.addEventListener('keydown', onKeydown);

      overlay.classList.remove('hidden');
      if (showInput) { inputEl.focus(); inputEl.select(); } else { confirmBtn.focus(); }
    });
  }

  // Message only, one "OK" button. Resolves once dismissed.
  window.modalAlert = (message) => openModal({ message, showCancel: false, confirmText: 'OK' });

  // Message + Cancel/Confirm. Resolves true/false.
  window.modalConfirm = (message, confirmText, cancelText) => openModal({
    message, showCancel: true, confirmText: confirmText || 'Confirm', cancelText: cancelText || 'Cancel',
  });

  // Message + text field + Cancel/Submit. Resolves the entered string, or
  // null if cancelled — matching window.prompt's contract.
  window.modalPrompt = (message, defaultValue) => openModal({
    message, showInput: true, inputValue: defaultValue, showCancel: true, confirmText: 'Submit', cancelText: 'Cancel',
  });
})();
