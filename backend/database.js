const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'standleo.db');
console.log('Database path:', dbPath);
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initialize() {
  db.exec(`
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
    );

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
    );

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
    );

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
    );

    CREATE TABLE IF NOT EXISTS ban_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      reason TEXT,
      banned_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
}

function getUserByGameId(gameId) {
  return db.prepare('SELECT * FROM users WHERE game_id = ?').get(gameId);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function createUser(gameId, nickname) {
  const existing = getUserByGameId(gameId);
  if (existing) {
    db.prepare('UPDATE users SET nickname = ? WHERE game_id = ?').run(nickname, gameId);
    return existing;
  }
  const stmt = db.prepare('INSERT INTO users (game_id, nickname) VALUES (?, ?)');
  const result = stmt.run(gameId, nickname);
  return { id: result.lastInsertRowid, game_id: gameId, nickname, elo: 1000, wins: 0, losses: 0, matches_played: 0, is_admin: 0 };
}

function updateElo(userId, eloChange) {
  const user = getUserById(userId);
  if (!user) return null;
  const newElo = Math.max(100, user.elo + eloChange);
  db.prepare('UPDATE users SET elo = ? WHERE id = ?').run(newElo, userId);
  return newElo;
}

function recordMatchResult(userId, won) {
  const user = getUserById(userId);
  if (!user) return;
  if (won) {
    db.prepare('UPDATE users SET wins = wins + 1, matches_played = matches_played + 1 WHERE id = ?').run(userId);
  } else {
    db.prepare('UPDATE users SET losses = losses + 1, matches_played = matches_played + 1 WHERE id = ?').run(userId);
  }
}

function createLobby(lobbyNumber) {
  const stmt = db.prepare('INSERT INTO lobbies (lobby_number, status) VALUES (?, ?)');
  const result = stmt.run(lobbyNumber, 'waiting');
  return { id: result.lastInsertRowid, lobby_number: lobbyNumber, status: 'waiting', mode: '2v2', players: [] };
}

function getLobby(id) {
  return db.prepare('SELECT * FROM lobbies WHERE id = ?').get(id);
}

function getLobbies() {
  return db.prepare('SELECT * FROM lobbies ORDER BY lobby_number ASC').all();
}

function updateLobby(id, data) {
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
    db.prepare(`UPDATE lobbies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}

function joinLobby(lobbyId, userId) {
  const lobby = getLobby(lobbyId);
  if (!lobby) return null;
  
  if (lobby.player1_id === userId || lobby.player2_id === userId || 
      lobby.player3_id === userId || lobby.player4_id === userId) {
    return lobby;
  }

  if (!lobby.player1_id) {
    db.prepare('UPDATE lobbies SET player1_id = ?, status = CASE WHEN ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL THEN \'full\' ELSE \'waiting\' END WHERE id = ?').run(userId, lobby.player1_id, lobby.player2_id, lobby.player3_id, lobby.player4_id, lobbyId);
  } else if (!lobby.player2_id) {
    db.prepare('UPDATE lobbies SET player2_id = ?, status = CASE WHEN ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL THEN \'full\' ELSE \'waiting\' END WHERE id = ?').run(userId, lobby.player1_id, lobby.player2_id, lobby.player3_id, lobby.player4_id, lobbyId);
  } else if (!lobby.player3_id) {
    db.prepare('UPDATE lobbies SET player3_id = ?, status = CASE WHEN ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL THEN \'full\' ELSE \'waiting\' END WHERE id = ?').run(userId, lobby.player1_id, lobby.player2_id, lobby.player3_id, lobby.player4_id, lobbyId);
  } else if (!lobby.player4_id) {
    db.prepare('UPDATE lobbies SET player4_id = ?, status = CASE WHEN ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL THEN \'full\' ELSE \'waiting\' END WHERE id = ?').run(userId, lobby.player1_id, lobby.player2_id, lobby.player3_id, lobby.player4_id, lobbyId);
  }
  
  return getLobby(lobbyId);
}

function leaveLobby(lobbyId, userId) {
  const lobby = getLobby(lobbyId);
  if (!lobby) return;
  
  if (lobby.player1_id == userId) db.prepare('UPDATE lobbies SET player1_id = NULL WHERE id = ?').run(lobbyId);
  else if (lobby.player2_id == userId) db.prepare('UPDATE lobbies SET player2_id = NULL WHERE id = ?').run(lobbyId);
  else if (lobby.player3_id == userId) db.prepare('UPDATE lobbies SET player3_id = NULL WHERE id = ?').run(lobbyId);
  else if (lobby.player4_id == userId) db.prepare('UPDATE lobbies SET player4_id = NULL WHERE id = ?').run(lobbyId);
  
  db.prepare('UPDATE lobbies SET status = \'waiting\' WHERE id = ?').run(lobbyId);
}

function createMatch(lobbyId, captainTId, captainCTId) {
  const lobby = getLobby(lobbyId);
  if (!lobby) return null;
  
  const stmt = db.prepare(`INSERT INTO matches (lobby_id, captain_t_id, captain_ct_id, team_t_player1_id, team_t_player2_id, team_ct_player1_id, team_ct_player2_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pick_maps')`);
  
  // Determine teams - captains pick in the frontend
  const result = stmt.run(lobbyId, captainTId, captainCTId, captainTId, null, captainCTId, null);
  
  db.prepare('UPDATE lobbies SET status = \'in_match\' WHERE id = ?').run(lobbyId);
  
  return { id: result.lastInsertRowid, lobby_id: lobbyId, captain_t_id: captainTId, captain_ct_id: captainCTId };
}

function updateMatch(matchId, data) {
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
    db.prepare(`UPDATE matches SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}

function getMatch(id) {
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
}

function getLeaderboard(limit = 50) {
  return db.prepare('SELECT id, game_id, nickname, elo, wins, losses, matches_played FROM users WHERE matches_played > 0 ORDER BY elo DESC LIMIT ?').all(limit);
}

function addMatchResult(matchId, winner, screenshotPath, submittedBy) {
  const stmt = db.prepare('INSERT INTO match_results (match_id, winner, screenshot_path, submitted_by) VALUES (?, ?, ?, ?)');
  return stmt.run(matchId, winner, screenshotPath, submittedBy);
}

function getPendingResults() {
  return db.prepare(`
    SELECT mr.*, m.lobby_id, m.captain_t_id, m.captain_ct_id,
      ct.game_id as ct_game_id, ct.nickname as ct_nickname,
      t.game_id as t_game_id, t.nickname as t_nickname
    FROM match_results mr
    JOIN matches m ON mr.match_id = m.id
    LEFT JOIN users ct ON m.captain_ct_id = ct.id
    LEFT JOIN users t ON m.captain_t_id = t.id
    WHERE mr.confirmed_by_admin = 0
    ORDER BY mr.created_at DESC
  `).all();
}

function confirmResult(resultId, adminId) {
  const result = db.prepare('SELECT * FROM match_results WHERE id = ?').get(resultId);
  if (!result) return null;
  
  db.prepare('UPDATE match_results SET confirmed_by_admin = 1, is_confirmed = 1 WHERE id = ?').run(resultId);
  db.prepare('UPDATE matches SET status = \'completed\', completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(result.match_id);
  
  return result;
}

function makeAdmin(userId) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
}

function isAdmin(userId) {
  const user = getUserById(userId);
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