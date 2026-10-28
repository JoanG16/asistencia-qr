const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3100;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(18).toString('base64url');
if (!process.env.ADMIN_KEY) console.log(`ADMIN_KEY temporal (defina la variable ADMIN_KEY): ${ADMIN_KEY}`);
const TZ = process.env.TIME_ZONE || 'America/Guayaquil';
const ROTATE_MS = 5000;
const GRACE_WINDOWS = 1; // acepta el QR actual y el anterior (red lenta)
const FORM_TTL_MS = 3 * 60 * 1000;
const SESSION_MS = 12 * 3600 * 1000;
const CSV = path.join(__dirname, 'asistencia.csv');

const LOCALES = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales.json'), 'utf8'));
const LOCAL_BY_KEY = new Map(LOCALES.map((l) => [l.nombre.toUpperCase(), l]));
const foldKey = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').replace(/['’`]/g, '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const LOCAL_BY_FOLD = new Map(LOCALES.map((l) => [foldKey(l.nombre), l]));
const LOCAL_RE = /^[\p{L}\p{N}][\p{L}\p{N} &'.,()\/_-]{0,58}$/u;

const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 22);
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const win = () => Math.floor(Date.now() / ROTATE_MS);
const qrToken = (w) => `${w}.${sign('qr' + w)}`;

function validQr(tok) {
  const [w, sig] = String(tok || '').split('.');
  const n = Number(w);
  if (!Number.isInteger(n) || !sig || !safeEq(sig, sign('qr' + n))) return false;
  return win() - n >= 0 && win() - n <= GRACE_WINDOWS;
}

// Token de formulario: firmado y con expiración; el uso único se garantiza al guardar
function newFormToken() {
  const id = crypto.randomBytes(12).toString('base64url');
  const exp = Date.now() + FORM_TTL_MS;
  return `${id}.${exp}.${sign(`f${id}.${exp}`)}`;
}
function checkFormToken(tok) {
  const [id, exp, sig] = String(tok || '').split('.');
  if (!id || !exp || !sig || !safeEq(sig, sign(`f${id}.${exp}`))) return false;
  return Number(exp) > Date.now();
}

// Sesión de administrador (cookie firmada)
const newSession = () => { const exp = Date.now() + SESSION_MS; return `${exp}.${sign('adm' + exp)}`; };
function isAdmin(req) {
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!sig && Number(exp) > Date.now() && safeEq(sig, sign('adm' + exp));
}
const requireAdmin = (req, res, next) => {
  if (isAdmin(req)) return next();
  if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api/')) return res.redirect('/admin');
  res.status(401).json({ error: 'No autorizado' });
};

// Límite simple de intentos por IP
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const k = req.ip + req.path;
  const now = Date.now();
  let h = hits.get(k);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
  if (++h.n > max) return res.status(429).json({ error: 'Demasiados intentos. Espere unos minutos.' });
  next();
};
setInterval(() => { const n = Date.now(); for (const [k, h] of hits) if (h.reset < n) hits.delete(k); }, 60000).unref();

// Almacenamiento: Postgres si hay DATABASE_URL, si no CSV local
let pool = null;
const memKeys = new Set();
const usedForms = new Set();
const csvEscape = (v) => `"${String(v).replace(/"/g, '""')}"`;
const normName = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

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
      nombres TEXT NOT NULL, local TEXT NOT NULL, clave TEXT)`);
    await pool.query('ALTER TABLE asistencia DROP COLUMN IF EXISTS cedula');
    await pool.query('ALTER TABLE asistencia ADD COLUMN IF NOT EXISTS clave TEXT');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS asistencia_clave_idx ON asistencia(clave)');
    await pool.query('CREATE TABLE IF NOT EXISTS asistencia_tokens (id TEXT PRIMARY KEY)');
    return;
  }
  if (fs.existsSync(CSV)) {
    fs.readFileSync(CSV, 'utf8').split('\n').slice(1).filter(Boolean).forEach((l) => {
      const c = parseCsvLine(l);
      memKeys.add(normName(c[1]) + '|' + c[2]);
    });
  } else fs.writeFileSync(CSV, 'fecha,nombres,local\n');
}

function parseCsvLine(l) {
  return [...l.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map((m) => (m[1] ?? m[2]).replace(/""/g, '"'));
}

async function getRows() {
  if (pool) {
    const { rows } = await pool.query('SELECT fecha,nombres,local FROM asistencia ORDER BY id');
    return rows.map((r) => ({ fecha: r.fecha, nombres: r.nombres, local: r.local }));
  }
  return fs.readFileSync(CSV, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
    const c = parseCsvLine(l);
    return { fecha: new Date(c[0]), nombres: c[1], local: c[2] };
  });
}

// Devuelve 'ok' | 'used' (token ya usado) | 'dup' (persona ya registrada en ese local)
async function saveRecord(tokenId, nom, loc) {
  const clave = normName(nom) + '|' + loc;
  if (!pool) {
    if (usedForms.has(tokenId)) return 'used';
    if (memKeys.has(clave)) return 'dup';
    usedForms.add(tokenId);
    memKeys.add(clave);
    fs.appendFileSync(CSV, `${new Date().toISOString()},${csvEscape(nom)},${csvEscape(loc)}\n`);
    return 'ok';
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query('INSERT INTO asistencia_tokens(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [tokenId]);
    if (!t.rowCount) { await client.query('ROLLBACK'); return 'used'; }
    const r = await client.query(
      'INSERT INTO asistencia(nombres,local,clave) VALUES($1,$2,$3) ON CONFLICT (clave) DO NOTHING RETURNING id',
      [nom, loc, clave]);
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

function buildStats(rows) {
  const per = new Map();
  let otros = 0;
  for (const r of rows) {
    if (LOCAL_BY_KEY.has(r.local.toUpperCase())) per.set(r.local, (per.get(r.local) || 0) + 1);
    else otros++;
  }
  const presentes = LOCALES.filter((l) => per.has(l.nombre)).map((l) => ({ local: l.nombre, ct: l.ct, asistentes: per.get(l.nombre) }))
    .sort((a, b) => b.asistentes - a.asistentes || a.local.localeCompare(b.local));
  const ausentes = LOCALES.filter((l) => !per.has(l.nombre)).map((l) => ({ local: l.nombre, ct: l.ct }));
  return {
    totalAsistentes: rows.length,
    otros,
    totalLocales: LOCALES.length,
    localesPresentes: presentes.length,
    localesAusentes: ausentes.length,
    porcentaje: LOCALES.length ? Math.round((presentes.length / LOCALES.length) * 1000) / 10 : 0,
    presentes,
    ausentes,
  };
}

const fmtParts = (d) => {
  const s = new Date(d).toLocaleString('sv-SE', { timeZone: TZ });
  return { fecha: s.slice(0, 10), hora: s.slice(11, 19) };
};

// Preparado para QR: se genera una sola vez por ventana de tiempo
let qrCache = { w: -1, svg: '' };
async function currentQrSvg() {
  const w = win();
  if (qrCache.w !== w) {
    qrCache = { w, svg: await QRCode.toString(`${BASE_URL}/s/${qrToken(w)}`, { type: 'svg', margin: 1, width: 420 }) };
  }
  return qrCache.svg;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '5kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
const priv = (f) => (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'private', f));
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Público (asistentes) ----------
app.get('/', priv('proyector.html'));

app.get('/api/qr', limit(120, 60 * 1000), ah(async (req, res) => {
  const [svg, count] = await Promise.all([currentQrSvg(), pool ? pool.query('SELECT count(*) FROM asistencia').then((r) => Number(r.rows[0].count)) : memKeys.size]);
  res.set('Cache-Control', 'no-store').json({ svg, expiresInMs: ROTATE_MS - (Date.now() % ROTATE_MS), count });
}));

app.get('/api/locales', (req, res) => res.json({ locales: LOCALES.map((l) => l.nombre).sort((a, b) => a.localeCompare(b)) }));

// Escaneo: valida token y redirige al formulario con token propio de un solo uso
app.get('/s/:tok', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!validQr(req.params.tok)) return res.status(410).sendFile(path.join(__dirname, 'public', 'expirado.html'));
  res.redirect(302, `/registro.html#${newFormToken()}`);
});

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}'. -]{3,98}[\p{L}\p{M}.]$/u;
app.post('/api/registro', limit(300, 10 * 60 * 1000), async (req, res) => {
  try {
    const { token, nombres, local } = req.body || {};
    if (typeof token !== 'string' || !checkFormToken(token)) {
      return res.status(403).json({ error: 'Enlace vencido o ya usado. Escanee el QR de nuevo.' });
    }
    const nom = String(nombres || '').trim().replace(/\s+/g, ' ');
    const typed = String(local || '').trim().replace(/\s+/g, ' ');
    const found = LOCAL_BY_FOLD.get(foldKey(typed));
    const loc = found ? found.nombre : LOCAL_RE.test(typed) ? typed.toUpperCase() : null;
    if (!NAME_RE.test(nom) || !nom.includes(' ') || !loc) {
      return res.status(400).json({ error: 'Datos inválidos. Escriba sus nombres completos (solo letras) y el nombre de su local.' });
    }
    const r = await saveRecord(token.split('.')[0], nom, loc);
    if (r === 'used') return res.status(403).json({ error: 'Enlace vencido o ya usado. Escanee el QR de nuevo.' });
    if (r === 'dup') return res.status(409).json({ error: 'Esta persona ya registró asistencia en ese local.' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor. Intente de nuevo.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Administración (protegida con contraseña) ----------
const loginPage = (msg) => `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Administración</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f0ebf8;font-family:Roboto,Arial,sans-serif;color:#202124">
<form method="post" action="/admin/login" style="background:#fff;border:1px solid #dadce0;border-top:10px solid #673ab7;border-radius:8px;padding:24px;width:320px;max-width:90vw">
<h2 style="font-weight:400;margin:0 0 16px">Administración</h2>
<input type="password" name="key" placeholder="Contraseña de administrador" required autofocus style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #dadce0;border-radius:4px;font-size:16px">
<div style="color:#d93025;font-size:14px;margin-top:10px;min-height:1em">${msg || ''}</div>
<button style="margin-top:8px;width:100%;padding:12px;background:#673ab7;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:15px">Entrar</button></form></body></html>`;

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!isAdmin(req)) return res.type('html').send(loginPage());
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});

app.post('/admin/login', limit(8, 10 * 60 * 1000), express.urlencoded({ extended: false, limit: '1kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!safeEq(req.body && req.body.key || '', ADMIN_KEY)) return res.status(401).type('html').send(loginPage('Contraseña incorrecta'));
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `adm=${newSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
  res.redirect(303, '/admin');
});

app.post('/admin/logout', (req, res) => {
  res.set('Set-Cookie', 'adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0').redirect(303, '/admin');
});

app.get('/admin/dashboard', requireAdmin, priv('dashboard.html'));

app.get('/api/stats', requireAdmin, ah(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(buildStats(await getRows()));
}));

app.get('/admin/asistencia.xlsx', requireAdmin, ah(async (req, res) => {
  const ExcelJS = require('exceljs');
  const rows = await getRows();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Asistencia');
  ws.columns = [
    { header: 'Fecha', key: 'f', width: 14 },
    { header: 'Hora de ingreso', key: 'h', width: 16 },
    { header: 'Nombres completos', key: 'n', width: 40 },
    { header: 'Local', key: 'l', width: 32 },
    { header: 'CT', key: 'c', width: 8 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => {
    const { fecha, hora } = fmtParts(r.fecha);
    ws.addRow({ f: fecha, h: hora, n: r.nombres, l: r.local, c: (LOCAL_BY_KEY.get(r.local.toUpperCase()) || {}).ct || '' });
  });
  const st = buildStats(rows);
  const rs = wb.addWorksheet('Resumen por local');
  rs.columns = [
    { header: 'Local', key: 'l', width: 36 },
    { header: 'CT', key: 'c', width: 8 },
    { header: 'Asistentes', key: 'a', width: 12 },
    { header: 'Estado', key: 'e', width: 12 },
  ];
  rs.getRow(1).font = { bold: true };
  st.presentes.forEach((p) => rs.addRow({ l: p.local, c: p.ct, a: p.asistentes, e: 'Asistió' }));
  st.ausentes.forEach((p) => rs.addRow({ l: p.local, c: p.ct, a: 0, e: 'Faltó' }));
  res.set({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="asistencia.xlsx"',
  });
  await wb.xlsx.write(res);
  res.end();
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error del servidor.' });
});

initStore().then(() => app.listen(PORT, () => {
  console.log(`Administración: ${BASE_URL}/admin`);
  console.log(`Almacenamiento: ${pool ? 'Postgres' : 'CSV local'}`);
})).catch((e) => { console.error(e); process.exit(1); });
