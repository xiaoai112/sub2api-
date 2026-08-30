'use strict';
/**
 * sub2api 抽奖服务
 * - 用户身份：校验 sub2api 签发的 JWT（HS256，密钥取自 sub2api config.yaml）
 * - 抽奖资格：累计充值总额（全部历史 COMPLETED 且 order_type=balance 的订单）
 * - 中奖发放：调用 sub2api Admin API 生成 balance 类型兑换码
 * - 数据落盘：本地 JSON（原子写），不触碰 sub2api 的 PostgreSQL
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'records.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 密钥加载：仅驻留内存，绝不返回给前端 ----------
function loadJwtSecret() {
  const raw = fs.readFileSync(CFG.sub2apiConfigPath, 'utf8');
  // config.yaml 中 jwt: 段下的 secret
  const m = raw.match(/jwt:\s*\n(?:[ \t]+.*\n)*?[ \t]+secret:\s*([^\s#]+)/);
  if (!m) throw new Error('无法从 sub2api config.yaml 解析 jwt.secret');
  return m[1].trim();
}
function loadAdminKey() {
  return fs.readFileSync(CFG.adminKeyPath, 'utf8').trim();
}
const JWT_SECRET = loadJwtSecret();
const ADMIN_KEY = loadAdminKey();

// ---------- 日志 ----------
function log(level, msg, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(), level, msg, ...(extra || {}),
  });
  console.log(line);
}
function audit(event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  try { fs.appendFileSync(AUDIT_FILE, line); } catch (e) {
    log('error', 'audit_write_failed', { err: e.message });
  }
}

// ---------- 简易持久化（单进程，原子写） ----------
let DB = { users: {}, seq: 0 };
function dbLoad() {
  if (fs.existsSync(DB_FILE)) {
    try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {
      log('error', 'db_corrupt_backup_and_reset', { err: e.message });
      fs.renameSync(DB_FILE, DB_FILE + '.corrupt.' + Date.now());
    }
  }
  if (!DB.users) DB.users = {};
  if (!DB.seq) DB.seq = 0;
}
function dbSave() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB));
  fs.renameSync(tmp, DB_FILE);
}
dbLoad();

function userRec(uid) {
  const k = String(uid);
  if (!DB.users[k]) DB.users[k] = { total: 0, records: [] };
  return DB.users[k];
}

// ---------- 时间工具：按配置时区计算“今天” ----------
function todayKey() {
  const off = CFG.timezoneOffsetHours * 3600 * 1000;
  return new Date(Date.now() + off).toISOString().slice(0, 10);
}

// ---------- sub2api Admin API 调用 ----------
function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(CFG.sub2apiBase);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: base.hostname,
      port: base.port || 80,
      path: urlPath,
      method,
      timeout: 15000,
      headers: Object.assign(
        { 'X-API-Key': ADMIN_KEY, Accept: 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
      ),
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) { /* 保留原文 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        reject(new Error('sub2api ' + res.statusCode + ' ' + urlPath + ' ' + buf.slice(0, 200)));
      });
    });
    req.on('timeout', () => req.destroy(new Error('sub2api 请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function apiRequestWithBearer(method, urlPath, token) {
  return new Promise((resolve, reject) => {
    const base = new URL(CFG.sub2apiBase);
    const req = http.request({
      hostname: base.hostname,
      port: base.port || 80,
      path: urlPath,
      method,
      timeout: 15000,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) { /* 保留原文 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const error = new Error('sub2api ' + res.statusCode + ' ' + urlPath);
        error.statusCode = res.statusCode;
        reject(error);
      });
    });
    req.on('timeout', () => req.destroy(new Error('sub2api 请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function maskEmail(email) {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at <= 0 || at === value.length - 1) return '用户';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
  return visible + '*'.repeat(Math.max(2, Math.min(6, local.length))) + '@' + domain;
}

async function buildWinBroadcast(token) {
  const auditLines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  const latest = new Map();
  for (const line of auditLines) {
    try {
      const event = JSON.parse(line);
      if (event.event === 'prize_granted' && event.userId !== undefined && Number(event.value) > 0) {
        latest.set(String(event.userId), event);
      }
    } catch (_) { /* 忽略损坏的单行审计数据 */ }
  }
  if (!latest.size) return [];

   const resp = await apiRequest('GET', '/api/v1/admin/users?page=1&page_size=100');
  const data = (resp && resp.data) || {};
  const users = Array.isArray(data) ? data : (data.items || data.users || []);
  const byId = new Map(users.map((u) => [String(u.id || u.user_id), u]));
  return Array.from(latest.values())
    .map((event) => {
      const user = byId.get(String(event.userId));
      return {
        user: maskEmail(user && (user.email || user.email_address)),
        prize: event.prize || (Number(event.value) === 0.1 ? '谢谢参与' : '中奖'),
        value: Number(event.value),
        time: event.ts,
      };
    })
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

