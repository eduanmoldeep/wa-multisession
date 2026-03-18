import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, 'data.db');
let db = null;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function initDb() {
  const database = getDb();
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user'))
    );
    CREATE TABLE IF NOT EXISTS user_instances (
      user_id INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      PRIMARY KEY (user_id, instance_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_instances_user ON user_instances(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_instances_instance ON user_instances(instance_id);
    CREATE TABLE IF NOT EXISTS instance_api_keys (
      instance_id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS instance_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      from_jid TEXT NOT NULL,
      sender_display TEXT NOT NULL,
      sender_number TEXT,
      group_name TEXT,
      body TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'native',
      message_kind TEXT NOT NULL DEFAULT 'individual',
      message_timestamp INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(instance_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_instance_messages_instance ON instance_messages(instance_id);
    CREATE INDEX IF NOT EXISTS idx_instance_messages_created ON instance_messages(instance_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS instance_linked_accounts (
      instance_id TEXT PRIMARY KEY,
      account_jid TEXT,
      account_number TEXT,
      account_name TEXT,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  ensureColumn(database, 'instance_messages', 'sender_number', 'TEXT');
  ensureColumn(database, 'instance_messages', 'group_name', 'TEXT');
  ensureColumn(database, 'instance_messages', 'source', "TEXT NOT NULL DEFAULT 'native'");
  ensureColumn(database, 'instance_messages', 'message_kind', "TEXT NOT NULL DEFAULT 'individual'");
  backfillMessageKinds(database);
  backfillSenderNumbers(database);
  backfillGroupNames(database);
  seedAdminIfNeeded(database);
  // Checkpoint WAL so the main data.db file has schema + data (visible in external tools)
  try {
    database.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {
    console.error('Error checkpointing WAL', _);
  }
  return database;
}

function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function backfillMessageKinds(database) {
  database.exec(`
    UPDATE instance_messages
    SET message_kind = CASE
      WHEN from_jid = 'status@broadcast' OR from_jid LIKE '%@broadcast' THEN 'status'
      WHEN from_jid LIKE '%@g.us' THEN 'group'
      ELSE 'individual'
    END
    WHERE message_kind IS NULL
       OR message_kind NOT IN ('individual', 'group', 'status')
       OR (
         message_kind = 'individual'
         AND (from_jid = 'status@broadcast' OR from_jid LIKE '%@broadcast' OR from_jid LIKE '%@g.us')
       );
  `);
}

function backfillSenderNumbers(database) {
  database.exec(`
    UPDATE instance_messages
    SET sender_number = CASE
      WHEN from_jid = 'status@broadcast' THEN NULL
      WHEN from_jid LIKE '%@c.us' THEN REPLACE(from_jid, '@c.us', '')
      ELSE sender_number
    END
    WHERE sender_number IS NULL OR TRIM(sender_number) = '';
  `);
}

function backfillGroupNames(database) {
  database.exec(`
    UPDATE instance_messages
    SET group_name = (
      SELECT im2.sender_display
      FROM instance_messages im2
      WHERE im2.instance_id = instance_messages.instance_id
        AND im2.from_jid = instance_messages.from_jid
        AND im2.message_kind = 'group'
        AND im2.sender_display IS NOT NULL
        AND TRIM(im2.sender_display) <> ''
      ORDER BY LENGTH(im2.sender_display) DESC, im2.created_at DESC
      LIMIT 1
    )
    WHERE message_kind = 'group'
      AND (group_name IS NULL OR TRIM(group_name) = '');
  `);
}

function seedAdminIfNeeded(database) {
  const row = database.prepare('SELECT 1 FROM users LIMIT 1').get();
  if (row) return;
  const hash = bcrypt.hashSync('admin123', 10);
  database.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(hash);
  console.log('Seeded default admin user: admin / admin123');
}

export function getUserById(id) {
  return getDb().prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
}

export function getUserByUsername(username) {
  return getDb().prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get(username);
}

export function verifyLogin(username, password) {
  const user = getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return null;
  return { id: user.id, username: user.username, role: user.role };
}

export function getAllUsers() {
  return getDb().prepare('SELECT id, username, role FROM users ORDER BY username').all();
}

export function createUser(username, password, role = 'user') {
  const hash = bcrypt.hashSync(password, 10);
  const result = getDb()
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hash, role);
  return result.lastInsertRowid;
}

export function userCanAccessInstance(userId, role, instanceId) {
  if (role === 'admin') return true;
  const row = getDb()
    .prepare('SELECT 1 FROM user_instances WHERE user_id = ? AND instance_id = ?')
    .get(userId, instanceId);
  return !!row;
}

export function getInstanceIdsForUser(userId, role) {
  if (role === 'admin') return null; // null = all instances
  return getDb()
    .prepare('SELECT instance_id FROM user_instances WHERE user_id = ?')
    .all(userId)
    .map((r) => r.instance_id);
}

export function assignInstanceToUser(userId, instanceId) {
  getDb().prepare('INSERT OR IGNORE INTO user_instances (user_id, instance_id) VALUES (?, ?)').run(userId, instanceId);
}

export function removeInstanceFromUser(userId, instanceId) {
  getDb().prepare('DELETE FROM user_instances WHERE user_id = ? AND instance_id = ?').run(userId, instanceId);
}

export function getAssignmentsForUser(userId) {
  return getDb()
    .prepare('SELECT instance_id FROM user_instances WHERE user_id = ?')
    .all(userId)
    .map((r) => r.instance_id);
}

export function getUsersForInstance(instanceId) {
  return getDb()
    .prepare('SELECT u.id, u.username, u.role FROM users u JOIN user_instances ui ON u.id = ui.user_id WHERE ui.instance_id = ?')
    .all(instanceId);
}

export function updateUserPassword(userId, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  const result = getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  return result.changes > 0;
}

export function deleteUser(userId) {
  const id = typeof userId === 'number' ? userId : parseInt(userId, 10);
  if (Number.isNaN(id)) return false;
  const result = getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getAdminCount() {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
  return row?.n ?? 0;
}

export function setInstanceApiKey(instanceId, apiKey) {
  getDb()
    .prepare('INSERT OR REPLACE INTO instance_api_keys (instance_id, api_key) VALUES (?, ?)')
    .run(instanceId, apiKey);
}

export function getInstanceApiKey(instanceId) {
  const row = getDb().prepare('SELECT api_key FROM instance_api_keys WHERE instance_id = ?').get(instanceId);
  return row?.api_key ?? null;
}

export function getInstanceIdByApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return null;
  const row = getDb().prepare('SELECT instance_id FROM instance_api_keys WHERE api_key = ?').get(apiKey.trim());
  return row?.instance_id ?? null;
}

export function deleteInstanceApiKey(instanceId) {
  getDb().prepare('DELETE FROM instance_api_keys WHERE instance_id = ?').run(instanceId);
}

export function getInstanceLinkedAccount(instanceId) {
  const row = getDb()
    .prepare(
      `SELECT account_jid, account_number, account_name, updated_at
       FROM instance_linked_accounts WHERE instance_id = ?`
    )
    .get(instanceId);
  if (!row) return null;
  return {
    jid: row.account_jid || null,
    number: row.account_number || null,
    name: row.account_name || null,
    updatedAt: row.updated_at || null
  };
}

export function setInstanceLinkedAccount(instanceId, account) {
  const updatedAt = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO instance_linked_accounts (instance_id, account_jid, account_number, account_name, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET
         account_jid = excluded.account_jid,
         account_number = excluded.account_number,
         account_name = excluded.account_name,
         updated_at = excluded.updated_at`
    )
    .run(instanceId, account?.jid || null, account?.number || null, account?.name || null, updatedAt);
}

export function deleteInstanceLinkedAccount(instanceId) {
  getDb().prepare('DELETE FROM instance_linked_accounts WHERE instance_id = ?').run(instanceId);
}

export function insertMessage(
  instanceId,
  messageId,
  fromJid,
  senderDisplay,
  senderNumber,
  groupName,
  body,
  messageTimestamp,
  source = 'native',
  messageKind = 'individual'
) {
  const created = Math.floor(Date.now() / 1000);
  const ts = messageTimestamp != null ? Number(messageTimestamp) : created;
  try {
    getDb()
      .prepare(
        `INSERT INTO instance_messages (instance_id, message_id, from_jid, sender_display, sender_number, group_name, body, source, message_kind, message_timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        instanceId,
        messageId,
        fromJid,
        senderDisplay || fromJid,
        senderNumber || null,
        groupName || null,
        body || '',
        source,
        messageKind,
        ts,
        created
      );
  } catch (e) {
    console.error('Error inserting message', e);
  }
}

export function getMessagesForInstance(instanceId, limit = 500) {
  return getDb()
    .prepare(
      `SELECT id, instance_id, message_id, from_jid, sender_display, sender_number, group_name, body, source, message_kind, message_timestamp, created_at
       FROM instance_messages WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(instanceId, limit);
}

export function deleteMessagesForInstance(instanceId) {
  const result = getDb().prepare('DELETE FROM instance_messages WHERE instance_id = ?').run(instanceId);
  return result.changes;
}
