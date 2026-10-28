async function tick() {
  try {
    const r = await fetch('/api/qr', { cache: 'no-store' }).then((x) => x.json());
    document.getElementById('qr').innerHTML = r.svg;
    document.getElementById('c').textContent = 'Registrados: ' + r.count;
    setTimeout(tick, r.expiresInMs + 50);
  } catch (e) { setTimeout(tick, 1500); }
}
tick();