// ---------- 累计充值总额：全部历史 COMPLETED + order_type=balance ----------
async function fetchTotalRecharge(userId) {
  let page = 1;
  const pageSize = 100;
  let total = 0;
  let pages = 1;
  do {
    const q = `/api/v1/admin/payment/orders?page=${page}&page_size=${pageSize}`;
    const resp = await apiRequest('GET', q);
    const data = (resp && resp.data) || {};
    const items = data.items || [];
    for (const it of items) {
      // 双重校验：接口过滤之外再本地确认，避免参数被忽略导致误算
      if (String(it.status).toUpperCase() !== 'COMPLETED') continue;
      if (it.order_type && it.order_type !== 'balance') continue;
      if (String(it.user_id) !== String(userId)) continue;
      const amt = Number(it.amount);
      if (Number.isFinite(amt) && amt > 0) total += amt;
    }
    pages = Number(data.pages) || 1;
    page += 1;
    if (page > 200) break; // 兜底，防止异常分页导致死循环
  } while (page <= pages);
  return total;
}

// ---------- 档位换算 ----------
function entitledDraws(total) {
  if (!(total >= CFG.minRechargeThreshold)) return 0;
  for (const t of CFG.tiers) {
    if (total >= t.min) return t.draws;
  }
  return 0;
}

// ---------- 开奖：加权随机 ----------
function drawPrize() {
  const sum = CFG.prizes.reduce((a, p) => a + p.weight, 0);
  // 使用加密级随机，避免可预测
  const rnd = require('crypto').randomInt(0, sum * 1000) / 1000;
  let acc = 0;
  for (const p of CFG.prizes) {
    acc += p.weight;
    if (rnd < acc) return p;
  }
  return CFG.prizes[CFG.prizes.length - 1];
}

// ---------- 生成兑换码 ----------
async function generateRedeemCode(value) {
  const body = { count: 1, type: 'balance', value: Number(value) };
  if (CFG.codeExpiresInDays > 0) body.expires_in_days = CFG.codeExpiresInDays;
  const resp = await apiRequest('POST', '/api/v1/admin/redeem-codes/generate', body);
  const d = (resp && resp.data) || {};
  // 兼容多种返回结构
  let code = null;
  if (Array.isArray(d) && d.length) code = d[0].code || d[0];
  else if (Array.isArray(d.codes) && d.codes.length) code = d.codes[0].code || d.codes[0];
  else if (Array.isArray(d.items) && d.items.length) code = d.items[0].code || d.items[0];
  else if (d.code) code = d.code;
  if (!code || typeof code !== 'string') {
    throw new Error('兑换码生成返回结构无法解析: ' + JSON.stringify(resp).slice(0, 300));
  }
  return code;
}

async function listRedeemCodes() {
  const resp = await apiRequest('GET', '/api/v1/admin/redeem-codes?page=1&page_size=100');
  return ((resp && resp.data) || {}).items || [];
}

