'use strict';

/*
 * AFKBot API (Mobile-controlled Minecraft Bedrock AFK client)
 *
 * Modes:
 *  - Parent (default): HTTP API + persistence + code generation + session orchestration.
 *  - Worker (AFKBOT_WORKER=1): owns bedrock-protocol client.
 *
 * Important:
 *  - Bedrock connections stay isolated in worker processes.
 *  - Native crashes in bedrock-protocol should only kill the worker, not the API parent.
 *  - Uses the same Fly.io volume layout as the original app (/data by default).
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { fork } = require('child_process');

const IS_WORKER = process.env.AFKBOT_WORKER === '1';

// ==================== CONFIGURATION ====================

const CONFIG = {
  SAVE_DEBOUNCE_MS: 100,

  // API
  PORT: parseInt(process.env.PORT || '8080', 10),
  BODY_LIMIT_BYTES: 16 * 1024,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',

  // Bot limits / memory
  GLOBAL_MAX_BOTS: parseInt(process.env.GLOBAL_MAX_BOTS || '20', 10),
  MEMORY_CHECK_INTERVAL_MS: 60_000,
  MAX_MEMORY_MB: parseInt(process.env.MAX_MEMORY_MB || '480', 10),

  // Reconnect
  MAX_RECONNECT_ATTEMPTS: 0,
  RECONNECT_BASE_DELAY_MS: parseInt(process.env.RECONNECT_BASE_DELAY_MS || '400', 10),
  RECONNECT_MAX_DELAY_MS: parseInt(process.env.RECONNECT_MAX_DELAY_MS || '10000', 10),
  RECONNECT_MULTIPLIER: Number.parseFloat(process.env.RECONNECT_MULTIPLIER || '1.7'),
  FAST_RECONNECT_ATTEMPTS: parseInt(process.env.FAST_RECONNECT_ATTEMPTS || '3', 10),
  RECONNECT_EXPONENT_CAP: 20,

  CONNECTION_TIMEOUT_MS: parseInt(process.env.CONNECTION_TIMEOUT_MS || '15000', 10),
  KEEPALIVE_INTERVAL_MS: 15_000,
  STALE_CONNECTION_TIMEOUT_MS: 300_000,
  STALE_CHECK_INTERVAL_MS: 30_000,

  // Worker lifecycle
  WORKER_STOP_GRACE_MS: 2_000,
  WORKER_FORCE_KILL_MS: 6_000,

  // AFK behaviour (kept identical)
  AFK_START_DELAY_MS: 5_000,
  AFK_MIN_DELAY_MS: 8_000,
  AFK_MAX_DELAY_MS: 20_000,

  // Session restore / watchdog
  SESSION_RESTORE_DELAY_MS: 8_000,
  SESSION_WATCHDOG_INTERVAL_MS: 10 * 60_000,

  // Access codes
  CODE_GENERATION_INTERVAL_MS: 5 * 60_000,
  CODE_TTL_MS: 30 * 24 * 60 * 60_000,
  CODE_CLEANUP_INTERVAL_MS: 6 * 60 * 60_000,
  CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  WEBHOOK_URL:
    process.env.CODE_WEBHOOK_URL ||
    'https://discord.com/api/webhooks/1475035351394291744/_UGugsSo264V9YeCbPdyTAULjCcPVaVmFpz6vhiqXOLM8q6ipKL53sOQaK81W3y--US_',

  // Rate limit
  REDEEM_RATE_LIMIT_MAX: parseInt(process.env.REDEEM_RATE_LIMIT_MAX || '5', 10),
  REDEEM_RATE_LIMIT_WINDOW_MS: 60_000,

  // Auth link flow
  LINK_TIMEOUT_MS: 5 * 60_000,
};

const DATA = process.env.FLY_VOLUME_PATH || '/data';
const AUTH_ROOT = path.join(DATA, 'auth');
const STORE = path.join(DATA, 'users.json');
const REJOIN_STORE = path.join(DATA, 'rejoin.json');
const CODES_STORE = path.join(DATA, 'codes.json');
const CRASH_LOG = path.join(DATA, 'crash.log');

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    console.error(`Failed to create directory ${dir}:`, e && e.message ? e.message : e);
    return false;
  }
}

function nowMs() {
  return Date.now();
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeId(prefix = '') {
  const rnd = crypto.randomBytes(6).toString('hex');
  return `${prefix}${Date.now().toString(16)}${rnd}`;
}

function makeNumericUserId() {
  let out = String(Date.now());
  while (out.length < 18) {
    out += String(crypto.randomInt(0, 10));
  }
  return out.slice(0, 18);
}

function makeAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateAccessCode() {
  let raw = '';
  for (let i = 0; i < 12; i++) {
    raw += CONFIG.CODE_ALPHABET[crypto.randomInt(0, CONFIG.CODE_ALPHABET.length)];
  }
  return raw.match(/.{1,4}/g).join('-');
}

function normalizeCode(input) {
  return String(input || '').trim().toUpperCase();
}

function isValidCodeFormat(input) {
  return /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(String(input || '').trim().toUpperCase());
}

function isValidUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 64;
}

function isInfinity(val) {
  return String(val).toLowerCase() === 'infinity';
}

function isExpiredTimestamp(expiresAt) {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && nowMs() >= expiresAt;
}

function formatServerLabel(server) {
  if (!server) return 'Unknown server';
  return `${server.ip}:${server.port}`;
}

function getMemoryMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function sendWebhookJson(webhookUrl, payload) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify(payload);
      const url = new URL(webhookUrl);
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(true));
        },
      );

      req.on('error', () => resolve(false));
      req.write(body);
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

// ==================== WORKER MODE ====================

async function runWorker() {
  const bedrock = require('bedrock-protocol');

  const state = {
    uid: null,
    client: null,
    connected: false,
    entityId: null,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    tick: 0,
    stopping: false,
    timers: new Set(),
    intervals: new Set(),
    runId: null,
    lastPacketTime: Date.now(),
    lastKeepalive: Date.now(),
  };

  function send(msg) {
    try {
      if (typeof process.send === 'function') process.send(msg);
    } catch (_) {}
  }

  function addTimeout(t) {
    state.timers.add(t);
    return t;
  }

  function addInterval(i) {
    state.intervals.add(i);
    return i;
  }

  function clearAllTimers() {
    for (const t of state.timers) clearTimeout(t);
    for (const i of state.intervals) clearInterval(i);
    state.timers.clear();
    state.intervals.clear();
  }

  function safeWrite(name, data) {
    if (!state.client || state.stopping || !state.connected) return;
    try {
      state.client.write(name, data);
    } catch (e) {
      send({ type: 'worker_log', level: 'warn', uid: state.uid, message: `write(${name}) failed: ${e && e.message ? e.message : e}` });
    }
  }

  function safeQueue(name, data) {
    if (!state.client || state.stopping || !state.connected) return;
    try {
      state.client.queue(name, data);
    } catch (e) {
      send({ type: 'worker_log', level: 'warn', uid: state.uid, message: `queue(${name}) failed: ${e && e.message ? e.message : e}` });
    }
  }

  function shutdown(code, reason) {
    if (state.stopping) return;
    state.stopping = true;

    clearAllTimers();

    try {
      if (state.client) {
        try {
          state.client.removeAllListeners();
        } catch (_) {}
      }
    } catch (_) {}

    send({ type: 'worker_exit', uid: state.uid, code, reason: reason || null });

    const t = setTimeout(() => process.exit(code), 50);
    if (typeof t.unref === 'function') t.unref();
  }

  function startHealthMonitoring(runId) {
    const keepalive = addInterval(() => {
      if (state.stopping || !state.connected || !state.client || state.runId !== runId) return;
      try {
        safeQueue('client_cache_status', { enabled: false });
      } catch (_) {}
    }, CONFIG.KEEPALIVE_INTERVAL_MS);
    if (typeof keepalive.unref === 'function') keepalive.unref();

    const stale = addInterval(() => {
      if (state.stopping || !state.client || state.runId !== runId) return;
      if (!state.connected) return;
      const lastActivity = state.lastPacketTime || 0;
      if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
        send({ type: 'mc_stale', uid: state.uid });
        shutdown(0, 'STALE');
      }
    }, CONFIG.STALE_CHECK_INTERVAL_MS);
    if (typeof stale.unref === 'function') stale.unref();
  }

  function scheduleAntiAfk(runId) {
    const doAfk = () => {
      if (state.stopping || !state.connected || !state.client || state.runId !== runId) return;
      if (!state.entityId) {
        const next = addTimeout(doAfk, 2000);
        if (typeof next.unref === 'function') next.unref();
        return;
      }

      try {
        const r = Math.random();

        if (r < 0.4) {
          safeWrite('animate', { action_id: 1, runtime_entity_id: state.entityId });
        } else if (r < 0.6) {
          safeWrite('player_action', {
            runtime_entity_id: state.entityId,
            action: 11,
            position: state.position,
            result_position: state.position,
            face: 0,
          });

          const stopDelay = 2000 + Math.random() * 2000;
          const t = addTimeout(() => {
            if (state.stopping || !state.connected || !state.client || state.runId !== runId || !state.entityId) return;
            safeWrite('player_action', {
              runtime_entity_id: state.entityId,
              action: 12,
              position: state.position,
              result_position: state.position,
              face: 0,
            });
          }, stopDelay);
          if (typeof t.unref === 'function') t.unref();
        } else if (r < 0.8) {
          safeWrite('player_action', {
            runtime_entity_id: state.entityId,
            action: 8,
            position: state.position,
            result_position: state.position,
            face: 0,
          });

          const original = { x: state.position.x, y: state.position.y, z: state.position.z };
          const jumpPos = { x: original.x, y: original.y + 0.5, z: original.z };

          state.tick = (state.tick || 0) + 1;
          safeQueue('move_player', {
            runtime_entity_id: state.entityId,
            position: jumpPos,
            pitch: state.pitch || 0,
            yaw: state.yaw || 0,
            head_yaw: state.yaw || 0,
            on_ground: false,
            mode: 0,
            tick: state.tick,
          });

          const t = addTimeout(() => {
            if (state.stopping || !state.connected || !state.client || state.runId !== runId || !state.entityId) return;
            state.tick = (state.tick || 0) + 1;
            safeQueue('move_player', {
              runtime_entity_id: state.entityId,
              position: original,
              pitch: state.pitch || 0,
              yaw: state.yaw || 0,
              head_yaw: state.yaw || 0,
              on_ground: true,
              mode: 0,
              tick: state.tick,
            });
            state.position = { x: original.x, y: original.y, z: original.z };
          }, 400 + Math.random() * 200);
          if (typeof t.unref === 'function') t.unref();
        } else {
          const dx = (Math.random() - 0.5) * 0.5;
          const dz = (Math.random() - 0.5) * 0.5;
          state.position.x += dx;
          state.position.z += dz;

          state.tick = (state.tick || 0) + 1;
          safeQueue('move_player', {
            runtime_entity_id: state.entityId,
            position: { x: state.position.x, y: state.position.y, z: state.position.z },
            pitch: state.pitch || 0,
            yaw: state.yaw || 0,
            head_yaw: state.yaw || 0,
            on_ground: true,
            mode: 0,
            tick: state.tick,
          });
        }
      } catch (_) {}

      const nextDelay = CONFIG.AFK_MIN_DELAY_MS + Math.random() * (CONFIG.AFK_MAX_DELAY_MS - CONFIG.AFK_MIN_DELAY_MS);
      const t = addTimeout(doAfk, nextDelay);
      if (typeof t.unref === 'function') t.unref();
    };

    const start = addTimeout(doAfk, CONFIG.AFK_START_DELAY_MS);
    if (typeof start.unref === 'function') start.unref();
  }

  function startClient(startMsg) {
    const uid = startMsg && startMsg.uid ? startMsg.uid : null;
    const runId = startMsg && startMsg.runId ? startMsg.runId : null;
    const opts = startMsg && startMsg.opts ? startMsg.opts : null;

    if (!uid || !opts) {
      send({ type: 'worker_log', level: 'error', uid: uid || null, message: 'Worker start message missing uid/opts' });
      shutdown(1, 'BAD_START');
      return;
    }

    state.uid = String(uid);
    state.runId = String(runId || Date.now());

    try {
      const mc = bedrock.createClient(opts);
      state.client = mc;

      mc.on('spawn', () => {
        send({ type: 'mc_spawn', uid: state.uid });
      });

      mc.on('start_game', (packet) => {
        if (!packet) return;
        state.entityId = packet.runtime_entity_id;
        state.connected = true;

        state.position = {
          x: packet.player_position && packet.player_position.x ? packet.player_position.x : 0,
          y: packet.player_position && packet.player_position.y ? packet.player_position.y : 0,
          z: packet.player_position && packet.player_position.z ? packet.player_position.z : 0,
        };
        state.yaw = packet.rotation && packet.rotation.y ? packet.rotation.y : 0;
        state.pitch = packet.rotation && packet.rotation.x ? packet.rotation.x : 0;

        state.lastPacketTime = Date.now();
        state.lastKeepalive = Date.now();

        send({
          type: 'mc_connected',
          uid: state.uid,
          entityId: state.entityId,
          position: state.position,
          yaw: state.yaw,
          pitch: state.pitch,
        });

        startHealthMonitoring(state.runId);
        scheduleAntiAfk(state.runId);
      });

      mc.on('packet', (data, meta) => {
        state.lastPacketTime = Date.now();
        try {
          if (!data || !meta) return;
          if (meta.name === 'move_player' && data.position) {
            state.position = { x: data.position.x, y: data.position.y, z: data.position.z };
            if (typeof data.yaw === 'number') state.yaw = data.yaw;
            if (typeof data.pitch === 'number') state.pitch = data.pitch;
          }
        } catch (_) {}
      });

      mc.on('disconnect', (packet) => {
        const reason = packet && packet.reason ? packet.reason : 'Unknown reason';
        send({ type: 'mc_disconnect', uid: state.uid, reason });
        shutdown(0, 'DISCONNECT');
      });

      mc.on('close', () => {
        send({ type: 'mc_close', uid: state.uid });
        shutdown(0, 'CLOSE');
      });

      mc.on('error', (e) => {
        send({ type: 'mc_error', uid: state.uid, message: e && e.message ? e.message : String(e) });
        shutdown(1, 'ERROR');
      });

      const guard = addTimeout(() => {
        if (state.stopping) return;
        if (!state.connected) {
          send({ type: 'mc_error', uid: state.uid, message: 'Connect guard timeout' });
          shutdown(1, 'CONNECT_GUARD_TIMEOUT');
        }
      }, CONFIG.CONNECTION_TIMEOUT_MS + 2000);
      if (typeof guard.unref === 'function') guard.unref();

      send({ type: 'worker_log', level: 'info', uid: state.uid, message: 'Worker bedrock client started' });
    } catch (e) {
      send({ type: 'mc_error', uid: state.uid, message: e && e.message ? e.message : String(e) });
      shutdown(1, 'CREATE_FAILED');
    }
  }

  process.on('message', (msg) => {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'start') {
        startClient(msg);
      } else if (msg.type === 'stop') {
        shutdown(0, 'STOP');
      } else if (msg.type === 'ping') {
        send({ type: 'pong', uid: state.uid || null, at: Date.now() });
      }
    } catch (_) {}
  });

  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => shutdown(0, 'SIGINT'));

  process.on('uncaughtException', (err) => {
    send({ type: 'worker_log', level: 'error', uid: state.uid, message: `uncaughtException: ${err && (err.stack || err.message) ? err.stack || err.message : err}` });
    shutdown(1, 'UNCAUGHT_EXCEPTION');
  });

  process.on('unhandledRejection', (reason) => {
    send({ type: 'worker_log', level: 'error', uid: state.uid, message: `unhandledRejection: ${reason && (reason.stack || reason.message) ? reason.stack || reason.message : reason}` });
    shutdown(1, 'UNHANDLED_REJECTION');
  });

  send({ type: 'worker_ready', pid: process.pid });
}

// ==================== PARENT MODE ====================

async function runParent() {
  // ==================== PERSISTENT STORE ====================

  class PersistentStore {
    constructor(filePath) {
      this.filePath = filePath;
      this.data = null;
      this.saveTimeout = null;
      this.isSaving = false;
    }

    async load(defaultVal = {}) {
      this.data = defaultVal;
      try {
        const content = await fs.readFile(this.filePath, 'utf8');
        if (content.trim()) {
          const parsed = JSON.parse(content);
          if (typeof parsed === 'object' && parsed !== null) {
            if (typeof defaultVal === 'object' && defaultVal !== null && !Array.isArray(defaultVal)) {
              this.data = { ...defaultVal, ...parsed };
            } else {
              this.data = parsed;
            }
          }
        }
      } catch (e) {
        if (!e || e.code !== 'ENOENT') {
          console.error(`Failed to load ${this.filePath}:`, e && e.message ? e.message : e);
          await this._backupCorruptFile();
        }
      }
      return this.data;
    }

    async _backupCorruptFile() {
      try {
        const backupPath = `${this.filePath}.backup.${Date.now()}`;
        await fs.rename(this.filePath, backupPath);
      } catch (_) {}
    }

    save(immediate = false) {
      if (immediate) return this._flush();
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(() => this._flush(), CONFIG.SAVE_DEBOUNCE_MS);
      return Promise.resolve(true);
    }

    async _flush() {
      if (this.isSaving) return;
      this.isSaving = true;
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const jsonString = JSON.stringify(
          this.data,
          (key, value) => (typeof value === 'bigint' ? value.toString() : value),
          2,
        );
        await fs.writeFile(`${this.filePath}.tmp`, jsonString, 'utf8');
        await fs.rename(`${this.filePath}.tmp`, this.filePath);
      } catch (e) {
        console.error('Store flush error:', e && e.message ? e.message : e);
      } finally {
        this.isSaving = false;
      }
    }
  }

  const userStore = new PersistentStore(STORE);
  const sessionStore = new PersistentStore(REJOIN_STORE);
  const codesStore = new PersistentStore(CODES_STORE);

  let users = {};
  let activeSessionsStore = {};
  let codesData = { codes: {}, meta: {} };
  let storesInitialized = false;

  const sessions = new Map();
  const sessionsByOwner = new Map();
  const pendingLink = new Map();
  const cleanupLocks = new Set();
  const tokenIndex = new Map();
  const redeemRate = new Map();

  let isShuttingDown = false;
  let apiServer = null;

  const crashLogger = {
    log: async (type, err) => {
      try {
        const timestamp = new Date().toISOString();
        const errorMsg = `[${timestamp}] ${type}:\n${err && (err.stack || err.message) ? err.stack || err.message : err}\n\n`;
        await fs.appendFile(CRASH_LOG, errorMsg).catch(() => {});
      } catch (_) {}
    },
  };

  process.on('uncaughtException', (err) => {
    crashLogger.log('UNCAUGHT EXCEPTION', err);
  });

  process.on('unhandledRejection', (reason) => {
    crashLogger.log('UNHANDLED REJECTION', reason);
  });

  function rebuildTokenIndex() {
    tokenIndex.clear();
    for (const uid of Object.keys(users || {})) {
      const u = users[uid];
      if (u && typeof u.apiTokenHash === 'string' && u.apiTokenHash) {
        tokenIndex.set(u.apiTokenHash, uid);
      }
    }
  }

  function addSessionIndex(ownerUid, sessionId) {
    if (!ownerUid || !sessionId) return;
    sessionsByOwner.set(ownerUid, sessionId);
  }

  function removeSessionIndex(ownerUid, sessionId) {
    const existing = sessionsByOwner.get(ownerUid);
    if (existing && existing === sessionId) {
      sessionsByOwner.delete(ownerUid);
    }
  }

  function getLiveSessionIdsForOwner(ownerUid) {
    const out = [];
    for (const [sid, session] of sessions.entries()) {
      if (session && session.ownerUid === ownerUid) out.push(sid);
    }
    return out;
  }

  function getStoredSessionIdsForOwner(ownerUid) {
    const out = [];
    for (const sid of Object.keys(activeSessionsStore || {})) {
      const entry = activeSessionsStore[sid];
      if (entry && entry.ownerUid === ownerUid) out.push(sid);
    }
    return out;
  }

  async function clearStoredSessionsForOwner(ownerUid) {
    if (!ownerUid) return;
    let changed = false;
    for (const sid of getStoredSessionIdsForOwner(ownerUid)) {
      delete activeSessionsStore[sid];
      changed = true;
    }
    if (changed) {
      sessionStore.data = activeSessionsStore;
      await sessionStore.save(true);
    }
  }

  function getOwnerSessionId(ownerUid) {
    const mapped = sessionsByOwner.get(ownerUid) || null;
    if (mapped && sessions.has(mapped)) return mapped;
    const liveIds = getLiveSessionIdsForOwner(ownerUid);
    if (liveIds.length > 0) {
      const preferred = liveIds.sort((a, b) => {
        const sa = sessions.get(a);
        const sb = sessions.get(b);
        return Number((sb && sb.startedAt) || 0) - Number((sa && sa.startedAt) || 0);
      })[0];
      sessionsByOwner.set(ownerUid, preferred);
      return preferred;
    }
    sessionsByOwner.delete(ownerUid);
    return null;
  }

  function normalizeStoredOwnerSessionsSync() {
    const byOwner = new Map();
    for (const sid of Object.keys(activeSessionsStore || {})) {
      const entry = activeSessionsStore[sid];
      if (!entry || !entry.ownerUid) continue;
      const existing = byOwner.get(entry.ownerUid);
      if (!existing) {
        byOwner.set(entry.ownerUid, sid);
        continue;
      }
      const existingEntry = activeSessionsStore[existing];
      const existingTime = Number((existingEntry && existingEntry.startedAt) || 0);
      const currentTime = Number((entry && entry.startedAt) || 0);
      if (currentTime >= existingTime) {
        delete activeSessionsStore[existing];
        byOwner.set(entry.ownerUid, sid);
      } else {
        delete activeSessionsStore[sid];
      }
    }
  }

  async function enforceSingleBotPerUser(ownerUid, preferredSessionId = null) {
    if (!ownerUid) return;

    const liveIds = getLiveSessionIdsForOwner(ownerUid).sort((a, b) => {
      const sa = sessions.get(a);
      const sb = sessions.get(b);
      return Number((sb && sb.startedAt) || 0) - Number((sa && sa.startedAt) || 0);
    });

    const keepLiveId = preferredSessionId && liveIds.includes(preferredSessionId)
      ? preferredSessionId
      : (liveIds[0] || null);

    for (const sid of liveIds) {
      if (keepLiveId && sid === keepLiveId) continue;
      await cleanupSession(sid);
    }

    const storedIds = getStoredSessionIdsForOwner(ownerUid).sort((a, b) => {
      const sa = activeSessionsStore[a];
      const sb = activeSessionsStore[b];
      return Number((sb && sb.startedAt) || 0) - Number((sa && sa.startedAt) || 0);
    });

    const keepStoredId = preferredSessionId && storedIds.includes(preferredSessionId)
      ? preferredSessionId
      : (storedIds[0] || null);

    let changed = false;
    for (const sid of storedIds) {
      if (keepStoredId && sid === keepStoredId) continue;
      delete activeSessionsStore[sid];
      changed = true;
    }

    if (changed) {
      sessionStore.data = activeSessionsStore;
      await sessionStore.save(true);
    }

    const finalLiveId = keepLiveId || getLiveSessionIdsForOwner(ownerUid)[0] || null;
    if (finalLiveId) sessionsByOwner.set(ownerUid, finalLiveId);
    else sessionsByOwner.delete(ownerUid);
  }

  function hasAccess(uid) {
    const u = ensureUserObject(uid);
    if (!u || !u.access || u.access.enabled !== true) return false;
    if (u.access.durationMs && !isInfinity(u.access.durationMs)) {
      const expiresAt =
        typeof u.access.expiresAt === 'number'
          ? u.access.expiresAt
          : typeof u.access.grantedAt === 'number'
            ? u.access.grantedAt + Number(u.access.durationMs)
            : null;
      if (expiresAt && isExpiredTimestamp(expiresAt)) return false;
    }
    return true;
  }

  function ensureUserObject(uid) {
    if (!isValidUid(uid)) {
      return {
        connectionType: 'online',
        bedrockVersion: 'auto',
        access: { enabled: false },
        microsoftAccounts: [],
        servers: [],
        ipHistory: [],
        knownClients: [],
        _temp: true,
      };
    }

    if (!users[uid]) {
      users[uid] = {
        connectionType: 'online',
        bedrockVersion: 'auto',
        createdAt: nowMs(),
        lastActive: nowMs(),
        access: { enabled: false },
        microsoftAccounts: [],
        servers: [],
        ipHistory: [],
        knownClients: [],
        apiTokenHash: null,
      };
      userStore.data = users;
      userStore.save();
    }

    const u = users[uid];
    u.connectionType = u.connectionType || 'online';
    u.bedrockVersion = u.bedrockVersion || 'auto';
    u.lastActive = nowMs();

    if (!u.access || typeof u.access !== 'object') u.access = { enabled: false };
    if (typeof u.access.enabled !== 'boolean') u.access.enabled = u.access.enabled === true;
    if (!Array.isArray(u.microsoftAccounts)) u.microsoftAccounts = [];
    if (!Array.isArray(u.servers)) u.servers = [];
    if (!Array.isArray(u.ipHistory)) u.ipHistory = [];
    if (!Array.isArray(u.knownClients)) u.knownClients = [];
    if (typeof u.apiTokenHash !== 'string') u.apiTokenHash = null;
    if (typeof u.lastKnownIp !== 'string') u.lastKnownIp = null;
    if (!u.lastKnownClient || typeof u.lastKnownClient !== 'object') u.lastKnownClient = null;

    if (u.server && u.server.ip && u.server.port && u.servers.length === 0) {
      u.servers.push({
        id: 'legacy',
        ip: u.server.ip,
        port: u.server.port,
        createdAt: nowMs(),
        lastUsedAt: null,
      });
    }

    if (u.linked === true && u.microsoftAccounts.length === 0) {
      u.microsoftAccounts.push({
        id: 'legacy',
        createdAt: u.tokenAcquiredAt || nowMs(),
        tokenAcquiredAt: u.tokenAcquiredAt || nowMs(),
        lastUsedAt: null,
        legacy: true,
      });
    }

    u.linked = u.microsoftAccounts.length > 0;
    return u;
  }

  function migrateAndNormalizeAllData() {
    try {
      for (const uid of Object.keys(users || {})) {
        ensureUserObject(uid);
      }

      const keys = Object.keys(activeSessionsStore || {});
      const looksLegacy = keys.some((k) => {
        const entry = activeSessionsStore[k];
        return entry && typeof entry === 'object' && !entry.ownerUid;
      });

      if (looksLegacy) {
        const migrated = {};
        for (const uid of keys) {
          const s = activeSessionsStore[uid];
          if (!s || typeof s !== 'object') continue;
          const sessionId = `legacy_${uid}`;
          migrated[sessionId] = {
            ownerUid: uid,
            accountId: s.accountId || 'legacy',
            startedAt: s.startedAt || nowMs(),
            server: s.server || (s.ip && s.port ? { ip: s.ip, port: s.port } : null),
            connectionType: s.connectionType,
            bedrockVersion: s.bedrockVersion,
            offlineUsername: s.offlineUsername,
            lastActive: s.lastActive || nowMs(),
          };
        }
        activeSessionsStore = migrated;
      } else {
        for (const sid of keys) {
          const s = activeSessionsStore[sid];
          if (!s || typeof s !== 'object') continue;
          if (!s.accountId) s.accountId = 'legacy';
          if (!s.ownerUid && s.uid) s.ownerUid = s.uid;
        }
      }

      normalizeStoredOwnerSessionsSync();

      if (!codesData || typeof codesData !== 'object') codesData = { codes: {}, meta: {} };
      if (!codesData.codes || typeof codesData.codes !== 'object') codesData.codes = {};
      if (!codesData.meta || typeof codesData.meta !== 'object') codesData.meta = {};

      userStore.data = users;
      sessionStore.data = activeSessionsStore;
      codesStore.data = codesData;
    } catch (e) {
      console.error('Migration error:', e && e.message ? e.message : e);
    }
  }

  async function initializeStores() {
    await ensureDir(DATA);
    await ensureDir(AUTH_ROOT);
    users = await userStore.load({});
    activeSessionsStore = await sessionStore.load({});
    codesData = await codesStore.load({ codes: {}, meta: {} });
    migrateAndNormalizeAllData();
    rebuildTokenIndex();
    storesInitialized = true;
    console.log(
      `Loaded ${Object.keys(users).length} users, ${Object.keys(activeSessionsStore).length} sessions, ${Object.keys(codesData.codes || {}).length} codes`,
    );
  }

  function parseAuthHeader(req) {
    const auth = req.headers && req.headers.authorization ? String(req.headers.authorization) : '';
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.slice('Bearer '.length).trim();
  }

  function getRequestIp(req) {
    const xfwd = req.headers && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']) : '';
    if (xfwd) return xfwd.split(',')[0].trim();
    const addr = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown';
    return addr;
  }

  function normalizeHeaderValue(value, maxLen = 256) {
    if (value === undefined || value === null) return '';
    return String(value).trim().slice(0, maxLen);
  }

  function getClientDetails(req) {
    const ip = getRequestIp(req);
    const userAgent = normalizeHeaderValue(req && req.headers ? req.headers['user-agent'] : '', 512);
    const acceptLanguage = normalizeHeaderValue(req && req.headers ? req.headers['accept-language'] : '', 128);
    const deviceId = normalizeHeaderValue(req && req.headers ? (req.headers['x-client-device-id'] || req.headers['x-device-id']) : '', 128);
    const deviceName = normalizeHeaderValue(req && req.headers ? (req.headers['x-client-device-name'] || req.headers['x-device-name']) : '', 128);
    const platform = normalizeHeaderValue(req && req.headers ? (req.headers['x-client-platform'] || req.headers['x-platform']) : '', 64);
    const model = normalizeHeaderValue(req && req.headers ? (req.headers['x-client-model'] || req.headers['x-device-model']) : '', 128);
    const fingerprintSource = [deviceId || '', deviceName || '', platform || '', model || '', userAgent || '', acceptLanguage || ''].join('|');
    return {
      ip,
      userAgent,
      acceptLanguage,
      deviceId: deviceId || null,
      deviceName: deviceName || null,
      platform: platform || null,
      model: model || null,
      fingerprint: sha256(fingerprintSource || ip || 'unknown-client'),
      observedAt: nowMs(),
    };
  }

  function rememberClientForUser(uid, client, reason = 'request') {
    if (!uid || !client || !client.ip) return null;
    const u = ensureUserObject(uid);
    if (!u || u._temp) return null;

    if (!Array.isArray(u.ipHistory)) u.ipHistory = [];
    if (!Array.isArray(u.knownClients)) u.knownClients = [];

    const seenAt = nowMs();
    const existingIp = u.ipHistory.find((entry) => entry && entry.ip === client.ip);
    if (existingIp) {
      existingIp.lastSeenAt = seenAt;
      existingIp.hits = Number(existingIp.hits || 0) + 1;
      if (reason) existingIp.lastReason = reason;
    } else {
      u.ipHistory.unshift({
        ip: client.ip,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        hits: 1,
        lastReason: reason,
      });
      if (u.ipHistory.length > 20) u.ipHistory.length = 20;
    }

    const existingClient = u.knownClients.find((entry) => entry && entry.fingerprint === client.fingerprint);
    if (existingClient) {
      existingClient.lastSeenAt = seenAt;
      existingClient.hits = Number(existingClient.hits || 0) + 1;
      existingClient.lastIp = client.ip;
      if (reason) existingClient.lastReason = reason;
      if (client.deviceId) existingClient.deviceId = client.deviceId;
      if (client.deviceName) existingClient.deviceName = client.deviceName;
      if (client.platform) existingClient.platform = client.platform;
      if (client.model) existingClient.model = client.model;
      if (client.userAgent) existingClient.userAgent = client.userAgent;
    } else {
      u.knownClients.unshift({
        fingerprint: client.fingerprint,
        deviceId: client.deviceId,
        deviceName: client.deviceName,
        platform: client.platform,
        model: client.model,
        userAgent: client.userAgent,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        lastIp: client.ip,
        hits: 1,
        lastReason: reason,
      });
      if (u.knownClients.length > 12) u.knownClients.length = 12;
    }

    u.lastKnownIp = client.ip;
    u.lastKnownClient = {
      fingerprint: client.fingerprint,
      deviceId: client.deviceId,
      deviceName: client.deviceName,
      platform: client.platform,
      model: client.model,
      userAgent: client.userAgent,
      lastIp: client.ip,
      lastSeenAt: seenAt,
      lastReason: reason,
    };

    userStore.data = users;
    userStore.save();
    return u.lastKnownClient;
  }

  function isSameTrustedClient(user, client) {
    if (!user || !client || !client.ip || !client.fingerprint) return false;
    const ipMatch = user.lastKnownIp === client.ip || (Array.isArray(user.ipHistory) && user.ipHistory.some((entry) => entry && entry.ip === client.ip));
    const fpMatch = (user.lastKnownClient && user.lastKnownClient.fingerprint === client.fingerprint)
      || (Array.isArray(user.knownClients) && user.knownClients.some((entry) => entry && entry.fingerprint === client.fingerprint));
    return !!(ipMatch && fpMatch);
  }

  function issueFreshTokenForUser(uid) {
    const u = ensureUserObject(uid);
    if (!u || u._temp) return null;
    if (u.apiTokenHash) tokenIndex.delete(u.apiTokenHash);
    const token = makeAccessToken();
    u.apiTokenHash = sha256(token);
    u.lastTokenIssuedAt = nowMs();
    tokenIndex.set(u.apiTokenHash, uid);
    userStore.data = users;
    return token;
  }

  function clearUserToken(uid) {
    const u = ensureUserObject(uid);
    if (!u || u._temp) return;
    if (u.apiTokenHash) tokenIndex.delete(u.apiTokenHash);
    u.apiTokenHash = null;
    u.lastTokenRevokedAt = nowMs();
    userStore.data = users;
  }

  function authenticateRequest(req) {
    const token = parseAuthHeader(req);
    if (!token) return null;
    const uid = tokenIndex.get(sha256(token));
    if (!uid) return null;
    const u = ensureUserObject(uid);
    if (!hasAccess(uid)) return null;
    const client = getClientDetails(req);
    rememberClientForUser(uid, client, 'auth');
    u.lastActive = nowMs();
    u.lastTokenUseAt = nowMs();
    return { uid, user: u, token, client };
  }

  function buildPublicAccount(account, idx) {
    return {
      id: account.id,
      label: account.legacy ? 'Account 1' : `Account ${idx + 1}`,
      createdAt: account.createdAt || null,
      tokenAcquiredAt: account.tokenAcquiredAt || null,
      lastUsedAt: account.lastUsedAt || null,
      legacy: !!account.legacy,
    };
  }

  function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.setHeader('Access-Control-Allow-Origin', CONFIG.CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Device-ID, X-Client-Device-Name, X-Client-Platform, X-Client-Model');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.end(body);
  }

  function ok(res, data, statusCode = 200) {
    sendJson(res, statusCode, { success: true, data });
  }

  function fail(res, statusCode, error, extra) {
    sendJson(res, statusCode, { success: false, error, ...(extra || {}) });
  }

  function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let tooLarge = false;

      req.on('data', (chunk) => {
        if (tooLarge) return;
        body += chunk;
        if (Buffer.byteLength(body) > CONFIG.BODY_LIMIT_BYTES) {
          tooLarge = true;
          reject(new Error('BODY_TOO_LARGE'));
          req.destroy();
        }
      });

      req.on('end', () => {
        if (tooLarge) return;
        if (!body) return resolve({});
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch (_) {
          reject(new Error('INVALID_JSON'));
        }
      });

      req.on('error', reject);
    });
  }

  function checkRateLimit(ip, max, windowMs) {
    const now = nowMs();
    const item = redeemRate.get(ip);
    if (!item || now >= item.resetAt) {
      redeemRate.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (item.count >= max) return false;
    item.count += 1;
    return true;
  }

  function cleanupRateLimits() {
    const now = nowMs();
    for (const [ip, item] of redeemRate.entries()) {
      if (!item || now >= item.resetAt) redeemRate.delete(ip);
    }
  }

  function listAccounts(uid) {
    return ensureUserObject(uid).microsoftAccounts.filter((a) => a && typeof a.id === 'string');
  }

  function isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    if (ip.length > 253) return false;
    if (ip.includes('..') || ip.startsWith('.') || ip.endsWith('.')) return false;
    if (ip.includes('://')) return false;
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}$|^::1$/;
    const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
  }

  function isPrivateOrLocalHost(ip) {
    if (!ip || typeof ip !== 'string') return true;
    const host = ip.trim().toLowerCase();
    if (host === 'localhost' || host.endsWith('.local')) return true;

    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a === 10 || a === 127 || a === 0) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
    }

    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
    return false;
  }

  function isValidPort(port) {
    const num = parseInt(String(port), 10);
    return !Number.isNaN(num) && num > 0 && num <= 65535;
  }

  async function getUserAuthDir(uid, accountId = 'legacy') {
    if (!uid || typeof uid !== 'string') return null;
    const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '');
    if (!safeUid) return null;

    if (!accountId || accountId === 'legacy') {
      const dir = path.join(AUTH_ROOT, safeUid);
      await ensureDir(dir);
      return dir;
    }

    const safeAcc = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeAcc) {
      const dir = path.join(AUTH_ROOT, safeUid);
      await ensureDir(dir);
      return dir;
    }

    const dir = path.join(AUTH_ROOT, `${safeUid}__${safeAcc}`);
    await ensureDir(dir);
    return dir;
  }

  async function unlinkMicrosoftAccount(uid, accountId) {
    if (!uid || !accountId) return false;
    const u = ensureUserObject(uid);
    const accIndex = u.microsoftAccounts.findIndex((a) => a && a.id === accountId);
    if (accIndex === -1) return false;

    const dir = await getUserAuthDir(uid, accountId);
    if (dir) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (_) {}
    }

    u.microsoftAccounts.splice(accIndex, 1);
    u.linked = u.microsoftAccounts.length > 0;
    if (!u.linked) {
      u.authTokenExpiry = null;
      u.tokenAcquiredAt = null;
    }

    const currentSessionId = getOwnerSessionId(uid);
    if (currentSessionId) {
      const s = sessions.get(currentSessionId);
      if (s && s.accountId === accountId) {
        await stopSession(currentSessionId);
      }
    }

    userStore.data = users;
    await userStore.save(true);
    return true;
  }

  async function createNewCodeAndSend() {
    if (isShuttingDown) return null;

    let code = generateAccessCode();
    while (codesData.codes[code]) {
      code = generateAccessCode();
    }

    const createdAt = nowMs();
    codesData.codes[code] = {
      used: false,
      createdAt,
      expiresAt: createdAt + CONFIG.CODE_TTL_MS,
    };
    if (!codesData.meta || typeof codesData.meta !== 'object') codesData.meta = {};
    codesData.meta.lastGeneratedAt = createdAt;

    codesStore.data = codesData;
    await codesStore.save(true);

    const sent = await sendWebhookJson(CONFIG.WEBHOOK_URL, {
      content: `New access code:\n\`${code}\`\nValid for 30 days or until first use.`,
    });

    if (!sent) {
      console.warn(`Failed to send code ${code} to webhook.`);
    } else {
      console.log(`Generated and sent access code ${code}`);
    }

    return code;
  }

  async function cleanupExpiredCodes() {
    if (!codesData || !codesData.codes) return;
    const now = nowMs();
    let removed = 0;

    for (const code of Object.keys(codesData.codes)) {
      const entry = codesData.codes[code];
      if (!entry || typeof entry !== 'object') {
        delete codesData.codes[code];
        removed += 1;
        continue;
      }
      const expiresAt = typeof entry.expiresAt === 'number' ? entry.expiresAt : (entry.createdAt || 0) + CONFIG.CODE_TTL_MS;
      if (!entry.used && expiresAt && now >= expiresAt) {
        delete codesData.codes[code];
        removed += 1;
      }
    }

    if (removed > 0) {
      codesStore.data = codesData;
      await codesStore.save(true);
      console.log(`Cleaned up ${removed} expired unused access code(s)`);
    }
  }

  async function maybeGenerateStartupCode() {
    const lastGeneratedAt = codesData && codesData.meta ? Number(codesData.meta.lastGeneratedAt || 0) : 0;
    if (!lastGeneratedAt || nowMs() - lastGeneratedAt >= CONFIG.CODE_GENERATION_INTERVAL_MS) {
      await createNewCodeAndSend();
    }
  }

  function canAcceptNewBot() {
    if (sessions.size >= CONFIG.GLOBAL_MAX_BOTS) {
      return { ok: false, error: `Global bot limit reached (${CONFIG.GLOBAL_MAX_BOTS})` };
    }
    const memoryMb = getMemoryMb();
    if (memoryMb >= CONFIG.MAX_MEMORY_MB) {
      return { ok: false, error: `Server memory is too high (${memoryMb}MB)` };
    }
    return { ok: true };
  }

  function isUnlimitedReconnects() {
    return !Number.isFinite(CONFIG.MAX_RECONNECT_ATTEMPTS) || CONFIG.MAX_RECONNECT_ATTEMPTS <= 0;
  }

  function computeReconnectDelayMs(attempt) {
    const safeAttempt = Math.max(1, Number(attempt) || 1);
    const base = Number.isFinite(CONFIG.RECONNECT_BASE_DELAY_MS) && CONFIG.RECONNECT_BASE_DELAY_MS > 0
      ? CONFIG.RECONNECT_BASE_DELAY_MS
      : 400;
    const max = Number.isFinite(CONFIG.RECONNECT_MAX_DELAY_MS) && CONFIG.RECONNECT_MAX_DELAY_MS >= base
      ? CONFIG.RECONNECT_MAX_DELAY_MS
      : 10_000;
    const multiplier = Number.isFinite(CONFIG.RECONNECT_MULTIPLIER) && CONFIG.RECONNECT_MULTIPLIER > 1
      ? CONFIG.RECONNECT_MULTIPLIER
      : 1.7;
    const fastAttempts = Number.isFinite(CONFIG.FAST_RECONNECT_ATTEMPTS) && CONFIG.FAST_RECONNECT_ATTEMPTS > 0
      ? CONFIG.FAST_RECONNECT_ATTEMPTS
      : 3;
    const expCap = Number.isFinite(CONFIG.RECONNECT_EXPONENT_CAP) && CONFIG.RECONNECT_EXPONENT_CAP >= 0
      ? CONFIG.RECONNECT_EXPONENT_CAP
      : 20;

    const exp = Math.min(Math.max(0, safeAttempt - 1), expCap);
    const baseDelay = Math.min(max, base * Math.pow(multiplier, exp));
    const jitterCap = safeAttempt <= fastAttempts ? Math.min(250, Math.floor(base * 0.4)) : Math.min(1_000, Math.floor(base * 1.5));
    const jitter = Math.random() * Math.max(1, jitterCap);

    return Math.max(100, Math.round(baseDelay + jitter));
  }

  async function saveSessionData(sessionId) {
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    if (!s) return;

    activeSessionsStore[sessionId] = {
      ownerUid: s.ownerUid,
      accountId: s.accountId,
      startedAt: s.startedAt || nowMs(),
      server: s.server,
      connectionType: s.connectionType,
      bedrockVersion: s.bedrockVersion,
      offlineUsername: s.offlineUsername,
      lastActive: nowMs(),
    };
    sessionStore.data = activeSessionsStore;
    await sessionStore.save();
  }

  async function saveAllSessionData() {
    for (const sessionId of sessions.keys()) {
      await saveSessionData(sessionId);
    }
  }

  async function clearSessionData(sessionId) {
    if (activeSessionsStore[sessionId]) {
      delete activeSessionsStore[sessionId];
      sessionStore.data = activeSessionsStore;
      await sessionStore.save();
    }
  }

  function buildWorkerOpts(ownerUid, authDir, server) {
    const u = ensureUserObject(ownerUid);
    const ip = server.ip;
    const port = server.port;

    const opts = {
      host: ip,
      port: parseInt(port, 10),
      connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      viewDistance: 1,
      profilesFolder: authDir,
      username: ownerUid,
      offline: false,
      skipPing: true,
      autoInitPlayer: true,
      useTimeout: false,
    };

    if (u.connectionType === 'offline') {
      opts.username = u.offlineUsername || `AFK_${ownerUid.slice(-4)}`;
      opts.offline = true;
    }

    return opts;
  }

  function spawnWorkerForSession(sessionId, runId, opts) {
    const child = fork(__filename, [], {
      env: { ...process.env, AFKBOT_WORKER: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    child.on('message', (msg) => {
      try {
        if (!msg || typeof msg !== 'object') return;
        const s = sessions.get(sessionId);
        if (!s) return;

        if (msg.type === 'worker_ready') {
          return;
        }
        if (msg.type === 'worker_log') {
          if (msg.level === 'error') console.error(`[WORKER ${sessionId}]`, msg.message);
          else console.log(`[WORKER ${sessionId}]`, msg.message);
          return;
        }
        if (msg.type === 'mc_spawn') {
          s.lastSpawnAt = nowMs();
          return;
        }
        if (msg.type === 'mc_connected') {
          s.connected = true;
          s.status = 'connected';
          s.isReconnecting = false;
          s.reconnectAttempt = 0;
          s.lastConnectedAt = nowMs();
          s.lastError = null;
          return;
        }
        if (msg.type === 'mc_disconnect') {
          s.connected = false;
          s.lastDisconnectReason = msg.reason || 'Unknown reason';
          s.status = 'disconnected';
          return;
        }
        if (msg.type === 'mc_error') {
          s.connected = false;
          s.lastError = msg.message || 'Unknown error';
          s.status = 'error';
          console.error(`Session error for ${sessionId}:`, s.lastError);
          return;
        }
        if (msg.type === 'mc_stale') {
          s.lastError = 'STALE_CONNECTION';
          s.status = 'reconnecting';
          return;
        }
        if (msg.type === 'mc_close') {
          s.connected = false;
          if (!s.isReconnecting) s.status = 'disconnected';
        }
      } catch (_) {}
    });

    child.once('exit', (code, signal) => {
      const s = sessions.get(sessionId);
      if (!s) return;

      s.child = null;
      s.connected = false;

      if (isShuttingDown || s.manualStop || s.isCleaningUp) {
        return;
      }

      const nextAttempt = Math.max(1, (s.reconnectAttempt || 0) + 1);
      console.warn(`Worker for ${sessionId} exited (${signal || code}). Scheduling reconnect attempt ${nextAttempt}...`);
      handleAutoReconnect(sessionId, nextAttempt);
    });

    child.send({ type: 'start', uid: sessionId, runId, opts });
    return child;
  }

  async function stopWorker(sessionId, s) {
    if (!s || !s.child) return;
    const child = s.child;

    await new Promise((resolve) => {
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      const gracefulTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch (_) {}
      }, CONFIG.WORKER_STOP_GRACE_MS);

      const forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        finish();
      }, CONFIG.WORKER_FORCE_KILL_MS);

      try {
        child.once('exit', () => {
          clearTimeout(gracefulTimer);
          clearTimeout(forceTimer);
          finish();
        });

        try {
          child.send({ type: 'stop' });
        } catch (_) {
          try {
            child.kill('SIGTERM');
          } catch (_) {}
        }
      } catch (_) {
        clearTimeout(gracefulTimer);
        clearTimeout(forceTimer);
        finish();
      }
    });

    s.child = null;
  }

  async function cleanupSession(sessionId) {
    if (!sessionId) return;
    if (cleanupLocks.has(sessionId)) return;

    cleanupLocks.add(sessionId);
    try {
      const s = sessions.get(sessionId);
      if (!s) return;

      s.isCleaningUp = true;
      s.manualStop = true;

      if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
      }

      await stopWorker(sessionId, s);
      sessions.delete(sessionId);
      removeSessionIndex(s.ownerUid, sessionId);
    } finally {
      cleanupLocks.delete(sessionId);
    }
  }

  async function cleanupAllSessions() {
    const tasks = [];
    for (const sessionId of sessions.keys()) {
      tasks.push(cleanupSession(sessionId));
    }
    await Promise.all(tasks);
  }

  async function stopSession(sessionId) {
    if (!sessionId) return false;
    const s = sessions.get(sessionId);
    if (s) {
      s.manualStop = true;
      s.status = 'offline';
      if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
      }
    }
    await clearSessionData(sessionId);
    await cleanupSession(sessionId);
    return true;
  }

  async function stopBotForUser(uid) {
    const sessionId = getOwnerSessionId(uid);
    if (!sessionId) return false;
    return stopSession(sessionId);
  }

  async function forceStopAllSessionsSilently() {
    const liveSessionIds = Array.from(sessions.keys());
    for (const sessionId of liveSessionIds) {
      try {
        await stopSession(sessionId);
      } catch (e) {
        console.error(`forceStopAllSessions: failed to stop ${sessionId}:`, e && e.message ? e.message : e);
      }
    }

    const storedSessionIds = Object.keys(activeSessionsStore || {});
    if (storedSessionIds.length > 0) {
      for (const sid of storedSessionIds) {
        delete activeSessionsStore[sid];
      }
      sessionStore.data = activeSessionsStore;
      await sessionStore.save(true);
    }

    return {
      liveStopped: liveSessionIds.length,
      storedCleared: storedSessionIds.length,
    };
  }

  async function reconnectBotForUser(uid) {
    const sessionId = getOwnerSessionId(uid);
    if (!sessionId) return false;
    const s = sessions.get(sessionId);
    if (!s) return false;

    const snapshot = {
      ownerUid: s.ownerUid,
      accountId: s.accountId,
      server: { ip: s.server.ip, port: s.server.port },
    };

    await cleanupSession(sessionId);
    await startSession(snapshot.ownerUid, snapshot.accountId, snapshot.server, null, true, 1, sessionId);
    return true;
  }

  async function handleAutoReconnect(sessionId, attempt = 1) {
    if (!sessionId || isShuttingDown) return;
    const s = sessions.get(sessionId);
    if (!s || s.manualStop || s.isCleaningUp) return;

    attempt = Math.max(1, attempt);

    if (!isUnlimitedReconnects() && attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
      attempt = 1;
    }

    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.isReconnecting = true;
    s.reconnectAttempt = attempt;
    s.status = 'reconnecting';

    const delay = computeReconnectDelayMs(attempt);
    s.reconnectTimer = setTimeout(async () => {
      if (!isShuttingDown && !s.manualStop) {
        const restarted = await restartSessionWorkerFast(sessionId, attempt);
        if (!restarted && !isShuttingDown) {
          await stopWorker(sessionId, s);
          await startSession(s.ownerUid, s.accountId, s.server, null, true, attempt, sessionId);
        }
      } else {
        await cleanupSession(sessionId);
      }
    }, delay);

    if (typeof s.reconnectTimer.unref === 'function') s.reconnectTimer.unref();
  }

  async function restartSessionWorkerFast(sessionId, reconnectAttempt) {
    if (!sessionId || isShuttingDown) return false;
    const s = sessions.get(sessionId);
    if (!s || s.manualStop || s.isCleaningUp) return false;
    if (!s.authDir || !s.server || !s.server.ip || !s.server.port) return false;

    if (s.child) {
      await stopWorker(sessionId, s);
    }

    const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    s.runId = runId;
    s.connected = false;
    s.isReconnecting = true;
    s.reconnectAttempt = Math.max(1, reconnectAttempt || 1);
    s.status = 'reconnecting';

    try {
      const opts = buildWorkerOpts(s.ownerUid, s.authDir, s.server);
      s.child = spawnWorkerForSession(sessionId, runId, opts);
      await saveSessionData(sessionId);
      return true;
    } catch (e) {
      s.lastError = e && e.message ? e.message : String(e);
      return false;
    }
  }

  async function startSession(ownerUid, accountId, server, interaction, isReconnect = false, reconnectAttempt = 1, existingSessionId = null) {
    if (!ownerUid || isShuttingDown) return null;
    if (!storesInitialized) return null;
    if (!hasAccess(ownerUid)) return null;

    await enforceSingleBotPerUser(ownerUid, existingSessionId || null);

    const currentSessionId = getOwnerSessionId(ownerUid);
    const storedSessionIds = getStoredSessionIdsForOwner(ownerUid).filter((sid) => sid !== existingSessionId);
    if (!isReconnect && (currentSessionId || storedSessionIds.length > 0)) {
      return null;
    }

    const capacity = canAcceptNewBot();
    if (!isReconnect && !capacity.ok) {
      return null;
    }

    if (existingSessionId && cleanupLocks.has(existingSessionId)) {
      let attempts = 0;
      while (cleanupLocks.has(existingSessionId) && attempts < 10) {
        await sleep(500);
        attempts += 1;
      }
    }

    const u = ensureUserObject(ownerUid);
    const accounts = listAccounts(ownerUid);

    if (u.connectionType !== 'offline') {
      if (!accounts.length) return null;
      if (!accountId) accountId = accounts[0].id;
    } else if (!accountId) {
      accountId = 'offline';
    }

    if (!server || !server.ip) return null;
    const ip = String(server.ip || '').trim();
    const port = parseInt(String(server.port || 19132), 10);

    if (!isValidIP(ip) || !isValidPort(port) || isPrivateOrLocalHost(ip)) {
      return null;
    }

    if (isReconnect && existingSessionId && sessions.has(existingSessionId)) {
      await cleanupSession(existingSessionId);
    }

    const authDir = await getUserAuthDir(ownerUid, accountId || 'legacy');
    if (!authDir) return null;

    const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const sessionId = existingSessionId || makeId(`s_${ownerUid}_`);

    const session = {
      sessionId,
      ownerUid,
      accountId: accountId || 'legacy',
      authDir,
      runId,
      child: null,
      startedAt: nowMs(),
      manualStop: false,
      connected: false,
      isReconnecting: !!isReconnect,
      isCleaningUp: false,
      reconnectAttempt: reconnectAttempt,
      reconnectTimer: null,
      server: { ip, port },
      serverLabel: `${ip}:${port}`,
      connectionType: u.connectionType,
      bedrockVersion: u.bedrockVersion,
      offlineUsername: u.offlineUsername,
      status: isReconnect ? 'reconnecting' : 'connected',
      lastError: null,
      lastDisconnectReason: null,
      lastConnectedAt: null,
    };

    sessions.set(sessionId, session);
    addSessionIndex(ownerUid, sessionId);

    u.server = { ip, port };
    if (Array.isArray(u.servers)) {
      const srv = u.servers.find((item) => item && item.ip === ip && String(item.port) === String(port));
      if (srv) srv.lastUsedAt = nowMs();
    }
    const selectedAccount = accounts.find((a) => a.id === accountId);
    if (selectedAccount) selectedAccount.lastUsedAt = nowMs();

    userStore.data = users;
    await userStore.save();
    await saveSessionData(sessionId);

    const opts = buildWorkerOpts(ownerUid, authDir, server);
    session.child = spawnWorkerForSession(sessionId, runId, opts);

    return sessionId;
  }

  async function restoreSessions() {
    const previousSessions = Object.keys(activeSessionsStore || {});
    console.log(`Found ${previousSessions.length} sessions to restore`);

    let delay = 0;
    for (const sessionId of previousSessions) {
      const sessionData = activeSessionsStore[sessionId];
      if (!sessionData || typeof sessionData !== 'object') continue;

      const ownerUid = String(sessionData.ownerUid || '');
      if (!ownerUid) {
        await clearSessionData(sessionId);
        continue;
      }
      if (!hasAccess(ownerUid)) {
        await clearSessionData(sessionId);
        continue;
      }
      if (getOwnerSessionId(ownerUid)) {
        continue;
      }
      const hasServer = !!(sessionData.server && sessionData.server.ip && sessionData.server.port);
      if (!hasServer) {
        await clearSessionData(sessionId);
        continue;
      }

      const u = ensureUserObject(ownerUid);
      if (sessionData.server) u.server = sessionData.server;
      if (sessionData.connectionType) u.connectionType = sessionData.connectionType;
      if (sessionData.bedrockVersion) u.bedrockVersion = sessionData.bedrockVersion;
      if (sessionData.offlineUsername) u.offlineUsername = sessionData.offlineUsername;

      setTimeout(() => {
        if (!isShuttingDown && !getOwnerSessionId(ownerUid)) {
          console.log(`Restoring session ${sessionId} for user ${ownerUid}`);
          startSession(ownerUid, sessionData.accountId || 'legacy', sessionData.server, null, true, 1, sessionId);
        }
      }, delay);

      delay += CONFIG.SESSION_RESTORE_DELAY_MS;
    }

    userStore.data = users;
    await userStore.save(true);
  }

  async function watchdogRestoreMissingSessions() {
    try {
      if (!storesInitialized || isShuttingDown) return;
      const storedIds = Object.keys(activeSessionsStore || {});
      if (!storedIds.length) return;

      let delay = 0;
      for (const sessionId of storedIds) {
        if (sessions.has(sessionId)) continue;
        const sessionData = activeSessionsStore[sessionId];
        if (!sessionData || typeof sessionData !== 'object') continue;

        const ownerUid = String(sessionData.ownerUid || '');
        if (!ownerUid || getOwnerSessionId(ownerUid)) continue;
        if (!hasAccess(ownerUid)) continue;
        const hasServer = !!(sessionData.server && sessionData.server.ip && sessionData.server.port);
        if (!hasServer) continue;

        setTimeout(() => {
          if (isShuttingDown) return;
          if (sessions.has(sessionId) || getOwnerSessionId(ownerUid)) return;
          console.log(`Watchdog restoring missing session ${sessionId} for user ${ownerUid}`);
          startSession(ownerUid, sessionData.accountId || 'legacy', sessionData.server, null, true, 1, sessionId);
        }, delay);

        delay += 2000;
      }
    } catch (e) {
      console.error('Watchdog error:', e && e.message ? e.message : e);
    }
  }

  async function gracefulShutdown(signal) {
    console.log(`Shutting down due to ${signal}...`);
    isShuttingDown = true;

    const forceExit = setTimeout(() => process.exit(1), 15000);

    try {
      if (apiServer) {
        await new Promise((resolve) => {
          try {
            apiServer.close(() => resolve());
          } catch (_) {
            resolve();
          }
        });
      }
      await saveAllSessionData();
      await Promise.all([userStore.save(true), sessionStore.save(true), codesStore.save(true)]);
      await cleanupAllSessions();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (e) {
      console.error('Shutdown error:', e && e.message ? e.message : e);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  async function handleAuthRedeem(req, res) {
    const ip = getRequestIp(req);
    if (!checkRateLimit(ip, CONFIG.REDEEM_RATE_LIMIT_MAX, CONFIG.REDEEM_RATE_LIMIT_WINDOW_MS)) {
      return fail(res, 429, 'Too many redeem attempts. Try again later.');
    }

    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      return fail(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, e.message === 'BODY_TOO_LARGE' ? 'Request body too large.' : 'Invalid JSON body.');
    }

    const code = normalizeCode(body.code);
    if (!isValidCodeFormat(code)) {
      return fail(res, 400, 'Invalid code format.');
    }

    const client = getClientDetails(req);
    const entry = codesData.codes[code];
    if (!entry || typeof entry !== 'object') {
      return fail(res, 403, 'Invalid code.');
    }

    const expiresAt = typeof entry.expiresAt === 'number' ? entry.expiresAt : (entry.createdAt || 0) + CONFIG.CODE_TTL_MS;
    if (!entry.used && expiresAt && nowMs() >= expiresAt) {
      delete codesData.codes[code];
      codesStore.data = codesData;
      await codesStore.save(true);
      return fail(res, 403, 'Code expired.');
    }

    if (entry.used) {
      const existingUid = entry.userId ? String(entry.userId) : null;
      const existingUser = existingUid ? ensureUserObject(existingUid) : null;
      if (!existingUid || !existingUser || existingUser._temp) {
        return fail(res, 403, 'Code already used.');
      }
      if (!isSameTrustedClient(existingUser, client)) {
        return fail(res, 403, 'Code already used on another device or IP.');
      }

      const token = issueFreshTokenForUser(existingUid);
      if (!token) {
        return fail(res, 500, 'Failed to restore access.');
      }

      existingUser.lastActive = nowMs();
      existingUser.redeemedAt = nowMs();
      existingUser.redeemedCode = code;
      if (!existingUser.access || typeof existingUser.access !== 'object') existingUser.access = { enabled: true };
      existingUser.access.enabled = true;
      existingUser.access.lastResumeAt = nowMs();
      rememberClientForUser(existingUid, client, 'redeem_resume');

      entry.lastResumeAt = nowMs();
      entry.lastResumeIp = client.ip;
      entry.lastResumeFingerprint = client.fingerprint;

      userStore.data = users;
      codesStore.data = codesData;
      await Promise.all([userStore.save(true), codesStore.save(true)]);

      return ok(res, {
        token,
        userId: existingUid,
        linkedAccounts: listAccounts(existingUid).map(buildPublicAccount),
        resumed: true,
      });
    }

    const userId = makeNumericUserId();
    users[userId] = {
      connectionType: 'online',
      bedrockVersion: 'auto',
      createdAt: nowMs(),
      lastActive: nowMs(),
      access: {
        enabled: true,
        grantedAt: nowMs(),
        source: 'access_code',
      },
      microsoftAccounts: [],
      servers: [],
      ipHistory: [],
      knownClients: [],
      apiTokenHash: null,
      redeemedCode: code,
      redeemedAt: nowMs(),
    };

    const token = issueFreshTokenForUser(userId);
    rememberClientForUser(userId, client, 'redeem_new');

    entry.used = true;
    entry.userId = userId;
    entry.usedAt = nowMs();
    entry.firstIp = client.ip;
    entry.firstFingerprint = client.fingerprint;

    userStore.data = users;
    codesStore.data = codesData;
    await Promise.all([userStore.save(true), codesStore.save(true)]);

    return ok(res, {
      token,
      userId,
      linkedAccounts: [],
      resumed: false,
    });
  }

  async function handleAuthMe(req, res, auth) {
    const u = auth.user;
    const sessionId = getOwnerSessionId(auth.uid);
    const session = sessionId ? sessions.get(sessionId) : null;

    return ok(res, {
      userId: auth.uid,
      createdAt: u.createdAt || null,
      lastActive: u.lastActive || null,
      connectionType: u.connectionType || 'online',
      bedrockVersion: u.bedrockVersion || 'auto',
      linkedAccounts: listAccounts(auth.uid).map(buildPublicAccount),
      lastKnownIp: u.lastKnownIp || null,
      knownIps: Array.isArray(u.ipHistory) ? u.ipHistory.map((entry) => entry.ip).filter(Boolean).slice(0, 10) : [],
      bot: session
        ? {
            sessionId: session.sessionId,
            status: session.status,
            connected: session.connected,
            server: formatServerLabel(session.server),
            startedAt: session.startedAt,
            uptimeMs: session.startedAt ? nowMs() - session.startedAt : 0,
          }
        : null,
    });
  }

  async function handleAuthLogout(req, res, auth) {
    const client = auth && auth.client ? auth.client : getClientDetails(req);
    rememberClientForUser(auth.uid, client, 'logout');

    const stopped = await stopBotForUser(auth.uid);
    await clearStoredSessionsForOwner(auth.uid);
    clearUserToken(auth.uid);

    const u = ensureUserObject(auth.uid);
    u.lastLogoutAt = nowMs();
    u.lastLogoutIp = client.ip;
    if (u.access && typeof u.access === 'object') {
      u.access.lastLogoutAt = u.lastLogoutAt;
    }

    userStore.data = users;
    await userStore.save(true);

    return ok(res, {
      signedOut: true,
      stopped,
      reusableOnSameClient: true,
      reusableCode: u.redeemedCode || null,
    });
  }

  async function handleAccountsList(req, res, auth) {
    const pending = pendingLink.get(auth.uid) || null;
    return ok(res, {
      linked: listAccounts(auth.uid).map(buildPublicAccount),
      pendingLink: pending
        ? {
            status: pending.status,
            verificationUri: pending.verificationUri || null,
            userCode: pending.userCode || null,
            accountId: pending.accountId || null,
            error: pending.error || null,
            createdAt: pending.createdAt || null,
            expiresAt: pending.expiresAt || null,
          }
        : null,
    });
  }

  async function handleAccountLinkStart(req, res, auth) {
    const existing = pendingLink.get(auth.uid);
    if (existing && (existing.status === 'starting' || existing.status === 'pending')) {
      return ok(res, {
        status: existing.status,
        verificationUri: existing.verificationUri || null,
        userCode: existing.userCode || null,
        accountId: existing.accountId || null,
      });
    }

    let prismarineAuth;
    try {
      prismarineAuth = require('prismarine-auth');
    } catch (e) {
      return fail(res, 500, `prismarine-auth is not installed: ${e && e.message ? e.message : e}`);
    }

    const Authflow = prismarineAuth.Authflow;
    const Titles = prismarineAuth.Titles;

    const accountId = makeId('acc_');
    const authDir = await getUserAuthDir(auth.uid, accountId);
    if (!authDir) {
      return fail(res, 500, 'Could not create auth directory.');
    }

    const state = {
      accountId,
      status: 'starting',
      verificationUri: null,
      userCode: null,
      createdAt: nowMs(),
      expiresAt: nowMs() + CONFIG.LINK_TIMEOUT_MS,
      error: null,
    };
    pendingLink.set(auth.uid, state);

    let callbackSeen = false;
    let callbackResolve;
    const callbackPromise = new Promise((resolve) => {
      callbackResolve = resolve;
    });

    try {
      const flow = new Authflow(
        auth.uid,
        authDir,
        {
          flow: 'live',
          authTitle: Titles && Titles.MinecraftNintendoSwitch ? Titles.MinecraftNintendoSwitch : 'Bedrock AFK Bot',
          deviceType: 'Nintendo',
        },
        async (data) => {
          callbackSeen = true;
          state.status = 'pending';
          state.verificationUri = data && (data.verification_uri_complete || data.verification_uri) ? data.verification_uri_complete || data.verification_uri : 'https://www.microsoft.com/link';
          state.userCode = data && data.user_code ? data.user_code : null;
          if (callbackResolve) callbackResolve();
        },
      );

      flow
        .getMsaToken()
        .then(async () => {
          const u = ensureUserObject(auth.uid);
          if (!Array.isArray(u.microsoftAccounts)) u.microsoftAccounts = [];
          if (!u.microsoftAccounts.some((a) => a && a.id === accountId)) {
            u.microsoftAccounts.push({
              id: accountId,
              createdAt: nowMs(),
              tokenAcquiredAt: nowMs(),
              lastUsedAt: null,
            });
          }
          u.linked = true;
          u.tokenAcquiredAt = nowMs();
          state.status = 'success';
          state.completedAt = nowMs();
          userStore.data = users;
          await userStore.save(true);
        })
        .catch((e) => {
          state.status = 'error';
          state.error = e && e.message ? e.message : 'Authentication failed';
        });

      await Promise.race([callbackPromise, sleep(3000)]);

      return ok(res, {
        status: state.status,
        verificationUri: state.verificationUri,
        userCode: state.userCode,
        accountId: state.accountId,
      });
    } catch (e) {
      pendingLink.delete(auth.uid);
      return fail(res, 500, callbackSeen ? 'Failed to continue login.' : `Failed to start login: ${e && e.message ? e.message : e}`);
    }
  }

  async function handleAccountLinkStatus(req, res, auth) {
    const pending = pendingLink.get(auth.uid);
    if (!pending) {
      return ok(res, { status: 'none' });
    }

    if (pending.status === 'success' || pending.status === 'error') {
      const payload = {
        status: pending.status,
        verificationUri: pending.verificationUri || null,
        userCode: pending.userCode || null,
        accountId: pending.accountId || null,
        error: pending.error || null,
      };
      return ok(res, payload);
    }

    return ok(res, {
      status: pending.status,
      verificationUri: pending.verificationUri || null,
      userCode: pending.userCode || null,
      accountId: pending.accountId || null,
      expiresAt: pending.expiresAt || null,
    });
  }

  async function handleAccountUnlink(req, res, auth) {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      return fail(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, e.message === 'BODY_TOO_LARGE' ? 'Request body too large.' : 'Invalid JSON body.');
    }

    const accounts = listAccounts(auth.uid);
    if (!accounts.length) {
      return ok(res, { removed: false, message: 'No linked account to remove.' });
    }

    const accountId = body.accountId ? String(body.accountId) : accounts[0].id;
    const removed = await unlinkMicrosoftAccount(auth.uid, accountId);
    return ok(res, { removed, accountId });
  }

  async function handleBotStart(req, res, auth) {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      return fail(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, e.message === 'BODY_TOO_LARGE' ? 'Request body too large.' : 'Invalid JSON body.');
    }

    await enforceSingleBotPerUser(auth.uid);

    const existingSessionId = getOwnerSessionId(auth.uid);
    if (existingSessionId && sessions.has(existingSessionId)) {
      const existing = sessions.get(existingSessionId);
      return fail(res, 409, 'Bot already running.', {
        data: {
          sessionId: existing.sessionId,
          status: existing.status,
          server: formatServerLabel(existing.server),
        },
      });
    }

    const storedSessionIds = getStoredSessionIdsForOwner(auth.uid);
    if (!existingSessionId && storedSessionIds.length > 0) {
      const stored = activeSessionsStore[storedSessionIds[0]];
      return fail(res, 409, 'Bot already running.', {
        data: {
          sessionId: storedSessionIds[0],
          status: 'restoring',
          server: formatServerLabel(stored && stored.server),
        },
      });
    }

    const capacity = canAcceptNewBot();
    if (!capacity.ok) {
      return fail(res, 503, capacity.error);
    }

    const ip = String(body.ip || '').trim();
    const port = body.port === undefined || body.port === null || body.port === '' ? 19132 : parseInt(String(body.port), 10);
    const connectionType = body.connectionType === 'offline' ? 'offline' : 'online';
    const offlineUsername = body.offlineUsername ? String(body.offlineUsername).trim() : null;
    const bedrockVersion = body.bedrockVersion ? String(body.bedrockVersion).trim() : 'auto';
    const accountId = body.accountId ? String(body.accountId).trim() : null;

    if (!ip || !isValidIP(ip)) return fail(res, 400, 'Invalid server IP or hostname.');
    if (!isValidPort(port)) return fail(res, 400, 'Invalid port.');
    if (isPrivateOrLocalHost(ip)) return fail(res, 400, 'Private or local server targets are not allowed.');

    const u = ensureUserObject(auth.uid);
    u.connectionType = connectionType;
    u.bedrockVersion = bedrockVersion || 'auto';
    if (offlineUsername) u.offlineUsername = offlineUsername;
    if (connectionType !== 'offline' && !listAccounts(auth.uid).length) {
      return fail(res, 400, 'No linked Microsoft account.');
    }

    const sessionId = await startSession(auth.uid, accountId, { ip, port }, null, false, 1, null);
    if (!sessionId) {
      return fail(res, 500, 'Failed to start bot.');
    }

    const s = sessions.get(sessionId);
    return ok(res, {
      sessionId,
      status: s ? s.status : 'starting',
      server: `${ip}:${port}`,
      connectionType,
      bedrockVersion,
    });
  }

  async function handleBotStop(req, res, auth) {
    const stopped = await stopBotForUser(auth.uid);
    if (!stopped) return fail(res, 404, 'No active bot.');
    return ok(res, { stopped: true });
  }

  async function handleBotReconnect(req, res, auth) {
    const sessionId = getOwnerSessionId(auth.uid);
    if (!sessionId) return fail(res, 404, 'No active bot.');
    const reconnected = await reconnectBotForUser(auth.uid);
    if (!reconnected) return fail(res, 500, 'Failed to reconnect bot.');
    const s = sessions.get(sessionId);
    return ok(res, {
      reconnected: true,
      sessionId,
      status: s ? s.status : 'reconnecting',
    });
  }

  async function handleBotStatus(req, res, auth) {
    const sessionId = getOwnerSessionId(auth.uid);
    if (!sessionId) {
      return ok(res, {
        sessionId: null,
        status: 'offline',
      });
    }

    const s = sessions.get(sessionId);
    if (!s) {
      return ok(res, {
        sessionId: null,
        status: 'offline',
      });
    }

    return ok(res, {
      sessionId: s.sessionId,
      status: s.status,
      connected: s.connected,
      isReconnecting: !!s.isReconnecting,
      reconnectAttempt: s.reconnectAttempt || 0,
      server: formatServerLabel(s.server),
      startedAt: s.startedAt,
      uptimeMs: s.startedAt ? nowMs() - s.startedAt : 0,
      lastConnectedAt: s.lastConnectedAt || null,
      lastError: s.lastError || null,
      lastDisconnectReason: s.lastDisconnectReason || null,
      connectionType: s.connectionType,
      accountId: s.accountId,
    });
  }

  function createApiServer() {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req || !req.url) return fail(res, 400, 'Bad request.');

        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.setHeader('Access-Control-Allow-Origin', CONFIG.CORS_ORIGIN);
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Device-ID, X-Client-Device-Name, X-Client-Platform, X-Client-Model');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          return res.end();
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        if (req.method === 'GET' && pathname === '/') {
          return ok(res, {
            name: 'AFKBot API',
            version: 1,
            endpoints: [
              'POST /auth/redeem',
              'GET /auth/me',
              'POST /auth/logout',
              'GET /accounts',
              'POST /accounts/link/start',
              'GET /accounts/link/status',
              'POST /accounts/unlink',
              'POST /bots/start',
              'POST /bots/stop',
              'POST /bots/reconnect',
              'GET /bots',
              'GET /forcestopall',
              'POST /forcestopall',
              'GET /health',
            ],
          });
        }

        if (req.method === 'GET' && pathname === '/health') {
          return ok(res, {
            status: 'ok',
            uptimeSec: Math.floor(process.uptime()),
            bots: sessions.size,
            memoryMb: getMemoryMb(),
            maxBots: CONFIG.GLOBAL_MAX_BOTS,
          });
        }

        if (req.method === 'POST' && pathname === '/auth/redeem') {
          return handleAuthRedeem(req, res);
        }

        if ((req.method === 'GET' || req.method === 'POST') && pathname === '/forcestopall') {
          const result = await forceStopAllSessionsSilently();
          return ok(res, {
            success: true,
            message: 'Force-stopped all sessions silently.',
            ...result,
          });
        }

        const auth = authenticateRequest(req);
        if (!auth) {
          return fail(res, 401, 'Unauthorized.');
        }

        if (req.method === 'GET' && pathname === '/auth/me') {
          return handleAuthMe(req, res, auth);
        }
        if (req.method === 'POST' && pathname === '/auth/logout') {
          return handleAuthLogout(req, res, auth);
        }
        if (req.method === 'GET' && pathname === '/accounts') {
          return handleAccountsList(req, res, auth);
        }
        if (req.method === 'POST' && pathname === '/accounts/link/start') {
          return handleAccountLinkStart(req, res, auth);
        }
        if (req.method === 'GET' && pathname === '/accounts/link/status') {
          return handleAccountLinkStatus(req, res, auth);
        }
        if (req.method === 'POST' && pathname === '/accounts/unlink') {
          return handleAccountUnlink(req, res, auth);
        }
        if (req.method === 'POST' && pathname === '/bots/start') {
          return handleBotStart(req, res, auth);
        }
        if (req.method === 'POST' && pathname === '/bots/stop') {
          return handleBotStop(req, res, auth);
        }
        if (req.method === 'POST' && pathname === '/bots/reconnect') {
          return handleBotReconnect(req, res, auth);
        }
        if (req.method === 'GET' && pathname === '/bots') {
          return handleBotStatus(req, res, auth);
        }

        return fail(res, 404, 'Not found.');
      } catch (e) {
        console.error('HTTP handler error:', e && (e.stack || e.message) ? e.stack || e.message : e);
        return fail(res, 500, 'Internal server error.');
      }
    });

    server.keepAliveTimeout = 5000;
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxRequestsPerSocket = 100;
    return server;
  }

  async function startApiServer() {
    apiServer = createApiServer();
    await new Promise((resolve, reject) => {
      apiServer.once('error', reject);
      apiServer.listen(CONFIG.PORT, '0.0.0.0', () => {
        apiServer.off('error', reject);
        resolve();
      });
    });
    console.log(`AFKBot API listening on :${CONFIG.PORT}`);
  }

  await initializeStores();
  await startApiServer();

  setInterval(() => {
    const mem = getMemoryMb();
    if (mem > CONFIG.MAX_MEMORY_MB) {
      console.warn(`High memory usage: ${mem}MB`);
      if (global.gc) global.gc();
    }
  }, CONFIG.MEMORY_CHECK_INTERVAL_MS).unref?.();

  setInterval(() => {
    cleanupRateLimits();
  }, 5 * 60_000).unref?.();

  setInterval(() => {
    cleanupExpiredCodes().catch((e) => console.error('Code cleanup error:', e && e.message ? e.message : e));
  }, CONFIG.CODE_CLEANUP_INTERVAL_MS).unref?.();

  setInterval(() => {
    createNewCodeAndSend().catch((e) => console.error('Code generation error:', e && e.message ? e.message : e));
  }, CONFIG.CODE_GENERATION_INTERVAL_MS).unref?.();

  setInterval(() => {
    const now = nowMs();
    for (const [uid, state] of pendingLink.entries()) {
      if (!state || !state.expiresAt) continue;
      if (state.status === 'success' || state.status === 'error') {
        if (now - (state.completedAt || state.createdAt || now) > 10 * 60_000) {
          pendingLink.delete(uid);
        }
        continue;
      }
      if (now >= state.expiresAt) {
        state.status = 'error';
        state.error = 'Login timed out.';
      }
    }
  }, 30_000).unref?.();

  setTimeout(() => {
    maybeGenerateStartupCode().catch((e) => console.error('Startup code generation error:', e && e.message ? e.message : e));
  }, 1000).unref?.();

  setTimeout(() => {
    restoreSessions().catch((e) => console.error('Restore sessions error:', e && e.message ? e.message : e));
  }, 5000).unref?.();

  setInterval(() => {
    watchdogRestoreMissingSessions();
  }, CONFIG.SESSION_WATCHDOG_INTERVAL_MS).unref?.();

  setInterval(() => {
    console.log(`Heartbeat | Sessions: ${sessions.size} | Memory: ${getMemoryMb()}MB | Uptime: ${Math.floor(process.uptime() / 60)}m`);
  }, 60_000).unref?.();
}

// ==================== ENTRYPOINT ====================

(async () => {
  if (IS_WORKER) {
    await runWorker();
  } else {
    await runParent();
  }
})();
