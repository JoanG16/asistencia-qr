async function tick() {
  try {
    const res = await fetch('/api/qr', { cache: 'no-store' });
    if (res.status === 401) { location.href = '/admin'; return; }
    const r = await res.json();
    document.getElementById('qr').innerHTML = r.svg;
    document.getElementById('c').textContent = 'Registrados: ' + r.count;
    const b = document.getElementById('b');
    b.style.transition = 'none';
    b.style.width = (r.expiresInMs / 5000 * 100) + '%';
    b.offsetWidth;
    b.style.transition = 'width ' + r.expiresInMs + 'ms linear';
    b.style.width = '0%';
    setTimeout(tick, r.expiresInMs + 50);
  } catch (e) { setTimeout(tick, 1500); }
}
tick();
