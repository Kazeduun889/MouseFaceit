const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const db = require(path.join(__dirname, 'database'));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ADMINS = [1562788488, 5731264879];

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `screenshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`);
  }
});
const upload = multer({ storage });

// Initialize database
db.initialize();

// Create initial 5 lobbies
for (let i = 1; i <= 5; i++) {
  const existing = db.getLobbies().find(l => l.lobby_number === i);
  if (!existing) db.createLobby(i);
}

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.json());

// Auth middleware
function auth(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = db.getUserById(parseInt(userId));
  if (!user) return res.status(401).json({ error: 'User not found' });
  req.user = user;
  next();
}

// API Routes
app.post('/api/auth', (req, res) => {
  const { gameId, nickname } = req.body;
  if (!gameId || !nickname) return res.status(400).json({ error: 'gameId and nickname required' });
  if (!/^\d+$/.test(gameId)) return res.status(400).json({ error: 'gameId must be numeric' });
  if (nickname.length < 2 || nickname.length > 20) return res.status(400).json({ error: 'nickname must be 2-20 chars' });

  const user = db.createUser(gameId, nickname);
  
  // Check if user is admin
  if (ADMINS.includes(parseInt(gameId))) {
    db.makeAdmin(user.id);
    user.is_admin = 1;
  }

  res.json({ user });
});

app.get('/api/profile', auth, (req, res) => {
  const user = db.getUserById(req.user.id);
  res.json({ user });
});

app.get('/api/lobbies', auth, (req, res) => {
  const lobbies = db.getLobbies();
  const enriched = lobbies.map(l => ({
    ...l,
    players: [
      l.player1_id ? db.getUserById(l.player1_id) : null,
      l.player2_id ? db.getUserById(l.player2_id) : null,
      l.player3_id ? db.getUserById(l.player3_id) : null,
      l.player4_id ? db.getUserById(l.player4_id) : null
    ].filter(Boolean)
  }));
  res.json({ lobbies: enriched });
});

app.post('/api/lobbies/:id/join', auth, (req, res) => {
  const lobbyId = parseInt(req.params.id);
  const lobby = db.getLobby(lobbyId);
  if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
  if (lobby.status === 'in_match') return res.status(400).json({ error: 'Match already started' });

  // Check if already in another lobby
  const allLobbies = db.getLobbies();
  for (const l of allLobbies) {
    if (l.id !== lobbyId && (l.player1_id == req.user.id || l.player2_id == req.user.id || 
        l.player3_id == req.user.id || l.player4_id == req.user.id)) {
      db.leaveLobby(l.id, req.user.id);
      broadcastLobbies();
    }
  }

  const updated = db.joinLobby(lobbyId, req.user.id);
  if (!updated) return res.status(400).json({ error: 'Lobby is full' });

  broadcastLobbies();
  
  // Check if lobby is full (4 players)
  if (updated.player1_id && updated.player2_id && updated.player3_id && updated.player4_id) {
    broadcastToLobby(lobbyId, { type: 'lobby_full', lobby: updated });
  }

  res.json({ lobby: updated });
});

app.post('/api/lobbies/:id/leave', auth, (req, res) => {
  const lobbyId = parseInt(req.params.id);
  db.leaveLobby(lobbyId, req.user.id);
  broadcastLobbies();
  res.json({ success: true });
});

app.post('/api/lobbies/:id/confirm', auth, (req, res) => {
  const lobbyId = parseInt(req.params.id);
  const lobby = db.getLobby(lobbyId);
  if (!lobby) return res.status(404).json({ error: 'Lobby not found' });

  const { confirmed } = req.body;
  broadcastToLobby(lobbyId, { type: 'player_confirmed', userId: req.user.id, confirmed });

  // Check all confirmed - simplified: when all 4 confirm, start captain selection
  const confirmationKey = `confirm_${lobbyId}`;
  if (!global.confirmations) global.confirmations = {};
  if (!global.confirmations[confirmationKey]) global.confirmations[confirmationKey] = {};
  
  if (confirmed) {
    global.confirmations[confirmationKey][req.user.id] = true;
  } else {
    delete global.confirmations[confirmationKey][req.user.id];
  }

  const confirmCount = Object.keys(global.confirmations[confirmationKey]).length;
  const players = [lobby.player1_id, lobby.player2_id, lobby.player3_id, lobby.player4_id].filter(Boolean);
  
  if (confirmCount >= 4) {
    // All confirmed - pick random captains
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const captainTId = shuffled[0];
    const captainCTId = shuffled[1];
    
    const match = db.createMatch(lobbyId, captainTId, captainCTId);
    if (match) {
      broadcastToLobby(lobbyId, {
        type: 'captains_picked',
        matchId: match.id,
        lobbyId,
        captainT: db.getUserById(captainTId),
        captainCT: db.getUserById(captainCTId),
        captainTId,
        captainCTId,
        players: players.map(id => db.getUserById(id))
      });
    }
  } else {
    broadcastToLobby(lobbyId, { type: 'confirm_count', count: confirmCount, total: 4 });
  }

  res.json({ success: true });
});

