const $ = (id) => document.getElementById(id);
let data = null;

function render() {
  if (!data) return;
  $('k1').textContent = data.totalAsistentes;
  $('k2').textContent = data.localesPresentes;
  $('k3').textContent = data.localesAusentes;
  $('k4').textContent = data.porcentaje + '%';
  $('bar').style.width = data.porcentaje + '%';
  fill('l1', data.presentes, $('s1').value, 'Aún no hay locales registrados.', true);
  fill('l2', data.ausentes, $('s2').value, 'Todos los locales asistieron.', false);
}

function fill(id, items, q, emptyMsg, withCount) {
  const ul = $(id);
  const f = items.filter((i) => i.local.toLowerCase().includes(q.trim().toLowerCase()));
  ul.replaceChildren();
  if (!f.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.display = 'block';
    li.textContent = q ? 'Sin resultados.' : emptyMsg;
    ul.appendChild(li);
    return;
  }
  for (const i of f) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = i.local;
    const ct = document.createElement('span');
    ct.className = 'ct';
    ct.textContent = i.ct;
    name.appendChild(ct);
    li.appendChild(name);
    if (withCount) {
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = i.asistentes;
      li.appendChild(n);
    }
    ul.appendChild(li);
  }
}

async function load() {
  try {
    const r = await fetch('/api/stats', { cache: 'no-store' });
    if (r.status === 401) { location.href = '/admin'; return; }
    data = await r.json();
    render();
    $('upd').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-EC');
  } catch (e) { $('upd').textContent = 'Sin conexión'; }
}
$('s1').oninput = render;
$('s2').oninput = render;
load();
setInterval(load, 10000);
