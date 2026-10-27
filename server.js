const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3100;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(9).toString('base64url');
if (!process.env.ADMIN_KEY) console.log(`ADMIN_KEY temporal (defina la variable ADMIN_KEY): ${ADMIN_KEY}`);
const ROTATE_MS = 5000;
const GRACE_WINDOWS = 1; // acepta el QR actual y el anterior (red lenta)
const FORM_TTL_MS = 3 * 60 * 1000;
const CSV = path.join(__dirname, 'asistencia.csv');

const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 22);
const win = () => Math.floor(Date.now() / ROTATE_MS);
const qrToken = (w) => `${w}.${hmac('qr' + w)}`;

function validQr(tok) {
  const [w, sig] = String(tok || '').split('.');
  const n = Number(w);
  if (!Number.isInteger(n) || !sig || sig !== hmac('qr' + n)) return false;
  return win() - n >= 0 && win() - n <= GRACE_WINDOWS;
}

// Token de formulario: firmado y con expiración; el uso único se garantiza al guardar
function newFormToken() {
  const id = crypto.randomBytes(12).toString('base64url');
  const exp = Date.now() + FORM_TTL_MS;
  return `${id}.${exp}.${hmac(`f${id}.${exp}`)}`;
}
function checkFormToken(tok) {
  const [id, exp, sig] = String(tok || '').split('.');
  if (!id || !exp || !sig || sig !== hmac(`f${id}.${exp}`)) return false;
  return Number(exp) > Date.now();
}

// Almacenamiento: Postgres si hay DATABASE_URL, si no CSV local
let pool = null;
const registered = new Set();
const usedForms = new Set();
const csvEscape = (v) => `"${String(v).replace(/"/g, '""')}"`;

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 10,
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS asistencia (
      id SERIAL PRIMARY KEY, fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
      cedula TEXT NOT NULL UNIQUE, nombres TEXT NOT NULL, local TEXT NOT NULL)`);
    await pool.query('CREATE TABLE IF NOT EXISTS asistencia_tokens (id TEXT PRIMARY KEY)');
    return;
  }
  if (fs.existsSync(CSV)) {
    fs.readFileSync(CSV, 'utf8').split('\n').slice(1).forEach((l) => {
      const c = l.split(',')[1];
      if (c) registered.add(c.replace(/"/g, ''));
    });
  } else fs.writeFileSync(CSV, 'fecha,cedula,nombres,local\n');
}

let countCache = { n: 0, t: 0 };
async function countRegistered() {
  if (!pool) return registered.size;
  if (Date.now() - countCache.t > 3000) {
    countCache = { n: Number((await pool.query('SELECT count(*) FROM asistencia')).rows[0].count), t: Date.now() };
  }
  return countCache.n;
}

// Devuelve 'ok' | 'used' (token ya usado) | 'dup' (cédula ya registrada)
async function saveRecord(tokenId, ced, nom, loc) {
  if (!pool) {
    if (usedForms.has(tokenId)) return 'used';
    if (registered.has(ced)) return 'dup';
    usedForms.add(tokenId);
    registered.add(ced);
    fs.appendFileSync(CSV, `${new Date().toISOString()},${csvEscape(ced)},${csvEscape(nom)},${csvEscape(loc)}\n`);
    return 'ok';
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query('INSERT INTO asistencia_tokens(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [tokenId]);
    if (!t.rowCount) { await client.query('ROLLBACK'); return 'used'; }
    const r = await client.query(
      'INSERT INTO asistencia(cedula,nombres,local) VALUES($1,$2,$3) ON CONFLICT (cedula) DO NOTHING RETURNING id',
      [ced, nom, loc]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return 'dup'; }
    await client.query('COMMIT');
    return 'ok';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const app = express();
app.use(express.json({ limit: '5kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Pantalla proyectada: QR rotativo
app.get('/api/qr', async (req, res) => {
  const url = `${BASE_URL}/s/${qrToken(win())}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 420 });
  res.set('Cache-Control', 'no-store').json({ svg, expiresInMs: ROTATE_MS - (Date.now() % ROTATE_MS), count: await countRegistered() });
});