app.post('/api/lobbies/:id/not_confirm', auth, (req, res) => {
  const lobbyId = parseInt(req.params.id);
  db.leaveLobby(lobbyId, req.user.id);
  broadcastLobbies();
  
  // Notify others they're back to search
  broadcastToLobby(lobbyId, { type: 'confirm_failed', userId: req.user.id });
  res.json({ success: true, backToLobby: true });
});

// Pick map
app.post('/api/match/:id/pick_map', auth, (req, res) => {
  const matchId = parseInt(req.params.id);
  const { map, team } = req.body;
  const match = db.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  // Store map picks - for simplicity store as JSON array
  if (!global.matchPicks) global.matchPicks = {};
  if (!global.matchPicks[matchId]) global.matchPicks[matchId] = { maps: [], currentTeam: 'CT' };
  
  global.matchPicks[matchId].maps.push({ map, pickedBy: team });
  match.map_pick = map;
  
  if (global.matchPicks[matchId].maps.length >= 3) {
    // All maps picked - pick enough
    db.updateMatch(matchId, { map_pick: JSON.stringify(global.matchPicks[matchId].maps), status: 'pick_players' });
    broadcastToMatch(matchId, { type: 'maps_picked', maps: global.matchPicks[matchId].maps });
    broadcastToMatch(matchId, { type: 'start_player_pick', matchId, captainTId: match.captain_t_id, captainCTId: match.captain_ct_id });
  } else {
    db.updateMatch(matchId, { map_pick: JSON.stringify(global.matchPicks[matchId].maps) });
    broadcastToMatch(matchId, { type: 'map_picked', map, pickedBy: team, mapIndex: global.matchPicks[matchId].maps.length - 1 });
  }
  
  res.json({ success: true });
});

// Pick players
app.post('/api/match/:id/pick_player', auth, (req, res) => {
  const matchId = parseInt(req.params.id);
  const { playerId, team } = req.body;
  const match = db.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  if (team === 'T') {
    // Pick for T team (captain T picks)
    const hasSlot = !match.team_t_player1_id || match.team_t_player1_id === match.captain_t_id;
    if (hasSlot) {
      db.updateMatch(matchId, { team_t_player1_id: match.team_t_player1_id === match.captain_t_id ? playerId : match.team_t_player1_id, team_t_player2_id: match.team_t_player2_id === match.captain_t_id ? playerId : playerId });
    }
  } else {
    const hasSlot = !match.team_ct_player1_id || match.team_ct_player1_id === match.captain_ct_id;
    if (hasSlot) {
      db.updateMatch(matchId, { team_ct_player1_id: match.team_ct_player1_id === match.captain_ct_id ? playerId : match.team_ct_player1_id, team_ct_player2_id: match.team_ct_player2_id === match.captain_ct_id ? playerId : playerId });
    }
  }

  const updatedMatch = db.getMatch(matchId);
  broadcastToMatch(matchId, {
    type: 'player_picked',
    player: db.getUserById(parseInt(playerId)),
    team,
    match: updatedMatch
  });

  // Check if all players picked
  if (updatedMatch.team_t_player1_id && updatedMatch.team_t_player2_id && 
      updatedMatch.team_ct_player1_id && updatedMatch.team_ct_player2_id) {
    db.updateMatch(matchId, { status: 'ready' });
    broadcastToMatch(matchId, {
      type: 'match_ready',
      match: updatedMatch,
      captainT: db.getUserById(updatedMatch.captain_t_id),
      captainCT: db.getUserById(updatedMatch.captain_ct_id),
      teamT: [db.getUserById(updatedMatch.team_t_player1_id), db.getUserById(updatedMatch.team_t_player2_id)].filter(Boolean),
      teamCT: [db.getUserById(updatedMatch.team_ct_player1_id), db.getUserById(updatedMatch.team_ct_player2_id)].filter(Boolean),
      maps: global.matchPicks[matchId]?.maps || []
    });
  }

  res.json({ success: true });
});

// Submit results
app.post('/api/match/:id/submit_result', auth, upload.single('screenshot'), (req, res) => {
  const matchId = parseInt(req.params.id);
  const { winner } = req.body;
  const match = db.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  const screenshotPath = req.file ? `/uploads/${req.file.filename}` : null;
  const result = db.addMatchResult(matchId, winner, screenshotPath, req.user.id);
  
  // Notify admins
  broadcastToMatch(matchId, {
    type: 'result_submitted',
    resultId: result.lastInsertRowid,
    winner,
    screenshotPath
  });

  res.json({ success: true, resultId: result.lastInsertRowid });
});

// Get match info
app.get('/api/match/:id', auth, (req, res) => {
  const matchId = parseInt(req.params.id);
  const match = db.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  res.json({ match });
});

// Leaderboard
app.get('/api/leaderboard', auth, (req, res) => {
  const leaderboard = db.getLeaderboard();
  res.json({ leaderboard });
});

