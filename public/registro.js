const token = location.hash.slice(1);
history.replaceState(null, '', '/registro.html');
const $ = (s) => document.querySelector(s);

if (!token) {
  document.body.innerHTML = '<div class="wrap"><div class="card head"><h1>Escanee el QR</h1><p>Use el código QR de la pantalla de la reunión para registrarse.</p></div></div>';
} else {
  fetch('/api/locales').then((r) => r.json()).then(({ locales }) => {
    const dl = $('#locales');
    locales.forEach((l) => { const o = document.createElement('option'); o.value = l; dl.appendChild(o); });
  });
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    $('#e').textContent = '';
    const d = Object.fromEntries(new FormData(ev.target));
    const bad = { nombres: d.nombres.trim().split(/\s+/).length < 2 || d.nombres.trim().length < 5, local: d.local.trim().length < 2 };
    let any = false;
    for (const k in bad) { document.querySelector('[data-f=' + k + ']').classList.toggle('err', bad[k]); any = any || bad[k]; }
    if (any) return;
    d.token = token;
    $('#btn').disabled = true;
    try {
      const r = await fetch('/api/registro', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
      const j = await r.json();
      if (j.ok) { $('#f').style.display = 'none'; $('#ok').style.display = 'block'; }
      else { $('#e').textContent = j.error; $('#btn').disabled = false; }
    } catch (x) { $('#e').textContent = 'Sin conexión. Intente de nuevo.'; $('#btn').disabled = false; }
  };
}
