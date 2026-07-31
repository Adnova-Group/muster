(function() {
  if (typeof window === 'undefined') return;

  const CHANNEL = globalThis.__MUSTER_BRAINSTORM_CHANNEL__;
  try { delete globalThis.__MUSTER_BRAINSTORM_CHANNEL__; } catch (_) {}
  if (typeof CHANNEL !== 'string' || !/^[0-9a-f]{32}$/.test(CHANNEL)) return;
  const MAX_TEXT = 2048;

  function bounded(value) {
    if (value === undefined || value === null) return null;
    return String(value).slice(0, MAX_TEXT);
  }

  function post(event) {
    window.parent.postMessage({ channel: CHANNEL, event }, '*');
  }

  function select(target) {
    const container = target.closest('.options') || target.closest('.cards');
    const multi = container && container.dataset.multiselect !== undefined;
    if (container && !multi) {
      container.querySelectorAll('.option, .card').forEach((item) => item.classList.remove('selected'));
    }
    if (multi) target.classList.toggle('selected');
    else target.classList.add('selected');
  }

  document.addEventListener('click', (clickEvent) => {
    const target = clickEvent.target && clickEvent.target.closest
      ? clickEvent.target.closest('[data-choice]')
      : null;
    if (!target) return;
    select(target);
    post({
      type: 'click',
      text: bounded(target.textContent && target.textContent.trim()),
      choice: bounded(target.dataset.choice),
      id: bounded(target.id),
    });
  });
})();
