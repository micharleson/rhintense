'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.RH_DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'rh-intense.sqlite');
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'company_admin', created_at TEXT NOT NULL,
    UNIQUE(company_id, email)
  );
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '',
    job_title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Ativo', hire_date TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS processes (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title TEXT NOT NULL, area TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'A iniciar', due_date TEXT NOT NULL DEFAULT '', employee_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS deadlines (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title TEXT NOT NULL, due_date TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Pendente', employee_id TEXT, process_id TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE SET NULL,
    FOREIGN KEY(process_id) REFERENCES processes(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS forms (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', fields_json TEXT NOT NULL,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS form_submissions (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    submitted_by TEXT NOT NULL REFERENCES users(id), answers_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    storage_name TEXT NOT NULL, employee_id TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS contact_requests (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL, email TEXT NOT NULL,
    need TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id, name);
  CREATE INDEX IF NOT EXISTS idx_processes_company_due ON processes(company_id, due_date);
  CREATE INDEX IF NOT EXISTS idx_deadlines_company_due ON deadlines(company_id, due_date);
  CREATE INDEX IF NOT EXISTS idx_documents_company ON documents(company_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`);

const statements = {
  session: db.prepare(`SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.id, u.company_id, u.name, u.email, u.role, c.name AS company_name
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN companies c ON c.id=u.company_id WHERE s.token_hash=?`),
  audit: db.prepare('INSERT INTO audit_logs(id,company_id,user_id,action,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)'),
};
const rateLimits = new Map();

function now() { return new Date().toISOString(); }
function uid() { return crypto.randomUUID(); }
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function text(value, name, max = 160, required = false) {
  if (typeof value !== 'string') value = value == null ? '' : String(value);
  value = value.trim();
  if (required && !value) fail(400, `${name} é obrigatório.`);
  if (value.length > max) fail(400, `${name} deve ter no máximo ${max} caracteres.`);
  return value;
}
function emailValue(value) {
  const result = text(value, 'E-mail', 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, 'Informe um e-mail válido.');
  return result;
}
function dateValue(value, name, required = false) {
  const result = text(value, name, 10, required);
  if (result) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
    const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!parsed || parsed.toISOString().slice(0, 10) !== result) fail(400, `${name} deve usar uma data válida no formato AAAA-MM-DD.`);
  }
  return result;
}
function enumValue(value, allowed, name, fallback) {
  const result = text(value || fallback, name, 40, true);
  if (!allowed.includes(result)) fail(400, `${name} inválido.`);
  return result;
}
function safeEqual(a, b) {
  const left = Buffer.from(a || ''); const right = Buffer.from(b || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$16384$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(password, encoded) {
  const [scheme, cost, saltHex, keyHex] = String(encoded).split('$');
  if (scheme !== 'scrypt' || cost !== '16384' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return safeEqual(key, Buffer.from(keyHex, 'hex'));
}
function setCookie(res, name, value, options = {}) {
  const attrs = [`${name}=${value}`, 'Path=/', 'SameSite=Lax'];
  if (options.httpOnly) attrs.push('HttpOnly');
  if (options.maxAge !== undefined) attrs.push(`Max-Age=${options.maxAge}`);
  if (isProduction) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearCookie(res) { setCookie(res, 'rh_session', '', { httpOnly: true, maxAge: 0 }); }
function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}
function parseCookies(header = '') {
  const pairs = header.split(';').map(part => part.trim()).filter(part => part.includes('=')).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  });
  return Object.fromEntries(pairs);
}
function rateLimit(req, route, max = 12, windowMs = 15 * 60 * 1000) {
  const ip = req.socket.remoteAddress || 'unknown'; const key = `${route}:${ip}`; const ts = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || entry.resetAt <= ts) entry = { count: 0, resetAt: ts + windowMs };
  entry.count += 1; rateLimits.set(key, entry);
  if (rateLimits.size > 5000) for (const [k, v] of rateLimits) if (v.resetAt <= ts) rateLimits.delete(k);
  if (entry.count > max) fail(429, 'Muitas tentativas. Aguarde e tente novamente.');
}
async function readBody(req, limit = MAX_JSON_BYTES) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'O conteúdo enviado é muito grande.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'O corpo da solicitação não contém JSON válido.'); }
}
function getAuth(req) {
  const token = parseCookies(req.headers.cookie).rh_session;
  if (!token) return null;
  const row = statements.session.get(crypto.createHash('sha256').update(token).digest('hex'));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(row.session_id);
    return null;
  }
  return row;
}
function requireAuth(auth) { if (!auth) fail(401, 'Faça login para continuar.'); return auth; }
function requireWrite(auth) { requireAuth(auth); if (!['company_admin', 'manager'].includes(auth.role)) fail(403, 'Seu perfil não permite esta ação.'); }
function requireAdmin(auth) { requireAuth(auth); if (auth.role !== 'company_admin') fail(403, 'Apenas a pessoa administradora pode alterar estes dados.'); }
function verifyOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) fail(403, 'Origem da solicitação não permitida.');
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') fail(403, 'Origem da solicitação não permitida.');
}
function verifyCsrf(req, auth) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  verifyOrigin(req);
  if (!auth) return;
  if (!safeEqual(req.headers['x-csrf-token'], auth.csrf_token)) fail(403, 'Token de segurança ausente ou inválido. Atualize a página e tente novamente.');
}
function audit(auth, action, entityType, entityId) {
  statements.audit.run(uid(), auth.company_id, auth.id, action, entityType, entityId, now());
}
function companyRecord(auth) {
  return db.prepare('SELECT id,name,created_at AS createdAt FROM companies WHERE id=?').get(auth.company_id);
}
function scopedRow(table, id, companyId) {
  return db.prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).get(id, companyId);
}
function validateEmployeeRelation(employeeId, companyId) {
  if (!employeeId) return null;
  const id = text(employeeId, 'Funcionário', 80);
  if (!db.prepare('SELECT id FROM employees WHERE id=? AND company_id=?').get(id, companyId)) fail(400, 'Funcionário não encontrado nesta empresa.');
  return id;
}
function toEmployee(row) { return { id: row.id, name: row.name, email: row.email, department: row.department, jobTitle: row.job_title, status: row.status, hireDate: row.hire_date, createdAt: row.created_at }; }
function toProcess(row) { return { id: row.id, title: row.title, area: row.area, nextAction: row.next_action, status: row.status, dueDate: row.due_date, employeeId: row.employee_id, createdAt: row.created_at, updatedAt: row.updated_at }; }
function toDeadline(row) { return { id: row.id, title: row.title, dueDate: row.due_date, description: row.description, status: row.status, employeeId: row.employee_id, processId: row.process_id, createdAt: row.created_at }; }
function toForm(row) { return { id: row.id, title: row.title, description: row.description, fields: JSON.parse(row.fields_json), createdAt: row.created_at }; }
function toDocument(row) { return { id: row.id, name: row.name, mimeType: row.mime_type, sizeBytes: row.size_bytes, employeeId: row.employee_id, createdAt: row.created_at }; }
function listScoped(sql, companyId, mapper = x => x) { return db.prepare(sql).all(companyId).map(mapper); }
function jsonFields(value) {
  if (!Array.isArray(value) || value.length > 30) fail(400, 'Informe até 30 campos para o formulário.');
  const fields = value.map((field, index) => {
    const label = text(field?.label, `Campo ${index + 1}`, 80, true);
    const type = enumValue(field?.type || 'text', ['text', 'email', 'date', 'textarea'], 'Tipo do campo', 'text');
    return { label, type, required: Boolean(field?.required) };
  });
  if (!fields.length) fail(400, 'Adicione pelo menos um campo ao formulário.');
  return fields;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .run(uid(), userId, crypto.createHash('sha256').update(token).digest('hex'), csrf, expiresAt, now());
  setCookie(res, 'rh_session', token, { httpOnly: true, maxAge: Math.floor(SESSION_TTL_MS / 1000) });
  return csrf;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  let auth = getAuth(req);
  if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });

  if (pathname.startsWith('/api/auth/')) {
    if (req.method === 'POST') verifyOrigin(req);
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      rateLimit(req, 'register', 8);
      const body = await readBody(req);
      const companyName = text(body.companyName, 'Nome da empresa', 140, true);
      const name = text(body.name, 'Nome', 120, true);
      const email = emailValue(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 12 || password.length > 128) fail(400, 'A senha deve ter entre 12 e 128 caracteres.');
      const companyId = uid(); const userId = uid(); const stamp = now(); const passwordHash = hashPassword(password);
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO companies(id,name,created_at) VALUES(?,?,?)').run(companyId, companyName, stamp);
        db.prepare('INSERT INTO users(id,company_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)').run(userId, companyId, name, email, passwordHash, 'company_admin', stamp);
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} if (String(error.message).includes('UNIQUE')) fail(409, 'Já existe uma conta com esse e-mail nesta empresa.'); throw error; }
      const csrfToken = createSession(res, userId);
      return sendJson(res, 201, { csrfToken, user: { id: userId, companyId, name, email, role: 'company_admin' }, company: { id: companyId, name: companyName } });
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      rateLimit(req, 'login', 12);
      const body = await readBody(req); const email = emailValue(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      const rows = db.prepare('SELECT * FROM users WHERE email=?').all(email);
      const user = rows.find(row => verifyPassword(password, row.password_hash));
      if (!user) fail(401, 'E-mail ou senha incorretos.');
      const csrfToken = createSession(res, user.id);
      const company = db.prepare('SELECT id,name FROM companies WHERE id=?').get(user.company_id);
      return sendJson(res, 200, { csrfToken, user: { id: user.id, companyId: user.company_id, name: user.name, email: user.email, role: user.role }, company });
    }
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      requireAuth(auth);
      return sendJson(res, 200, { csrfToken: auth.csrf_token, user: { id: auth.id, companyId: auth.company_id, name: auth.name, email: auth.email, role: auth.role }, company: { id: auth.company_id, name: auth.company_name } });
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      requireAuth(auth); verifyCsrf(req, auth);
      db.prepare('DELETE FROM sessions WHERE id=?').run(auth.session_id); clearCookie(res);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Rota não encontrada.' });
  }

  if (pathname === '/api/contact' && req.method === 'POST') {
    verifyOrigin(req); rateLimit(req, 'contact', 5, 60 * 60 * 1000);
    const body = await readBody(req);
    const name = text(body.name, 'Nome', 120, true); const company = text(body.company, 'Empresa', 140, true);
    const email = emailValue(body.email); const need = text(body.need, 'Assunto', 500);
    db.prepare('INSERT INTO contact_requests(id,name,company,email,need,created_at) VALUES(?,?,?,?,?,?)').run(uid(), name, company, email, need, now());
    return sendJson(res, 201, { ok: true, message: 'Solicitação registrada com sucesso.' });
  }

  if (pathname.startsWith('/api/')) {
    requireAuth(auth); verifyCsrf(req, auth);
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, pathname.includes('/documents') ? 15 * 1024 * 1024 : MAX_JSON_BYTES) : {};
    if (pathname === '/api/companies' && req.method === 'GET') return sendJson(res, 200, companyRecord(auth));
    if (pathname === '/api/companies' && req.method === 'PATCH') {
      requireAdmin(auth); const name = text(body.name, 'Nome da empresa', 140, true);
      db.prepare('UPDATE companies SET name=? WHERE id=?').run(name, auth.company_id); audit(auth, 'update', 'company', auth.company_id);
      return sendJson(res, 200, companyRecord(auth));
    }

    if (pathname === '/api/employees' && req.method === 'GET') {
      return sendJson(res, 200, listScoped('SELECT * FROM employees WHERE company_id=? ORDER BY name', auth.company_id, toEmployee));
    }
    if (pathname === '/api/employees' && req.method === 'POST') {
      requireWrite(auth); const id = uid(); const stamp = now();
      const record = { name: text(body.name, 'Nome', 120, true), email: body.email ? emailValue(body.email) : '', department: text(body.department, 'Área', 100), job_title: text(body.jobTitle, 'Cargo', 100), status: enumValue(body.status, ['Ativo', 'Inativo', 'Afastado'], 'Situação', 'Ativo'), hire_date: dateValue(body.hireDate, 'Data de admissão') };
      db.prepare('INSERT INTO employees(id,company_id,name,email,department,job_title,status,hire_date,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, auth.company_id, record.name, record.email, record.department, record.job_title, record.status, record.hire_date, stamp);
      audit(auth, 'create', 'employee', id); return sendJson(res, 201, toEmployee(scopedRow('employees', id, auth.company_id)));
    }
    let match = pathname.match(/^\/api\/employees\/([^/]+)$/);
    if (match && req.method === 'PATCH') {
      requireWrite(auth); const id = decodeURIComponent(match[1]); const old = scopedRow('employees', id, auth.company_id); if (!old) fail(404, 'Funcionário não encontrado.');
      const next = { name: text(body.name ?? old.name, 'Nome', 120, true), email: body.email === undefined ? old.email : (body.email ? emailValue(body.email) : ''), department: text(body.department ?? old.department, 'Área', 100), job_title: text(body.jobTitle ?? old.job_title, 'Cargo', 100), status: enumValue(body.status ?? old.status, ['Ativo', 'Inativo', 'Afastado'], 'Situação', old.status), hire_date: dateValue(body.hireDate ?? old.hire_date, 'Data de admissão') };
      db.prepare('UPDATE employees SET name=?,email=?,department=?,job_title=?,status=?,hire_date=? WHERE id=? AND company_id=?').run(next.name,next.email,next.department,next.job_title,next.status,next.hire_date,id,auth.company_id);
      audit(auth, 'update', 'employee', id); return sendJson(res, 200, toEmployee(scopedRow('employees', id, auth.company_id)));
    }
    if (match && req.method === 'DELETE') {
      requireAdmin(auth); const id = decodeURIComponent(match[1]); const row = scopedRow('employees', id, auth.company_id); if (!row) fail(404, 'Funcionário não encontrado.');
      db.prepare('DELETE FROM employees WHERE id=? AND company_id=?').run(id, auth.company_id); audit(auth, 'delete', 'employee', id); return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/processes' && req.method === 'GET') return sendJson(res, 200, listScoped('SELECT * FROM processes WHERE company_id=? ORDER BY due_date,title', auth.company_id, toProcess));
    if (pathname === '/api/processes' && req.method === 'POST') {
      requireWrite(auth); const id = uid(); const stamp = now(); const employeeId = validateEmployeeRelation(body.employeeId, auth.company_id);
      db.prepare('INSERT INTO processes(id,company_id,title,area,next_action,status,due_date,employee_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,auth.company_id,text(body.title,'Processo',180,true),text(body.area,'Área',100),text(body.nextAction,'Próxima ação',500),enumValue(body.status,['A iniciar','Em andamento','Aguardando retorno','Concluído','Cancelado'],'Status','A iniciar'),dateValue(body.dueDate,'Prazo'),employeeId,stamp,stamp);
      audit(auth, 'create', 'process', id); return sendJson(res, 201, toProcess(scopedRow('processes', id, auth.company_id)));
    }
    match = pathname.match(/^\/api\/processes\/([^/]+)$/);
    if (match && req.method === 'PATCH') {
      requireWrite(auth); const id = decodeURIComponent(match[1]); const old = scopedRow('processes',id,auth.company_id); if (!old) fail(404,'Processo não encontrado.');
      const employeeId = body.employeeId === undefined ? old.employee_id : validateEmployeeRelation(body.employeeId,auth.company_id);
      db.prepare('UPDATE processes SET title=?,area=?,next_action=?,status=?,due_date=?,employee_id=?,updated_at=? WHERE id=? AND company_id=?').run(text(body.title ?? old.title,'Processo',180,true),text(body.area ?? old.area,'Área',100),text(body.nextAction ?? old.next_action,'Próxima ação',500),enumValue(body.status ?? old.status,['A iniciar','Em andamento','Aguardando retorno','Concluído','Cancelado'],'Status',old.status),dateValue(body.dueDate ?? old.due_date,'Prazo'),employeeId,now(),id,auth.company_id);
      audit(auth,'update','process',id); return sendJson(res,200,toProcess(scopedRow('processes',id,auth.company_id)));
    }
    if (match && req.method === 'DELETE') {
      requireWrite(auth); const id=decodeURIComponent(match[1]); if (!scopedRow('processes',id,auth.company_id)) fail(404,'Processo não encontrado.');
      db.prepare('DELETE FROM processes WHERE id=? AND company_id=?').run(id,auth.company_id); audit(auth,'delete','process',id); return sendJson(res,200,{ok:true});
    }

    if (pathname === '/api/deadlines' && req.method === 'GET') return sendJson(res,200,listScoped('SELECT * FROM deadlines WHERE company_id=? ORDER BY due_date,title',auth.company_id,toDeadline));
    if (pathname === '/api/deadlines' && req.method === 'POST') {
      requireWrite(auth); const id=uid(); const employeeId=validateEmployeeRelation(body.employeeId,auth.company_id); let processId=null;
      if(body.processId){ processId=text(body.processId,'Processo',80); if(!scopedRow('processes',processId,auth.company_id)) fail(400,'Processo não encontrado nesta empresa.'); }
      db.prepare('INSERT INTO deadlines(id,company_id,title,due_date,description,status,employee_id,process_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,auth.company_id,text(body.title,'Prazo',180,true),dateValue(body.dueDate,'Data do prazo',true),text(body.description,'Descrição',1000),enumValue(body.status,['Pendente','Concluído','Cancelado'],'Status','Pendente'),employeeId,processId,now());
      audit(auth,'create','deadline',id); return sendJson(res,201,toDeadline(scopedRow('deadlines',id,auth.company_id)));
    }
    match=pathname.match(/^\/api\/deadlines\/([^/]+)$/);
    if(match && req.method==='PATCH'){
      requireWrite(auth); const id=decodeURIComponent(match[1]); const old=scopedRow('deadlines',id,auth.company_id); if(!old) fail(404,'Prazo não encontrado.');
      const employeeId=body.employeeId===undefined?old.employee_id:validateEmployeeRelation(body.employeeId,auth.company_id); let processId=body.processId===undefined?old.process_id:(body.processId||null);
      if(processId && !scopedRow('processes',processId,auth.company_id)) fail(400,'Processo não encontrado nesta empresa.');
      db.prepare('UPDATE deadlines SET title=?,due_date=?,description=?,status=?,employee_id=?,process_id=? WHERE id=? AND company_id=?').run(text(body.title??old.title,'Prazo',180,true),dateValue(body.dueDate??old.due_date,'Data do prazo',true),text(body.description??old.description,'Descrição',1000),enumValue(body.status??old.status,['Pendente','Concluído','Cancelado'],'Status',old.status),employeeId,processId,id,auth.company_id);
      audit(auth,'update','deadline',id); return sendJson(res,200,toDeadline(scopedRow('deadlines',id,auth.company_id)));
    }
    if(match && req.method==='DELETE'){
      requireWrite(auth); const id=decodeURIComponent(match[1]); if(!scopedRow('deadlines',id,auth.company_id)) fail(404,'Prazo não encontrado.');
      db.prepare('DELETE FROM deadlines WHERE id=? AND company_id=?').run(id,auth.company_id); audit(auth,'delete','deadline',id); return sendJson(res,200,{ok:true});
    }

    if (pathname === '/api/forms' && req.method === 'GET') return sendJson(res,200,listScoped('SELECT * FROM forms WHERE company_id=? ORDER BY created_at DESC',auth.company_id,toForm));
    if (pathname === '/api/forms' && req.method === 'POST') {
      requireWrite(auth); const id=uid(); const fields=jsonFields(body.fields);
      db.prepare('INSERT INTO forms(id,company_id,title,description,fields_json,created_at,created_by) VALUES(?,?,?,?,?,?,?)').run(id,auth.company_id,text(body.title,'Título',140,true),text(body.description,'Descrição',500),JSON.stringify(fields),now(),auth.id);
      audit(auth,'create','form',id); return sendJson(res,201,toForm(scopedRow('forms',id,auth.company_id)));
    }
    match=pathname.match(/^\/api\/forms\/([^/]+)\/submissions$/);
    if(match && req.method==='POST'){
      requireWrite(auth); const formId=decodeURIComponent(match[1]); const form=scopedRow('forms',formId,auth.company_id); if(!form) fail(404,'Formulário não encontrado.');
      if(!body.answers || typeof body.answers!=='object' || Array.isArray(body.answers)) fail(400,'Respostas inválidas.');
      const fields=JSON.parse(form.fields_json); const answers={};
      for(const field of fields){const val=text(body.answers[field.label],field.label,4000,field.required); answers[field.label]=val;}
      const id=uid(); db.prepare('INSERT INTO form_submissions(id,company_id,form_id,submitted_by,answers_json,created_at) VALUES(?,?,?,?,?,?)').run(id,auth.company_id,formId,auth.id,JSON.stringify(answers),now());
      audit(auth,'submit','form',formId); return sendJson(res,201,{id,formId,answers,createdAt:now()});
    }
    if(match && req.method==='GET'){
      requireAuth(auth); const formId=decodeURIComponent(match[1]); if(!scopedRow('forms',formId,auth.company_id)) fail(404,'Formulário não encontrado.');
      const rows=db.prepare('SELECT id,form_id,submitted_by,answers_json,created_at FROM form_submissions WHERE form_id=? AND company_id=? ORDER BY created_at DESC').all(formId,auth.company_id).map(row=>({id:row.id,formId:row.form_id,submittedBy:row.submitted_by,answers:JSON.parse(row.answers_json),createdAt:row.created_at}));
      return sendJson(res,200,rows);
    }

    if (pathname === '/api/documents' && req.method === 'GET') return sendJson(res,200,listScoped('SELECT * FROM documents WHERE company_id=? ORDER BY created_at DESC',auth.company_id,toDocument));
    if (pathname === '/api/documents' && req.method === 'POST'){
      requireWrite(auth); const name=text(body.name,'Nome do arquivo',180,true); const mimeType=text(body.mimeType||'application/octet-stream','Tipo do arquivo',100); const encoded=String(body.contentBase64||'');
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail(400,'Arquivo inválido.');
      const data=Buffer.from(encoded,'base64'); if(!data.length || data.length>MAX_UPLOAD_BYTES) fail(413,'O arquivo deve ter até 10 MB.');
      const employeeId=validateEmployeeRelation(body.employeeId,auth.company_id); const id=uid(); const storageName=`${id}.bin`; const filePath=path.join(UPLOAD_DIR,storageName);
      fs.writeFileSync(filePath,data,{flag:'wx',mode:0o600});
      try{db.prepare('INSERT INTO documents(id,company_id,name,mime_type,size_bytes,storage_name,employee_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,auth.company_id,name,mimeType,data.length,storageName,employeeId,auth.id,now());}
      catch(error){fs.rmSync(filePath,{force:true});throw error;}
      audit(auth,'upload','document',id); return sendJson(res,201,toDocument(scopedRow('documents',id,auth.company_id)));
    }
    match=pathname.match(/^\/api\/documents\/([^/]+)(\/download)?$/);
    if(match && req.method==='GET'){
      const id=decodeURIComponent(match[1]); const row=scopedRow('documents',id,auth.company_id); if(!row) fail(404,'Documento não encontrado.');
      const filePath=path.join(UPLOAD_DIR,row.storage_name); if(!fs.existsSync(filePath)) fail(404,'Arquivo não encontrado no armazenamento.');
      res.writeHead(200,{'Content-Type':row.mime_type,'Content-Length':row.size_bytes,'Content-Disposition':`attachment; filename="${encodeURIComponent(row.name).replace(/"/g,'%22')}"`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});
      fs.createReadStream(filePath).pipe(res); return;
    }
    if(match && req.method==='DELETE'){
      requireAdmin(auth); const id=decodeURIComponent(match[1]); const row=scopedRow('documents',id,auth.company_id); if(!row) fail(404,'Documento não encontrado.');
      db.prepare('DELETE FROM documents WHERE id=? AND company_id=?').run(id,auth.company_id); fs.rmSync(path.join(UPLOAD_DIR,row.storage_name),{force:true}); audit(auth,'delete','document',id); return sendJson(res,200,{ok:true});
    }
    return sendJson(res,404,{error:'Rota não encontrada.'});
  }
  return null;
}

function sendStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendJson(res,404,{error:'Página não encontrada.'});
  const ext=path.extname(filePath); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Content-Length':fs.statSync(filePath).size,'Cache-Control':ext==='.html'?'no-cache':'public, max-age=300'});
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')){const handled=await handleApi(req,res,url); if(handled===null&&!res.headersSent) sendJson(res,404,{error:'Rota não encontrada.'}); return;}
    if(['GET','HEAD'].includes(req.method)) return sendStatic(req,res,url);
    return sendJson(res,405,{error:'Método não permitido.'});
  }catch(error){
    const status=error.status||500;
    if(status>=500) console.error('Request failed:',error.message);
    if(!res.headersSent) sendJson(res,status,{error:status>=500?'Erro interno. Tente novamente.':error.message}); else res.destroy();
  }
});
server.listen(PORT,()=>console.log(`RH Intense disponível em http://localhost:${PORT}`));
function shutdown(){server.close(()=>{db.close();process.exit(0);});}
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