// Admin routes
app.get('/api/admin/pending', auth, (req, res) => {
  if (!db.isAdmin(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const results = db.getPendingResults();
  res.json({ results });
});

app.post('/api/admin/confirm/:id', auth, (req, res) => {
  if (!db.isAdmin(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const resultId = parseInt(req.params.id);
  const { winner } = req.body;
  
  const result = db.confirmResult(resultId, req.user.id);
  if (!result) return res.status(404).json({ error: 'Result not found' });
  
  // Apply ELO changes
  const match = db.getMatch(result.match_id);
  if (match && result.elo_changes_applied === 0) {
    const teamTPlayers = [match.team_t_player1_id, match.team_t_player2_id].filter(Boolean);
    const teamCTPlayers = [match.team_ct_player1_id, match.team_ct_player2_id].filter(Boolean);
    
    // Calculate average ELO for each team
    const getAvgElo = (playerIds) => {
      const players = playerIds.map(id => db.getUserById(id)).filter(Boolean);
      if (players.length === 0) return 1000;
      return players.reduce((sum, p) => sum + p.elo, 0) / players.length;
    };

    const tElo = getAvgElo(teamTPlayers);
    const ctElo = getAvgElo(teamCTPlayers);
    
    // ELO formula: K * (1 - 1/(1 + 10^((opponentElo - playerElo)/400)))
    const expectedScore = (playerElo, opponentElo) => 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
    
    const K = 32;
    
    const applyEloChange = (playerIds, opponentAvgElo, didWin) => {
      playerIds.forEach(id => {
        const player = db.getUserById(id);
        if (!player) return;
        const expected = expectedScore(player.elo, opponentAvgElo);
        const actual = didWin ? 1 : 0;
        const change = Math.round(K * (actual - expected));
        db.updateElo(id, change);
        db.recordMatchResult(id, didWin);
      });
    };

    if (winner === 'T') {
      applyEloChange(teamTPlayers, ctElo, true);
      applyEloChange(teamCTPlayers, tElo, false);
    } else {
      applyEloChange(teamCTPlayers, tElo, true);
      applyEloChange(teamTPlayers, ctElo, false);
    }

    db.db.prepare('UPDATE match_results SET elo_changes_applied = 1 WHERE id = ?').run(resultId);
  }
  
  broadcastAdmins({ type: 'result_confirmed', resultId, matchId: result.match_id });
  
  res.json({ success: true, result });
});

app.post('/api/admin/make_admin', auth, (req, res) => {
  if (!db.isAdmin(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const { gameId } = req.body;
  const user = db.getUserByGameId(gameId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.makeAdmin(user.id);
  res.json({ success: true });
});

// WebSocket connections store
const clients = new Map(); // userId -> ws

wss.on('connection', (ws, req) => {
  let userId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'auth') {
        userId = msg.userId;
        clients.set(userId, ws);
        ws.send(JSON.stringify({ type: 'auth_ok', userId }));
      }
    } catch (e) {
      console.error('WS message error:', e);
    }
  });

  ws.on('close', () => {
    if (userId) clients.delete(userId);
  });
});

function broadcastToLobby(lobbyId, message) {
  const lobby = db.getLobby(lobbyId);
  if (!lobby) return;
  const playerIds = [lobby.player1_id, lobby.player2_id, lobby.player3_id, lobby.player4_id].filter(Boolean);
  playerIds.forEach(id => {
    const ws = clients.get(id);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  });
}

function broadcastToMatch(matchId, message) {
  const match = db.getMatch(matchId);
  if (!match) return;
  const lobby = db.getLobby(match.lobby_id);
  if (!lobby) return;
  broadcastToLobby(lobby.id, message);
}

function broadcastLobbies() {
  const lobbies = db.getLobbies();
  const enriched = lobbies.map(l => ({
    ...l,
    players: [
      l.player1_id ? db.getUserById(l.player1_id) : null,
      l.player2_id ? db.getUserById(l.player2_id) : null,
      l.player3_id ? db.getUserById(l.player3_id) : null,
      l.player4_id ? db.getUserById(l.player4_id) : null
    ].filter(Boolean)
  }));
  
  const message = JSON.stringify({ type: 'lobbies_update', lobbies: enriched });
  
  // Broadcast to all connected clients
  for (const [uid, ws] of clients) {
    if (ws.readyState === 1) {
      ws.send(message);
    }
  }
}

function broadcastAdmins(message) {
  for (const [uid, ws] of clients) {
    const user = db.getUserById(uid);
    if (user && user.is_admin && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }
}

// Initialize lobbies on startup
function initializeLobbies() {
  const existing = db.getLobbies();
  if (existing.length === 0) {
    for (let i = 1; i <= 5; i++) {
      db.createLobby(i);
    }
  }
}

initializeLobbies();

server.listen(PORT, () => {
  console.log(`StandLeo server running on http://localhost:${PORT}`);
  console.log(`WebSocket available on ws://localhost:${PORT}`);
});