const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'standleo.db');
let db = null;
let initPromise = null;

async function initSqlJs() {
  const SQL = await require('sql.js')();
  return SQL;
}

async function getDb() {
  if (db) return db;
  
  if (!initPromise) {
    initPromise = initSqlJs();
  }
  
  const SQL = await initPromise;
  
  try {
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
  } catch (e) {
    db = new SQL.Database();
  }
  
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

async function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('Error saving DB:', e.message);
  }
}

async function q(sql, params = []) {
  const d = await getDb();
  const stmt = d.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  return stmt;
}

async function run(sql, params = []) {
  const d = await getDb();
  d.run(sql, params);
  await saveDb();
  const result = d.exec("SELECT last_insert_rowid() as id");
  return { lastInsertRowid: result[0]?.values[0][0] };
}

async function get(sql, params = []) {
  const stmt = await q(sql, params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free();
    const row = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    return row;
  }
  stmt.free();
  return null;
}

async function all(sql, params = []) {
  const stmt = await q(sql, params);
  const rows = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) {
    const vals = stmt.get();
    const row = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    rows.push(row);
  }
  stmt.free();
  return rows;
}

// Chat-style simple schema that syncs on every write
async function initialize() {
  await getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      elo INTEGER DEFAULT 1000,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      matches_played INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lobby_id INTEGER NOT NULL,
      map_pick TEXT,
      captain_t_id INTEGER,
      captain_ct_id INTEGER,
      team_t_player1_id INTEGER,
      team_t_player2_id INTEGER,
      team_ct_player1_id INTEGER,
      team_ct_player2_id INTEGER,
      winner TEXT,
      status TEXT DEFAULT 'pick_maps',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      screenshot_path TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS match_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      winner TEXT NOT NULL,
      screenshot_path TEXT,
      submitted_by INTEGER,
      is_confirmed INTEGER DEFAULT 0,
      confirmed_by_admin INTEGER DEFAULT 0,
      elo_changes_applied INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES matches(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS lobbies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lobby_number INTEGER NOT NULL,
      status TEXT DEFAULT 'waiting',
      mode TEXT DEFAULT '2v2',
      player1_id INTEGER,
      player2_id INTEGER,
      player3_id INTEGER,
      player4_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS ban_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      reason TEXT,
      banned_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await saveDb();
}

// ========== USER FUNCTIONS ==========

async function getUserByGameId(gameId) {
  return await get('SELECT * FROM users WHERE game_id = ?', [gameId]);
}

async function getUserById(id) {
  return await get('SELECT * FROM users WHERE id = ?', [id]);
}

async function createUser(gameId, nickname) {
  const existing = await getUserByGameId(gameId);
  if (existing) {
    await run('UPDATE users SET nickname = ? WHERE game_id = ?', [nickname, gameId]);
    return existing;
  }
  const result = await run('INSERT INTO users (game_id, nickname) VALUES (?, ?)', [gameId, nickname]);
  return { id: result.lastInsertRowid, game_id: gameId, nickname, elo: 1000, wins: 0, losses: 0, matches_played: 0, is_admin: 0 };
}

async function updateElo(userId, eloChange) {
  const user = await getUserById(userId);
  if (!user) return null;
  const newElo = Math.max(100, user.elo + eloChange);
  await run('UPDATE users SET elo = ? WHERE id = ?', [newElo, userId]);
  return newElo;
}

async function recordMatchResult(userId, won) {
  const user = await getUserById(userId);
  if (!user) return;
  if (won) {
    await run('UPDATE users SET wins = wins + 1, matches_played = matches_played + 1 WHERE id = ?', [userId]);
  } else {
    await run('UPDATE users SET losses = losses + 1, matches_played = matches_played + 1 WHERE id = ?', [userId]);
  }
}

// ========== LOBBY FUNCTIONS ==========

async function createLobby(lobbyNumber) {
  const result = await run('INSERT INTO lobbies (lobby_number, status) VALUES (?, ?)', [lobbyNumber, 'waiting']);
  return { id: result.lastInsertRowid, lobby_number: lobbyNumber, status: 'waiting', mode: '2v2', players: [] };
}

async function getLobby(id) {
  return await get('SELECT * FROM lobbies WHERE id = ?', [id]);
}

async function getLobbies() {
  return await all('SELECT * FROM lobbies ORDER BY lobby_number ASC');
}

async function updateLobby(id, data) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length > 0) {
    values.push(id);
    await run(`UPDATE lobbies SET ${fields.join(', ')} WHERE id = ?`, values);
  }
}

