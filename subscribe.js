// Flower subscription form. Plans come from plans.json; spots and checkout from the backend.
(function () {
  const cfg = window.TFF_CONFIG || {};
  const params = new URLSearchParams(location.search);
  // Local testing only: ?api=http://localhost:8787 on localhost.
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const apiBase = ((isLocal && params.get('api')) || cfg.apiBase || '').replace(/\/+$/, '');

  const form = document.getElementById('subscribe-form');
  if (!form) return;
  const el = (id) => document.getElementById(id);
  const spotsEl = el('subscribe-spots');
  const summaryEl = el('subscribe-summary');
  const errorEl = el('subscribe-error');
  const button = el('subscribe-button');
  const fullEl = el('subscribe-full');
  let plans = null;

  const money = (cents, currency) =>
    new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 0 }).format(cents / 100);

  function radios(container, name, items, labelFor) {
    container.innerHTML = '';
    items.forEach((item, i) => {
      const id = `${name}-${item.id}`;
      const wrap = document.createElement('label');
      wrap.className = 'choice';
      wrap.htmlFor = id;
      wrap.innerHTML = `<input type="radio" name="${name}" id="${id}" value="${item.id}" ${i === 0 ? 'checked' : ''} required /><span></span>`;
      wrap.querySelector('span').innerHTML = labelFor(item);
      container.appendChild(wrap);
    });
  }

  function value(name) {
    const checked = form.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : null;
  }

  function updateSummary() {
    if (!plans) return;
    const size = plans.sizes.find((s) => s.id === value('size'));
    const freq = plans.frequencies.find((f) => f.id === value('frequency'));
    const day = plans.pickupDays.find((d) => d.id === value('pickupDay'));
    if (!size || !freq || !day) return;
    summaryEl.textContent = `${size.name}, ${money(size.amount, plans.currency)} a ${freq.interval}. Pick up ${day.label}.`;
  }

  function showFull(cap) {
    form.hidden = true;
    fullEl.hidden = false;
    const contact = cfg.waitlistEmail
      ? `<a href="mailto:${cfg.waitlistEmail}?subject=${encodeURIComponent('Flower subscription waitlist')}">Email Angie</a> to join the waitlist`
      : `Message <a href="${cfg.instagramUrl}" target="_blank" rel="noopener noreferrer">@trampoline.flower.farm</a> to join the waitlist`;
    fullEl.innerHTML = `<p>All ${cap} subscription spots are taken. ${contact}, and we’ll be in touch when one opens.</p>`;
  }

  function setSpots(s) {
    if (s.full) return showFull(s.cap);
    spotsEl.textContent = `${s.remaining} of ${s.cap} spots left`;
    button.disabled = false;
  }

  async function loadStatus() {
    if (!apiBase) {
      spotsEl.textContent = `Subscriptions open soon. Limited to ${plans.maxSubscribers} spots.`;
      button.disabled = true;
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/status`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      setSpots(await res.json());
    } catch {
      spotsEl.textContent = 'Couldn’t check spots just now. Please try again shortly.';
      button.disabled = true;
    }
  }

  form.addEventListener('change', updateSummary);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    button.disabled = true;
    button.textContent = 'Opening secure checkout…';
    try {
      const res = await fetch(`${apiBase}/api/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          size: value('size'),
          frequency: value('frequency'),
          pickupDay: value('pickupDay'),
          attemptId: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        location.href = data.url; // Stripe-hosted Checkout: card details never touch this site
        return;
      }
      if (data.full) return showFull(data.cap);
      throw new Error(data.error || 'Something went wrong.');
    } catch (err) {
      errorEl.textContent = `${err.message} Please try again.`;
      button.disabled = false;
      button.textContent = 'Continue to payment';
    }
  });

  if (cfg.portalLoginUrl) {
    el('subscribe-manage').hidden = false;
    el('portal-link').href = cfg.portalLoginUrl;
  }

  fetch('plans.json')
    .then((r) => r.json())
    .then((p) => {
      plans = p;
      radios(el('choices-size'), 'size', p.sizes, (s) => `${s.name} <em>${money(s.amount, p.currency)}</em>`);
      radios(el('choices-frequency'), 'frequency', p.frequencies, (f) => `${f.label} <em>${f.note}</em>`);
      radios(el('choices-day'), 'pickupDay', p.pickupDays, (d) => d.label);
      updateSummary();
      return loadStatus();
    })
    .catch(() => {
      spotsEl.textContent = 'Subscriptions are unavailable right now.';
      button.disabled = true;
    });
})();