async function mergeUserRewards(user) {
  const rec = userRec(user.id);
  const pending = rec.records.filter((r) => r.value > 0 && r.code && !r.mergedInto);
  const rows = await listRedeemCodes();
  const byCode = new Map(rows.map((r) => [r.code, r]));

  // 先筛出真正未使用的新中奖码；已兑换旧码不参与任何汇总。
  const pendingUnused = pending.filter((r) => {
    const row = byCode.get(r.code);
    return row && row.status === 'unused';
  });

  // 没有新中奖时，直接返回现有未使用合并码，保证重复点击幂等。
  if (!pendingUnused.length) {
    for (const r of rec.records) {
      if (!r.mergedInto || r.supersededBy) continue;
      const row = byCode.get(r.mergedInto);
      if (row && row.status === 'unused') {
        return { code: r.mergedInto, value: Number(row.value || 0) };
      }
    }
    return { code: null, value: 0 };
  }

  // 收集历史合并码：只有仍未使用的合并码才可继续并入新中奖额度。
  const oldMergedCodes = [];
  const seenMerged = new Set();
  for (const r of rec.records) {
    if (!r.mergedInto || r.supersededBy || seenMerged.has(r.mergedInto)) continue;
    seenMerged.add(r.mergedInto);
    const row = byCode.get(r.mergedInto);
    if (row && row.status === 'unused') {
      oldMergedCodes.push({ code: r.mergedInto, id: row.id, value: Number(row.value || 0) });
    }
  }

  const sources = [
    ...oldMergedCodes.map((r) => ({ ...r, record: null })),
    ...pendingUnused.map((r) => ({ code: r.code, id: byCode.get(r.code).id, value: Number(r.value || 0), record: r })),
  ];
  const value = sources.reduce((sum, r) => sum + r.value, 0);
  if (!sources.length || value <= 0) return { code: null, value: 0 };

  // 先生成最新总额兑换码，成功后才标记来源并删除旧码。
  const mergedCode = await generateRedeemCode(value);
  const mergedAt = new Date().toISOString();
  for (const source of sources) {
    if (source.record) {
      source.record.mergedInto = mergedCode;
      source.record.mergedAt = mergedAt;
    } else {
      for (const r of rec.records) {
        if (r.mergedInto === source.code) {
          r.supersededBy = mergedCode;
          r.supersededAt = mergedAt;
        }
      }
    }
  }
  dbSave();

  for (const source of sources) {
    try { await apiRequest('DELETE', `/api/v1/admin/redeem-codes/${source.id}`); }
    catch (e) { audit({ event: 'old_code_cleanup_failed', userId: user.id, oldCode: source.code, err: e.message }); }
  }
  audit({ event: 'rewards_merged', userId: user.id, value, sourceCount: sources.length, code: mergedCode });
  return { code: mergedCode, value };
}

// ---------- 鉴权中间件：校验 sub2api 签发的 JWT ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'NOT_LOGGED_IN', message: '请先登录' });
  }
  const token = h.slice(7).trim();
  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN', message: '登录已失效，请重新登录' });
  }
  // 仅接受 access token，拒绝 refresh token 越权使用
  if (claims.token_type && claims.token_type !== 'access') {
    return res.status(401).json({ ok: false, error: 'WRONG_TOKEN_TYPE', message: '凭据类型不正确' });
  }
  const uid = claims.user_id;
  if (uid === undefined || uid === null || uid === '') {
    return res.status(401).json({ ok: false, error: 'NO_USER_ID', message: '凭据缺少用户标识' });
  }
  req.user = { id: uid, username: claims.username || '', email: claims.email || '' };
  next();
}

// ---------- 并发锁：同一用户串行处理，防并发重复消耗次数 ----------
const locks = new Map();
async function withUserLock(uid, fn) {
  const key = String(uid);
  while (locks.get(key)) await locks.get(key);
  let release;
  const p = new Promise((r) => { release = r; });
  locks.set(key, p);
  try { return await fn(); } finally { locks.delete(key); release(); }
}

