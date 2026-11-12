
(() => {
  const KEY = 'fit-connect-selected-date';

  const today = () => {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ].join('-');
  };

  window.addEventListener('load', () => {
    const input = document.getElementById('currentDateInput');
    if (!input) return;

    const saved = sessionStorage.getItem(KEY);

    if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved)) {
      input.value = saved;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    input.addEventListener('change', () => {
      sessionStorage.setItem(KEY, input.value);
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '오늘';
    button.className =
      'ml-2 px-3 py-1 rounded-lg bg-slate-700 text-white text-xs';

    button.onclick = () => {
      input.value = today();
      sessionStorage.setItem(KEY, input.value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    input.insertAdjacentElement('afterend', button);
  });
})();