async function joinLobby(lobbyId, userId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return null;

  if (lobby.player1_id === userId || lobby.player2_id === userId ||
    lobby.player3_id === userId || lobby.player4_id === userId) {
    return lobby;
  }

  if (!lobby.player1_id) {
    await run('UPDATE lobbies SET player1_id = ? WHERE id = ?', [userId, lobbyId]);
  } else if (!lobby.player2_id) {
    await run('UPDATE lobbies SET player2_id = ? WHERE id = ?', [userId, lobbyId]);
  } else if (!lobby.player3_id) {
    await run('UPDATE lobbies SET player3_id = ? WHERE id = ?', [userId, lobbyId]);
  } else if (!lobby.player4_id) {
    await run('UPDATE lobbies SET player4_id = ? WHERE id = ?', [userId, lobbyId]);
  }

  const updated = await getLobby(lobbyId);
  const players = [updated.player1_id, updated.player2_id, updated.player3_id, updated.player4_id].filter(Boolean);
  const newStatus = players.length >= 4 ? 'full' : 'waiting';
  await run('UPDATE lobbies SET status = ? WHERE id = ?', [newStatus, lobbyId]);

  return await getLobby(lobbyId);
}

async function leaveLobby(lobbyId, userId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return;

  if (lobby.player1_id == userId) await run('UPDATE lobbies SET player1_id = NULL WHERE id = ?', [lobbyId]);
  else if (lobby.player2_id == userId) await run('UPDATE lobbies SET player2_id = NULL WHERE id = ?', [lobbyId]);
  else if (lobby.player3_id == userId) await run('UPDATE lobbies SET player3_id = NULL WHERE id = ?', [lobbyId]);
  else if (lobby.player4_id == userId) await run('UPDATE lobbies SET player4_id = NULL WHERE id = ?', [lobbyId]);

  await run("UPDATE lobbies SET status = 'waiting' WHERE id = ?", [lobbyId]);
}

// ========== MATCH FUNCTIONS ==========

async function createMatch(lobbyId, captainTId, captainCTId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return null;

  const result = await run(
    `INSERT INTO matches (lobby_id, captain_t_id, captain_ct_id, team_t_player1_id, team_t_player2_id, team_ct_player1_id, team_ct_player2_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pick_maps')`,
    [lobbyId, captainTId, captainCTId, captainTId, null, captainCTId, null]
  );

  await run("UPDATE lobbies SET status = 'in_match' WHERE id = ?", [lobbyId]);

  return { id: result.lastInsertRowid, lobby_id: lobbyId, captain_t_id: captainTId, captain_ct_id: captainCTId };
}

async function updateMatch(matchId, data) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length > 0) {
    values.push(matchId);
    await run(`UPDATE matches SET ${fields.join(', ')} WHERE id = ?`, values);
  }
}

async function getMatch(id) {
  return await get('SELECT * FROM matches WHERE id = ?', [id]);
}

async function getLeaderboard(limit = 50) {
  return await all(
    'SELECT id, game_id, nickname, elo, wins, losses, matches_played FROM users WHERE matches_played > 0 ORDER BY elo DESC LIMIT ?',
    [limit]
  );
}

async function addMatchResult(matchId, winner, screenshotPath, submittedBy) {
  return await run(
    'INSERT INTO match_results (match_id, winner, screenshot_path, submitted_by) VALUES (?, ?, ?, ?)',
    [matchId, winner, screenshotPath, submittedBy]
  );
}

async function getPendingResults() {
  return await all(`
    SELECT mr.*, m.lobby_id, m.captain_t_id, m.captain_ct_id,
      ct.game_id as ct_game_id, ct.nickname as ct_nickname,
      t.game_id as t_game_id, t.nickname as t_nickname
    FROM match_results mr
    JOIN matches m ON mr.match_id = m.id
    LEFT JOIN users ct ON m.captain_ct_id = ct.id
    LEFT JOIN users t ON m.captain_t_id = t.id
    WHERE mr.confirmed_by_admin = 0
    ORDER BY mr.created_at DESC
  `);
}

async function confirmResult(resultId, adminId) {
  const result = await get('SELECT * FROM match_results WHERE id = ?', [resultId]);
  if (!result) return null;

  await run('UPDATE match_results SET confirmed_by_admin = 1, is_confirmed = 1 WHERE id = ?', [resultId]);
  await run("UPDATE matches SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [result.match_id]);

  return result;
}

async function makeAdmin(userId) {
  await run('UPDATE users SET is_admin = 1 WHERE id = ?', [userId]);
}

async function isAdmin(userId) {
  const user = await getUserById(userId);
  return user && user.is_admin === 1;
}

module.exports = {
  initialize,
  db,
  getUserByGameId,
  getUserById,
  createUser,
  updateElo,
  recordMatchResult,
  createLobby,
  getLobby,
  getLobbies,
  updateLobby,
  joinLobby,
  leaveLobby,
  createMatch,
  updateMatch,
  getMatch,
  getLeaderboard,
  addMatchResult,
  getPendingResults,
  confirmResult,
  makeAdmin,
  isAdmin
};