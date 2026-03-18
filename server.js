import express from 'express';
import cors from 'cors';
import session from 'express-session';
import crypto from 'crypto';
import whatsapp from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import * as db from './db.js';

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

dotenv.config();
db.initDb();

const { Client, LocalAuth, MessageMedia } = whatsapp;

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json'
};
function getMimetype(filename, explicit) {
  if (explicit && typeof explicit === 'string') return explicit;
  if (!filename || typeof filename !== 'string') return 'application/octet-stream';
  const ext = filename.split('.').pop()?.toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
const app = express();
const server = createServer(app);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INSTANCES_FILE = join(__dirname, 'instances.json');

// CORS: allow Vite dev server and same-origin (for built UI)
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = !origin || origin === 'http://localhost:3000' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      cb(null, allowed);
    },
    credentials: true
  })
);

// Session must be before WebSocket upgrade so we can use it in upgrade handler
// Session expiry:
// - SESSION_TTL_SECONDS env var (default: 24h)
// - cookie.maxAge enforces absolute expiry on the browser
// - rolling: true refreshes expiry on each request
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24); // default 24h
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: SESSION_TTL_SECONDS * 1000,
    secure: process.env.NODE_ENV === 'production' ? true : false,
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
  }
});
app.use(sessionMiddleware);
app.set('trust proxy', 1); // trust first proxy
// JSON body size limit: allow large send-file payloads (base64 is ~1.33x file size). Default 10mb.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '10mb';
// Skip JSON body parsing for webhook path so we can use raw body for signature verification
app.use((req, res, next) => {
  if (req.path.startsWith('/webhook/')) return next();
  express.json({ limit: JSON_BODY_LIMIT })(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));
app.use(express.static('public'));
const uiDist = join(__dirname, 'ui', 'dist');
if (existsSync(uiDist)) {
  app.use(express.static(uiDist));
}

// WhatsApp instances storage
const whatsappInstances = new Map();
const instanceClients = new Map(); // Map to track WebSocket clients per instance

async function loadInstanceNames() {
  try {
    const data = await readFile(INSTANCES_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('Failed to load instances.json:', err.message);
    return [];
  }
}

async function saveInstanceNames(names) {
  await writeFile(INSTANCES_FILE, JSON.stringify(names, null, 2), 'utf-8');
}

function sameLinkedAccount(left, right) {
  if (!left || !right) return false;
  if (left.jid && right.jid) return left.jid === right.jid;
  if (left.number && right.number) return left.number === right.number;
  return false;
}

function getLinkedAccountLabel(account) {
  if (!account) return null;
  if (account.name && account.number) return `${account.name} (${account.number})`;
  return account.name || account.number || account.jid || null;
}

function getClientLinkedAccount(client) {
  const info = client?.info;
  const jid = info?.wid?._serialized || null;
  const number = info?.wid?.user || (jid ? jid.replace(/@.*$/, '') : null);
  const name = info?.pushname || null;
  if (!jid && !number && !name) return null;
  return {
    jid,
    number,
    name,
    label: getLinkedAccountLabel({ jid, number, name })
  };
}

function toPublicLinkedAccount(account) {
  if (!account) return null;
  return {
    jid: account.jid || null,
    number: account.number || null,
    name: account.name || null,
    label: account.label || getLinkedAccountLabel(account)
  };
}

function classifyMessageKind(fromJid, isStatus = false) {
  if (isStatus) return 'status';
  const jid = typeof fromJid === 'string' ? fromJid : '';
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return 'status';
  if (jid.endsWith('@g.us')) return 'group';
  return 'individual';
}

async function syncInstanceLinkedAccount(instanceId) {
  const instance = whatsappInstances.get(instanceId);
  if (!instance) return;
  const current = getClientLinkedAccount(instance.client);
  const previous = db.getInstanceLinkedAccount(instanceId);

  instance.previousLinkedAccount = null;
  instance.linkedAccountChanged = false;

  if (!current) {
    instance.linkedAccount = previous ? toPublicLinkedAccount(previous) : null;
    return;
  }

  const currentPublic = toPublicLinkedAccount(current);
  if (previous && !sameLinkedAccount(previous, currentPublic)) {
    instance.previousLinkedAccount = toPublicLinkedAccount(previous);
    instance.linkedAccountChanged = true;
    console.warn(
      `[instance] ${instanceId} re-linked from ${getLinkedAccountLabel(previous)} to ${getLinkedAccountLabel(currentPublic)}`
    );
  }

  instance.linkedAccount = currentPublic;
  db.setInstanceLinkedAccount(instanceId, currentPublic);
}

function serializeInstance(instanceId, includeQr = false) {
  const instance = whatsappInstances.get(instanceId);
  if (!instance) return null;
  return {
    id: instanceId,
    status: instance.status,
    linkedAccount: instance.linkedAccount || null,
    linkedAccountChanged: Boolean(instance.linkedAccountChanged),
    previousLinkedAccount: instance.previousLinkedAccount || null,
    ...(includeQr ? { qr: instance.qr } : {})
  };
}

// Authentication middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = db.getUserById(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    next();
  });
}