// ---------- 速率异常告警（不阻断） ----------
const recentGrants = [];
function rateAlertCheck() {
  const now = Date.now();
  const win = CFG.alertRateWindowMinutes * 60 * 1000;
  while (recentGrants.length && now - recentGrants[0] > win) recentGrants.shift();
  recentGrants.push(now);
  if (recentGrants.length > CFG.alertRateThreshold) {
    log('warn', 'grant_rate_anomaly', {
      count: recentGrants.length,
      windowMinutes: CFG.alertRateWindowMinutes,
      hint: '短时间内发放量异常，请核查是否存在刷奖行为',
    });
  }
}

// ---------- 汇总用户抽奖状态 ----------
async function buildStatus(user) {
  const total = await fetchTotalRecharge(user.id);
  const entitled = entitledDraws(total);
  const rec = userRec(user.id);
  const today = todayKey();
  const usedTotal = rec.records.length;
  const usedToday = rec.records.filter((r) => r.day === today).length;
  const remainByTier = Math.max(0, entitled - usedTotal);
  const remainToday = Math.max(0, CFG.dailyDrawLimit - usedToday);
  const mergedRewards = [];
  try {
    const rows = await listRedeemCodes();
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const mergedSeen = new Set();
    for (const r of rec.records) {
      if (!r.mergedInto || r.supersededBy || mergedSeen.has(r.mergedInto)) continue;
      mergedSeen.add(r.mergedInto);
      const row = byCode.get(r.mergedInto);
      // 兑换完成后不再返回，前端也就不会继续展示旧结果。
      if (row && row.status === 'unused') {
        mergedRewards.push({
          time: r.mergedAt || r.time,
          value: Number(row.value || 0),
          code: r.mergedInto,
        });
      }
    }
  } catch (e) {
    log('warn', 'merged_reward_status_check_failed', { uid: user.id, err: e.message });
  }
  return {
    userId: user.id,
    username: user.username,
    totalRecharge: total,
    threshold: CFG.minRechargeThreshold,
    entitledDraws: entitled,
    usedTotal,
    usedToday,
    dailyLimit: CFG.dailyDrawLimit,
    remaining: Math.min(remainByTier, remainToday),
    remainingByTier: remainByTier,
    remainingToday: remainToday,
    codeExpiresInDays: CFG.codeExpiresInDays,
    prizes: CFG.prizes.map((p) => ({ name: p.name, value: p.value, weight: p.weight })),
    records: rec.records.slice(-50).reverse().map((r) => ({
      time: r.time, prize: r.prize, value: r.value, code: r.code || null,
    })),
    mergedRewards,
  };
}

// ---------- HTTP 服务 ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));

app.get('/lucky-api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 查询管理员首页中奖播报：每个账户仅保留最新一条有额度中奖记录
app.get('/lucky-api/admin/win-broadcast', async (req, res) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'NOT_LOGGED_IN' });
  try {
    const claims = jwt.verify(h.slice(7).trim(), JWT_SECRET, { algorithms: ['HS256'] });
    if (claims.token_type && claims.token_type !== 'access') {
      return res.status(401).json({ ok: false, error: 'WRONG_TOKEN_TYPE' });
    }
    if (claims.user_id === undefined || claims.user_id === null || claims.user_id === '') {
      return res.status(401).json({ ok: false, error: 'NO_USER_ID' });
    }
    const data = await buildWinBroadcast(h.slice(7).trim());
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, data });
  } catch (e) {
    const status = e.statusCode === 401 ? 401 : 502;
    res.status(status).json({ ok: false, error: status === 401 ? 'UNAUTHORIZED' : 'UPSTREAM_ERROR' });
  }
});

// 查询自己的抽奖资格与记录
app.get('/lucky-api/status', auth, async (req, res) => {
  try {
    const st = await buildStatus(req.user);
    res.json({ ok: true, data: st });
  } catch (e) {
    log('error', 'status_failed', { uid: req.user.id, err: e.message });
    res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: '获取抽奖资格失败，请稍后重试' });
  }
});