// Escaneo: valida token y redirige al formulario con token propio de un solo uso
app.get('/s/:tok', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!validQr(req.params.tok)) return res.status(410).sendFile(path.join(__dirname, 'public', 'expirado.html'));
  res.redirect(302, `/registro.html#${newFormToken()}`);
});

app.post('/api/registro', async (req, res) => {
  try {
  const { token, cedula, nombres, local } = req.body || {};
  if (!checkFormToken(token)) return res.status(403).json({ error: 'Enlace vencido o ya usado. Escanee el QR de nuevo.' });
  const ced = String(cedula || '').trim();
  const nom = String(nombres || '').trim().replace(/[",\r\n]/g, ' ');
  const loc = String(local || '').trim().replace(/[",\r\n]/g, ' ');
  if (!/^\d{10}$/.test(ced) || nom.length < 5 || nom.length > 100 || !loc || loc.length > 60) {
    return res.status(400).json({ error: 'Datos inválidos. Cédula de 10 dígitos, nombres completos y local.' });
  }
  const r = await saveRecord(token.split('.')[0], ced, nom, loc);
  if (r === 'used') return res.status(403).json({ error: 'Enlace vencido o ya usado. Escanee el QR de nuevo.' });
  if (r === 'dup') return res.status(409).json({ error: 'Esta cédula ya registró asistencia.' });
  res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor. Intente de nuevo.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const adminOk = (k) => {
  const a = crypto.createHash('sha256').update(String(k || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
};

async function getRows() {
  if (pool) {
    const { rows } = await pool.query('SELECT fecha,cedula,nombres,local FROM asistencia ORDER BY id');
    return rows.map((r) => [r.fecha, r.cedula, r.nombres, r.local]);
  }
  return fs.readFileSync(CSV, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
    const c = [...l.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map((m) => (m[1] ?? m[2]).replace(/""/g, '"'));
    return [new Date(c[0]), c[1], c[2], c[3]];
  });
}

// Ruta privada de descarga: la clave viaja por POST, no en la URL
app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f0ebf8;font-family:Roboto,Arial,sans-serif">
<form method="post" action="/admin/descargar" style="background:#fff;border:1px solid #dadce0;border-top:10px solid #673ab7;border-radius:8px;padding:24px;width:320px">
<h2 style="font-weight:400;margin:0 0 16px">Descargar asistencia</h2>
<input type="password" name="key" placeholder="Clave de administrador" required style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #dadce0;border-radius:4px">
<button style="margin-top:16px;width:100%;padding:10px;background:#673ab7;color:#fff;border:0;border-radius:4px;cursor:pointer">Descargar Excel</button></form></body></html>`);
});

app.post('/admin/descargar', express.urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
  if (!adminOk(req.body && req.body.key)) return res.status(401).set('Cache-Control', 'no-store').send('Clave incorrecta');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Asistencia');
  ws.columns = [
    { header: 'Fecha', key: 'f', width: 22 },
    { header: 'Cédula', key: 'c', width: 16, style: { numFmt: '@' } },
    { header: 'Nombres completos', key: 'n', width: 40 },
    { header: 'Local', key: 'l', width: 24 },
  ];
  ws.getRow(1).font = { bold: true };
  (await getRows()).forEach(([f, c, n, l]) => ws.addRow({ f, c, n, l }));
  ws.getColumn('f').numFmt = 'yyyy-mm-dd hh:mm:ss';
  res.set({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="asistencia.xlsx"',
  });
  await wb.xlsx.write(res);
  res.end();
});

initStore().then(() => app.listen(PORT, () => {
  console.log(`Pantalla QR:  ${BASE_URL}/`);
  console.log(`Almacenamiento: ${pool ? 'Postgres' : 'CSV local'}`);
})).catch((e) => { console.error(e); process.exit(1); });