/** Auth for instance-scoped routes: accept X-API-Key (must match this instance) or session with access */
function requireInstanceAccess(req, res, next) {
  const instanceId = req.params.instanceId;
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (apiKey) {
    const keyInstanceId = db.getInstanceIdByApiKey(apiKey);
    if (keyInstanceId === instanceId && whatsappInstances.has(instanceId)) {
      req.instanceId = instanceId;
      return next();
    }
    return res.status(401).json({ error: 'Invalid API key or instance' });
  }
  requireAuth(req, res, () => {
    if (!whatsappInstances.has(instanceId)) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    if (!db.userCanAccessInstance(req.user.id, req.user.role, instanceId)) {
      return res.status(403).json({ error: 'Access denied to this instance' });
    }
    req.instanceId = instanceId;
    next();
  });
}

/** Auth for webhook: API key only (no session). Key must match instanceId. */
function requireWebhookAuth(req, res, next) {
  const instanceId = req.params.instanceId;
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'API key required (X-API-Key or Bearer)' });
  }
  const keyInstanceId = db.getInstanceIdByApiKey(apiKey);
  if (keyInstanceId !== instanceId || !whatsappInstances.has(instanceId)) {
    return res.status(401).json({ success: false, error: 'Invalid API key or instance' });
  }
  req.instanceId = instanceId;
  next();
}

// Routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.verifyLogin(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.userId = user.id;
  res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
  if (!req.session.userId) {
    return res.json({ authenticated: false });
  }
  const user = db.getUserById(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// WhatsApp instance management (filtered by role)
app.get('/api/instances', requireAuth, (req, res) => {
  const allIds = Array.from(whatsappInstances.keys());
  const allowedIds = db.getInstanceIdsForUser(req.user.id, req.user.role);
  const ids = allowedIds === null ? allIds : allIds.filter(id => allowedIds.includes(id));
  const instances = ids.map((id) => serializeInstance(id)).filter(Boolean);
  res.json(instances);
});

async function createAndInitializeInstance(instanceId) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: instanceId }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  const instance = {
    client,
    status: 'initializing',
    qr: null,
    linkedAccount: toPublicLinkedAccount(db.getInstanceLinkedAccount(instanceId)),
    linkedAccountChanged: false,
    previousLinkedAccount: null
  };

  whatsappInstances.set(instanceId, instance);
  if (!instanceClients.has(instanceId)) {
    instanceClients.set(instanceId, new Set());
  }

  client.on('qr', async (qr) => {
    instance.qr = qr;
    instance.status = 'qr_ready';
    console.log(`QR code generated for instance ${instanceId}`);
    console.log(qr);
    const qrDataUrl = await QRCode.toDataURL(qr);
    broadcastToInstance(instanceId, {
      type: 'qr',
      instanceId,
      qr: qrDataUrl,
      linkedAccount: instance.linkedAccount,
      linkedAccountChanged: instance.linkedAccountChanged,
      previousLinkedAccount: instance.previousLinkedAccount
    });
  });

  client.on('ready', async () => {
    instance.status = 'ready';
    instance.qr = null;
    await syncInstanceLinkedAccount(instanceId);
    broadcastToInstance(instanceId, {
      type: 'ready',
      instanceId,
      linkedAccount: instance.linkedAccount,
      linkedAccountChanged: instance.linkedAccountChanged,
      previousLinkedAccount: instance.previousLinkedAccount
    });
  });

  client.on('authenticated', () => {
    instance.status = 'authenticated';
    broadcastToInstance(instanceId, { type: 'authenticated', instanceId });
  });

  client.on('disconnected', (reason) => {
    instance.status = 'disconnected';
    broadcastToInstance(instanceId, { type: 'disconnected', instanceId, reason });
  });

  // Incoming message listener: save to DB and broadcast to WebSocket subscribers (always announce to subscribers)
  client.on('message', async (message) => {
    if (message.fromMe) return;
    const id = message.id;
    const messageIdSerialized =
      typeof id === 'object' && id != null && typeof id._serialized === 'string' ? id._serialized : String(id);
    const fromJid = message.from || null;
    const body = message.body || '';
    const messageTimestamp = message.timestamp != null ? Number(message.timestamp) : null;
    const messageKind = classifyMessageKind(fromJid, Boolean(message.isStatus));
    let groupName = null;
    let senderNumber = null;

    if (messageKind === 'group') {
      try {
        const chat = await message.getChat();
        groupName = chat?.name || null;
      } catch {
        groupName = null;
      }
    }

    let senderDisplay = fromJid;
    try {
      const contact = await message.getContact();
      senderNumber = contact?.number || (message.author ? String(message.author).replace(/@.*$/, '') : null);
      if (contact && (contact.pushname || contact.name || contact.number)) {
        senderDisplay = contact.pushname || contact.name || contact.number || fromJid;
      } else if (fromJid) {
        senderDisplay = fromJid.replace('@c.us', '').replace('@g.us', '');
      }
    } catch {
      senderNumber = message.author ? String(message.author).replace(/@.*$/, '') : null;
      if (fromJid) senderDisplay = fromJid.replace('@c.us', '').replace('@g.us', '');
    }

    if (!senderNumber && fromJid && fromJid.endsWith('@c.us')) {
      senderNumber = fromJid.replace('@c.us', '');
    }

    try {
      db.insertMessage(instanceId, messageIdSerialized, fromJid, senderDisplay, senderNumber, groupName, body, messageTimestamp, 'native', messageKind);
    } catch (e) {
      console.error(`[message] instance=${instanceId} insertMessage failed:`, e.message);
    }

    const payload = {
      messageId: messageIdSerialized,
      from: fromJid,
      to: message.to || null,
      body,
      timestamp: messageTimestamp,
      fromMe: false,
      hasMedia: Boolean(message.hasMedia),
      type: message.type || null,
      author: message.author || null,
      isStatus: Boolean(message.isStatus),
      isForwarded: Boolean(message.isForwarded),
      hasQuotedMsg: Boolean(message.hasQuotedMsg),
      senderDisplay,
      senderNumber,
      groupName,
      source: 'native',
      messageKind
    };
    broadcastToInstance(instanceId, { type: 'message', instanceId, message: payload }, 'native');
  });

  await client.initialize();
}