// 合并当前用户所有尚未兑换的中奖码
app.post('/lucky-api/merge-rewards', auth, async (req, res) => {
  try {
    const result = await withUserLock(req.user.id, async () => mergeUserRewards(req.user));
    if (!result.code) return res.status(404).json({ ok: false, error: 'NO_PENDING_REWARDS', message: '暂无可合并的未兑换中奖记录' });
    const status = await buildStatus(req.user);
    res.json({ ok: true, data: { ...result, status } });
  } catch (e) {
    log('error', 'merge_failed', { uid: req.user.id, err: e.message });
    res.status(502).json({ ok: false, error: 'MERGE_FAILED', message: '合并兑换码失败，请稍后重试' });
  }
});

// 执行一次抽奖
app.post('/lucky-api/draw', auth, async (req, res) => {
  const user = req.user;
  try {
    const result = await withUserLock(user.id, async () => {
      const total = await fetchTotalRecharge(user.id);
      const entitled = entitledDraws(total);
      const rec = userRec(user.id);
      const today = todayKey();
      const usedTotal = rec.records.length;
      const usedToday = rec.records.filter((r) => r.day === today).length;

      if (total < CFG.minRechargeThreshold) {
        return { http: 403, body: { ok: false, error: 'BELOW_THRESHOLD',
          message: `累计充值满 ${CFG.minRechargeThreshold} 才可参与，当前 ${total}` } };
      }
      if (usedTotal >= entitled) {
        return { http: 403, body: { ok: false, error: 'NO_DRAWS_LEFT',
          message: `抽奖次数已用完（累计充值 ${total}，可抽 ${entitled} 次）` } };
      }
      if (usedToday >= CFG.dailyDrawLimit) {
        return { http: 429, body: { ok: false, error: 'DAILY_LIMIT',
          message: `今日抽奖次数已达上限（${CFG.dailyDrawLimit} 次），请明天再来` } };
      }

      const prize = drawPrize();
      const seq = ++DB.seq;
      const entry = {
        seq, day: today, time: new Date().toISOString(),
        prize: prize.name, prizeKey: prize.key, value: prize.value, code: null,
      };

      // 先占用次数再发码，避免发码成功但记录丢失导致重复发放
      rec.records.push(entry);
      rec.total = total;
      dbSave();

      if (prize.value > 0) {
        try {
          const code = await generateRedeemCode(prize.value);
          entry.code = code;
          dbSave();
          rateAlertCheck();
          audit({ event: 'prize_granted', userId: user.id, username: user.username,
            seq, prize: prize.name, value: prize.value, code, ip: req.ip });
        } catch (e) {
          entry.error = e.message;
          dbSave();
          audit({ event: 'grant_failed', userId: user.id, seq,
            prize: prize.name, value: prize.value, err: e.message, ip: req.ip });
          log('error', 'redeem_generate_failed', { uid: user.id, seq, err: e.message });
          return { http: 500, body: { ok: false, error: 'GRANT_FAILED',
            message: '中奖了，但兑换码生成失败，请联系管理员并提供编号 #' + seq, seq } };
        }
      } else {
        audit({ event: 'no_prize', userId: user.id, seq, ip: req.ip });
      }

      const st = await buildStatus(user);
      return { http: 200, body: { ok: true, data: {
        prize: prize.name, value: prize.value, code: entry.code, seq,
        expiresInDays: prize.value > 0 ? CFG.codeExpiresInDays : null,
        status: st,
      } } };
    });
    res.status(result.http).json(result.body);
  } catch (e) {
    log('error', 'draw_failed', { uid: user.id, err: e.message });
    res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: '抽奖失败，请稍后重试' });
  }
});

const server = app.listen(CFG.port, CFG.bindHost, () => {
  log('info', 'lucky_draw_started', { host: CFG.bindHost, port: CFG.port });
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'shutting_down', { sig });
    server.close(() => process.exit(0));
  });
}