app.post('/api/instances', requireAdmin, async (req, res) => {
  const { instanceId } = req.body;

  if (!instanceId) {
    return res.status(400).json({ error: 'Instance ID required' });
  }

  if (whatsappInstances.has(instanceId)) {
    return res.status(400).json({ error: 'Instance already exists' });
  }

  try {
    await createAndInitializeInstance(instanceId);
    const names = await loadInstanceNames();
    if (!names.includes(instanceId)) {
      names.push(instanceId);
      await saveInstanceNames(names);
    }
    if (!db.getInstanceApiKey(instanceId)) {
      db.setInstanceApiKey(instanceId, generateApiKey());
    }
    res.json({ success: true, instanceId });
  } catch (error) {
    whatsappInstances.delete(instanceId);
    instanceClients.delete(instanceId);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/instances/:instanceId', requireAdmin, async (req, res) => {
  const { instanceId } = req.params;

  if (!whatsappInstances.has(instanceId)) {
    return res.status(404).json({ error: 'Instance not found' });
  }

  try {
    const instance = whatsappInstances.get(instanceId);
    await instance.client.destroy();
    whatsappInstances.delete(instanceId);
    instanceClients.delete(instanceId);
    db.deleteInstanceApiKey(instanceId);
    db.deleteInstanceLinkedAccount(instanceId);
    db.deleteMessagesForInstance(instanceId);

    const names = await loadInstanceNames();
    const updated = names.filter((n) => n !== instanceId);
    await saveInstanceNames(updated);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Instance API key (session or API key auth)
app.get('/api/instances/:instanceId/api-key', requireInstanceAccess, (req, res) => {
  const key = db.getInstanceApiKey(req.instanceId);
  if (!key) {
    const newKey = generateApiKey();
    db.setInstanceApiKey(req.instanceId, newKey);
    return res.json({ apiKey: newKey });
  }
  res.json({ apiKey: key });
});

app.post('/api/instances/:instanceId/api-key/regenerate', requireInstanceAccess, (req, res) => {
  const newKey = generateApiKey();
  db.setInstanceApiKey(req.instanceId, newKey);
  res.json({ apiKey: newKey });
});

/** Normalize "to" to a WhatsApp chat JID: accept group JID (@g.us) or user JID (@c.us), or phone number → @c.us */
function toChatId(to) {
  const s = String(to).trim();
  if (s.endsWith('@g.us') || s.endsWith('@c.us')) return s;
  return s.replace(/\D/g, '') + '@c.us';
}

// Send message (session or API key auth). Body: { to: string (phone with country code or JID), message: string }
app.post('/api/instances/:instanceId/send-message', requireInstanceAccess, async (req, res) => {
  const { to, message } = req.body;
  const instanceId = req.instanceId;
  console.log(`[send-message] request instance=${instanceId} to=${to || '(missing)'} messageLength=${message != null ? String(message).length : 0}`);

  if (!to || !message || typeof message !== 'string') {
    console.log(`[send-message] instance=${instanceId} validation failed: to and message required`);
    return res.status(400).json({ error: 'to and message required' });
  }
  const instance = whatsappInstances.get(instanceId);
  if (instance.status !== 'ready') {
    console.log(`[send-message] instance=${instanceId} rejected: not ready (status=${instance?.status})`);
    return res.status(503).json({ error: 'Instance not ready. Wait for WhatsApp to connect.' });
  }
  const chatId = toChatId(to);
  console.log(`[send-message] instance=${instanceId} sending to chatId=${chatId}`);
  try {
    const sent = await instance.client.sendMessage(chatId, message);
    console.log(`[send-message] instance=${instanceId} to=${chatId} success messageId=${sent.id?._serialized || '(n/a)'}`);
    res.json({ success: true, messageId: sent.id?._serialized || null });
  } catch (err) {
    console.log(`[send-message] instance=${instanceId} to=${chatId} error: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to send message' });
  }
});

// Send file with optional caption. Body: { to, filename, fileBase64, caption?, mimetype? }
app.post('/api/instances/:instanceId/send-file', requireInstanceAccess, async (req, res) => {
  const { to, filename, fileBase64, caption, mimetype } = req.body;
  const instanceId = req.instanceId;
  console.log(`[send-file] request instance=${instanceId} to=${to || '(missing)'} filename=${filename || '(missing)'} captionLength=${caption != null ? String(caption).length : 0}`);

  if (!to || !filename || !fileBase64 || typeof fileBase64 !== 'string') {
    console.log(`[send-file] instance=${instanceId} validation failed: to, filename and fileBase64 required`);
    return res.status(400).json({ error: 'to, filename and fileBase64 required' });
  }
  const instance = whatsappInstances.get(instanceId);
  if (instance.status !== 'ready') {
    console.log(`[send-file] instance=${instanceId} rejected: not ready (status=${instance?.status})`);
    return res.status(503).json({ error: 'Instance not ready. Wait for WhatsApp to connect.' });
  }
  let data = fileBase64;
  if (data.includes(',')) {
    data = data.replace(/^data:[^;]+;base64,/, '');
  }
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch (e) {
    console.log(`[send-file] instance=${instanceId} invalid base64 in fileBase64: ${e.message}`);
    return res.status(400).json({ error: 'Invalid base64 in fileBase64' });
  }
  const type = getMimetype(filename, mimetype);
  const media = new MessageMedia(type, data, filename, buffer.length);
  const chatId = toChatId(to);
  console.log(`[send-file] instance=${instanceId} sending file to chatId=${chatId} filename=${filename} mimetype=${type} size=${buffer.length} bytes`);
  // Optional caption: request body field "caption" → sendMessage(chatId, media, { caption: '...' })
  const sendOpts = typeof caption === 'string' && caption.length > 0 ? { caption } : {};
  try {
    const sent = await instance.client.sendMessage(chatId, media, sendOpts);
    console.log(`[send-file] instance=${instanceId} to=${chatId} success messageId=${sent.id?._serialized || '(n/a)'}`);
    res.json({ success: true, messageId: sent.id?._serialized || null });
  } catch (err) {
    console.log(`[send-file] instance=${instanceId} to=${chatId} error: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to send file' });
  }
});

// Get message log for instance (session or API key). Query: limit (default 500)
app.get('/api/instances/:instanceId/messages', requireInstanceAccess, (req, res) => {
  const instanceId = req.instanceId;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);
  const rows = db.getMessagesForInstance(instanceId, limit);
  const messages = rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    from: r.from_jid,
    senderDisplay: r.sender_display,
    senderNumber: r.sender_number || null,
    groupName: r.group_name || null,
    body: r.body,
    source: r.source || 'native',
    messageKind: r.message_kind || classifyMessageKind(r.from_jid),
    timestamp: r.message_timestamp,
    createdAt: r.created_at
  }));
  res.json(messages);
});

app.delete('/api/instances/:instanceId/messages', requireInstanceAccess, (req, res) => {
  const instanceId = req.instanceId;
  const cleared = db.deleteMessagesForInstance(instanceId);
  broadcastToInstance(instanceId, { type: 'messages_cleared', instanceId });
  res.json({ success: true, cleared });
});

// WaHub webhook: receive incoming message events for an instance (API key auth only). See wahub_webhook.md.
function normalizeWebhookMessage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const rawFrom =
    obj.from ??
    obj.sender ??
    (obj.remoteJid ? String(obj.remoteJid) : null) ??
    (obj.key && (obj.key.remoteJid || obj.key.from) ? String(obj.key.remoteJid || obj.key.from) : null) ??
    null;
  if (!rawFrom) return null;
  const rawFromStr = String(rawFrom);
  const fromJid = rawFromStr.includes('@') ? rawFromStr : `${rawFromStr.replace(/\D/g, '')}@c.us`;
  if (!fromJid || fromJid === '@c.us') return null;
  const body =
    obj.body ??
    obj.text ??
    obj.content ??
    (obj.message && (obj.message.conversation ?? (typeof obj.message === 'string' ? obj.message : null))) ??
    '';
  const id = obj.id ?? obj.messageId ?? obj.key?.id ?? null;
  const messageId = id != null ? String(id) : `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const senderDisplay =
    obj.senderDisplay ??
    obj.pushName ??
    obj.pushname ??
    obj.name ??
    obj.notifyName ??
    rawFromStr.replace(/@c\.us$|@g\.us$|@broadcast$/i, '');
  const messageKind = classifyMessageKind(fromJid, Boolean(obj.isStatus));
  const senderNumber =
    obj.senderNumber ??
    obj.phone ??
    obj.mobile ??
    obj.msisdn ??
    (fromJid.endsWith('@c.us') ? fromJid.replace('@c.us', '') : null);
  const groupName =
    obj.groupName ??
    obj.chatName ??
    obj.conversationName ??
    obj.groupSubject ??
    (messageKind === 'group' ? String(senderDisplay) : null);
  return {
    fromJid,
    senderDisplay: String(senderDisplay),
    senderNumber: senderNumber ? String(senderNumber).replace(/\D/g, '') : null,
    groupName: groupName ? String(groupName) : null,
    body: String(body),
    messageId,
    messageKind
  };
}

app.post(
  '/webhook/wahub/:instanceId',
  express.raw({ type: 'application/json', limit: '1mb' }),
  requireWebhookAuth,
  (req, res) => {
    const instanceId = req.instanceId;
    const rawBody = req.body; // Buffer
    const webhookSecret = process.env.WEBHOOK_SECRET;

    if (webhookSecret) {
      const sigHeader = req.headers['x-webhook-signature'] || req.headers['x-wahub-signature'];
      if (!sigHeader || typeof sigHeader !== 'string') {
        return res.status(401).json({ success: false, error: 'Missing webhook signature' });
      }
      const expectedHex = sigHeader.replace(/^sha256=/i, '');
      const hmac = crypto.createHmac('sha256', webhookSecret);
      hmac.update(rawBody);
      const actualHex = hmac.digest('hex');
      if (actualHex !== expectedHex) {
        return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
      }
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid JSON body' });
    }

    const messages = [];
    const event = payload.event ?? payload.type ?? payload.eventType;
    const data = payload.data ?? payload.payload?.data ?? payload.payload ?? payload;

    if (event === 'message' && data && !Array.isArray(data)) {
      const norm = normalizeWebhookMessage(data);
      if (norm) messages.push(norm);
    } else if ((event === 'messages' || event === 'message') && Array.isArray(data)) {
      for (const item of data) {
        const norm = normalizeWebhookMessage(item);
        if (norm) messages.push(norm);
      }
    } else if (payload.message && !Array.isArray(payload.message)) {
      const norm = normalizeWebhookMessage(payload.message);
      if (norm) messages.push(norm);
    } else if (Array.isArray(payload.messages)) {
      for (const item of payload.messages) {
        const norm = normalizeWebhookMessage(item);
        if (norm) messages.push(norm);
      }
    } else if (data && Array.isArray(data.messages)) {
      for (const item of data.messages) {
        const norm = normalizeWebhookMessage(item);
        if (norm) messages.push(norm);
      }
    } else if (payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)) {
      const norm = normalizeWebhookMessage(payload.payload);
      if (norm) messages.push(norm);
    }
    // Fallback: treat whole payload as one message (e.g. { from, body } or { from, text } at top level)
    if (messages.length === 0) {
      const norm = normalizeWebhookMessage(payload);
      if (norm) messages.push(norm);
    }

    if (messages.length === 0) {
      const keys = Object.keys(payload);
      const isConfigOnly = keys.length <= 2 && (keys.includes('webhookUrl') || keys.every((k) => ['webhookUrl', 'event', 'type'].includes(k)));
      if (isConfigOnly && (payload.webhookUrl != null || (payload.event === 'webhook' || payload.type === 'webhook'))) {
        console.log('[webhook] ignored non-message payload (e.g. webhook registration/config); keys:', keys.join(', '));
      } else {
        console.warn('[webhook] no messages extracted from payload; keys:', keys.join(', '), 'full body (truncated):', JSON.stringify(payload).slice(0, 600));
      }
    }

    const now = Math.floor(Date.now() / 1000);
    for (const msg of messages) {
      try {
        db.insertMessage(instanceId, msg.messageId, msg.fromJid, msg.senderDisplay, msg.senderNumber, msg.groupName, msg.body, now, 'webhook', msg.messageKind);
      } catch (e) {
        console.error(`[webhook] instance=${instanceId} insertMessage failed:`, e.message);
      }
      const eventPayload = {
        type: 'message',
        instanceId,
        message: {
          messageId: msg.messageId,
          from: msg.fromJid,
          to: null,
          body: msg.body,
          timestamp: now,
          fromMe: false,
          hasMedia: false,
          type: null,
          author: null,
          isStatus: false,
          isForwarded: false,
          hasQuotedMsg: false,
          senderDisplay: msg.senderDisplay,
          senderNumber: msg.senderNumber,
          groupName: msg.groupName,
          source: 'webhook',
          messageKind: msg.messageKind
        }
      };
      const broadcastResult = broadcastToInstance(instanceId, eventPayload, 'webhook');
      if (broadcastResult.failed > 0 && broadcastResult.errors.length > 0) {
        console.error(`[webhook] instance=${instanceId} messageId=${msg.messageId} broadcast errors:`, broadcastResult.errors);
      }
    }

    if (messages.length > 0) {
      console.log(`[webhook] instance=${instanceId} received ${messages.length} message(s), stored and announced to listeners (see above for delivery)`);
    }
    res.status(200).json({ success: true, received: true });
  }
);

// User management (admin only)
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const id = db.createUser(username, password, role === 'admin' ? 'admin' : 'user');
    res.status(201).json({ id, username, role: role === 'admin' ? 'admin' : 'user' });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Username already exists' });
    }
    throw e;
  }
});

app.post('/api/users/:userId/instances', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const { instanceId } = req.body;
  if (!instanceId || !whatsappInstances.has(instanceId)) {
    return res.status(400).json({ error: 'Valid instanceId required' });
  }
  const user = db.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.assignInstanceToUser(userId, instanceId);
  res.json({ success: true });
});

app.delete('/api/users/:userId/instances/:instanceId', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const { instanceId } = req.params;
  db.removeInstanceFromUser(userId, instanceId);
  res.json({ success: true });
});

app.get('/api/instances/:instanceId/users', requireAdmin, (req, res) => {
  const { instanceId } = req.params;
  if (!whatsappInstances.has(instanceId)) {
    return res.status(404).json({ error: 'Instance not found' });
  }
  res.json(db.getUsersForInstance(instanceId));
});

app.get('/api/users/:userId/instances', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const user = db.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(db.getAssignmentsForUser(userId));
});

app.patch('/api/users/:userId/password', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const { password } = req.body;
  if (!password || String(password).length < 1) {
    return res.status(400).json({ error: 'Password required' });
  }
  const user = db.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.updateUserPassword(userId, password);
  res.json({ success: true });
});

app.delete('/api/users/:userId', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  const currentId = Number(req.user.id);
  if (userId === currentId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const target = db.getUserById(userId);
  if (!target) {
    return res.json({ success: true, deleted: false });
  }
  if (target.role === 'admin' && db.getAdminCount() <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  const deleted = db.deleteUser(userId);
  if (!deleted) {
    console.error('deleteUser failed for id', userId);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
  res.json({ success: true, deleted: true });
});

// WebSocket: use noServer so we can run session on upgrade
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const noop = () => {};
  const res = {
    setHeader: noop,
    getHeader: noop,
    writeHead: noop,
    end(chunk, encoding, cb) {
      if (typeof encoding === 'function') cb = encoding;
      else if (typeof cb === 'function') cb();
    }
  };
  sessionMiddleware(request, res, () => {
    if (request.session?.userId) {
      const user = db.getUserById(request.session.userId);
      if (user) request.user = user;
    }
    if (!request.user) request.user = null; // allow connection for API-key auth on first message
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
});

wss.on('connection', (ws, req) => {
  const user = req.user;
  let currentInstanceId = null;
  let authenticatedBySession = !!user;
  let apiKeyInstanceId = null; // set when client authenticates with API key

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Session clients can send 'auth' as no-op; API-key clients must send auth with apiKey first
      if (data.type === 'auth') {
        if (data.apiKey) {
          const keyInstanceId = db.getInstanceIdByApiKey(data.apiKey);
          if (!keyInstanceId || !whatsappInstances.has(keyInstanceId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid API key or instance' }));
            return;
          }
          apiKeyInstanceId = keyInstanceId;
          ws.send(JSON.stringify({ type: 'auth_success', instanceId: keyInstanceId }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_success' }));
        }
        return;
      }

      if (data.type === 'subscribe' && data.instanceId) {
        const instanceId = data.instanceId;
        const allowedBySession = authenticatedBySession && user && db.userCanAccessInstance(user.id, user.role, instanceId);
        const allowedByApiKey = apiKeyInstanceId !== null && instanceId === apiKeyInstanceId;
        if (!allowedBySession && !allowedByApiKey) {
          ws.send(JSON.stringify({ type: 'error', message: 'Access denied to this instance' }));
          return;
        }
        currentInstanceId = instanceId;

        if (!instanceClients.has(currentInstanceId)) {
          instanceClients.set(currentInstanceId, new Set());
        }
        instanceClients.get(currentInstanceId).add(ws);
        ws._subscribeAuth = authenticatedBySession ? 'session' : 'apikey';

        if (whatsappInstances.has(currentInstanceId)) {
          const summary = serializeInstance(currentInstanceId, true);
          ws.send(JSON.stringify({
            type: 'status',
            instanceId: currentInstanceId,
            status: summary.status,
            qr: summary.qr,
            linkedAccount: summary.linkedAccount,
            linkedAccountChanged: summary.linkedAccountChanged,
            previousLinkedAccount: summary.previousLinkedAccount
          }));
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    if (currentInstanceId && instanceClients.has(currentInstanceId)) {
      instanceClients.get(currentInstanceId).delete(ws);
    }
  });
});

/**
 * Notify all WebSocket subscribers for this instance (used for both native client.on('message') and webhook POST).
 * Removes dead connections (readyState !== OPEN) from the set so counts stay accurate.
 * Returns { sent, failed, errors }. Logs delivery when logOrigin is 'webhook' or 'native'.
 */
function broadcastToInstance(instanceId, message, logOrigin = null) {
  const tag = logOrigin === 'webhook' ? 'webhook' : logOrigin === 'native' ? 'message' : null;
  const result = { sent: 0, failed: 0, errors: [] };
  if (!instanceClients.has(instanceId)) {
    if (tag) {
      console.log(`[${tag}] instance=${instanceId} no WebSocket subscribers; message not announced to any listener`);
    }
    return result;
  }
  const clients = instanceClients.get(instanceId);
  const OPEN = 1;
  // Remove dead connections so we don't keep counting closed scripts/tabs
  const toRemove = [];
  clients.forEach((client) => {
    if (client.readyState !== OPEN) {
      toRemove.push(client);
    }
  });
  toRemove.forEach((c) => clients.delete(c));
  const openCount = clients.size;
  if (openCount === 0) {
    if (tag) {
      console.log(`[${tag}] instance=${instanceId} 0 listeners (${toRemove.length} dead connection(s) removed); message not announced`);
    }
    return result;
  }

  let messageStr;
  try {
    messageStr = JSON.stringify(message);
  } catch (e) {
    if (tag) {
      console.error(`[${tag}] instance=${instanceId} broadcast failed (serialize):`, e.message);
    }
    result.errors.push(e.message);
    result.failed = openCount;
    return result;
  }
  const authCounts = { session: 0, apikey: 0 };
  clients.forEach((client) => {
    if (client.readyState !== OPEN) {
      clients.delete(client);
      result.failed += 1;
      result.errors.push('client not open');
      return;
    }
    try {
      client.send(messageStr);
      result.sent += 1;
      const a = client._subscribeAuth || '';
      if (a === 'session') authCounts.session += 1;
      else if (a === 'apikey') authCounts.apikey += 1;
    } catch (e) {
      clients.delete(client);
      result.failed += 1;
      result.errors.push(e.message);
      if (tag) {
        console.error(`[${tag}] instance=${instanceId} send failed (listener removed):`, e.message);
      }
    }
  });
  if (tag) {
    const deadNote = toRemove.length > 0 ? ` (${toRemove.length} dead removed)` : '';
    const parts = [];
    if (authCounts.session) parts.push(`${authCounts.session} session`);
    if (authCounts.apikey) parts.push(`${authCounts.apikey} apikey`);
    const authSummary = parts.length ? ` [${parts.join(', ')}]` : '';
    if (result.sent > 0 && result.failed === 0) {
      console.log(`[${tag}] instance=${instanceId} ${result.sent} listener(s)${authSummary}${deadNote} → announced OK`);
    } else if (result.failed > 0) {
      console.warn(`[${tag}] instance=${instanceId} ${result.sent} sent, ${result.failed} failed${deadNote}:`, result.errors.slice(0, 3).join('; '));
    }
  }
  return result;
}

// Serve the main page (Svelte build if present, else legacy public)
app.get('/', (req, res) => {
  const svelteIndex = join(uiDist, 'index.html');
  if (existsSync(svelteIndex)) {
    res.sendFile(svelteIndex);
  } else {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  }
});
app.get('/index.html', (req, res) => {
  const svelteIndex = join(uiDist, 'index.html');
  if (existsSync(svelteIndex)) {
    res.sendFile(svelteIndex);
  } else {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  }
});
// SPA fallback for Svelte app (only when ui/dist exists)
app.get('*', (req, res, next) => {
  if (existsSync(join(uiDist, 'index.html'))) {
    res.sendFile(join(uiDist, 'index.html'));
  } else {
    next();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);

  const names = await loadInstanceNames();
  for (const instanceId of names) {
    if (whatsappInstances.has(instanceId)) continue;
    createAndInitializeInstance(instanceId).catch((err) => {
      console.error(`Failed to restore instance ${instanceId}:`, err.message);
    });
    if (!db.getInstanceApiKey(instanceId)) {
      db.setInstanceApiKey(instanceId, generateApiKey());
    }
  }
});
