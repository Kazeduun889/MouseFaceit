const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

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
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `screenshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`)
});
const upload = multer({ storage });

// Lazy-init DB
let db = null;
async function getDB() {
  if (!db) {
    db = require(path.join(__dirname, 'database'));
    await db.initialize();
  }
  return db;
}

// Auth middleware
async function auth(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const d = await getDB();
    const user = await d.getUserById(parseInt(userId));
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
}

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.json());

// API Routes
app.post('/api/auth', async (req, res) => {
  try {
    const { gameId, nickname } = req.body;
    if (!gameId || !nickname) return res.status(400).json({ error: 'gameId and nickname required' });
    if (!/^\d+$/.test(gameId)) return res.status(400).json({ error: 'gameId must be numeric' });
    if (nickname.length < 2 || nickname.length > 20) return res.status(400).json({ error: 'nickname must be 2-20 chars' });

    const d = await getDB();
    const user = await d.createUser(gameId, nickname);

    if (ADMINS.includes(parseInt(gameId))) {
      await d.makeAdmin(user.id);
      user.is_admin = 1;
    }

    res.json({ user });
  } catch (e) {
    console.error('Auth error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/profile', auth, async (req, res) => {
  const d = await getDB();
  const user = await d.getUserById(req.user.id);
  res.json({ user });
});

app.get('/api/lobbies', auth, async (req, res) => {
  const d = await getDB();
  const lobbies = await d.getLobbies();
  const enriched = [];
  for (const l of lobbies) {
    const players = [
      l.player1_id ? await d.getUserById(l.player1_id) : null,
      l.player2_id ? await d.getUserById(l.player2_id) : null,
      l.player3_id ? await d.getUserById(l.player3_id) : null,
      l.player4_id ? await d.getUserById(l.player4_id) : null
    ].filter(Boolean);
    enriched.push({ ...l, players });
  }
  res.json({ lobbies: enriched });
});

app.post('/api/lobbies/:id/join', auth, async (req, res) => {
  try {
    const d = await getDB();
    const lobbyId = parseInt(req.params.id);
    const lobby = await d.getLobby(lobbyId);
    if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
    if (lobby.status === 'in_match') return res.status(400).json({ error: 'Match already started' });

    // Leave previous lobby if any
    const allLobbies = await d.getLobbies();
    for (const l of allLobbies) {
      if (l.id !== lobbyId && (l.player1_id == req.user.id || l.player2_id == req.user.id ||
          l.player3_id == req.user.id || l.player4_id == req.user.id)) {
        await d.leaveLobby(l.id, req.user.id);
        broadcastLobbies();
      }
    }

    const updated = await d.joinLobby(lobbyId, req.user.id);
    if (!updated) return res.status(400).json({ error: 'Lobby is full' });

    broadcastLobbies();

    if (updated.player1_id && updated.player2_id && updated.player3_id && updated.player4_id) {
      broadcastToLobby(lobbyId, { type: 'lobby_full', lobby: updated });
    }

    res.json({ lobby: updated });
  } catch (e) {
    console.error('Join error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/lobbies/:id/leave', auth, async (req, res) => {
  const d = await getDB();
  await d.leaveLobby(parseInt(req.params.id), req.user.id);
  broadcastLobbies();
  res.json({ success: true });
});

app.post('/api/lobbies/:id/confirm', auth, async (req, res) => {
  const d = await getDB();
  const lobbyId = parseInt(req.params.id);
  const lobby = await d.getLobby(lobbyId);
  if (!lobby) return res.status(404).json({ error: 'Lobby not found' });

  const { confirmed } = req.body;
  broadcastToLobby(lobbyId, { type: 'player_confirmed', userId: req.user.id, confirmed });

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
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const captainTId = shuffled[0];
    const captainCTId = shuffled[1];

    const match = await d.createMatch(lobbyId, captainTId, captainCTId);
    if (match) {
      broadcastToLobby(lobbyId, {
        type: 'captains_picked',
        matchId: match.id,
        lobbyId,
        captainT: await d.getUserById(captainTId),
        captainCT: await d.getUserById(captainCTId),
        captainTId,
        captainCTId,
        players: await Promise.all(players.map(id => d.getUserById(id)))
      });
    }
  } else {
    broadcastToLobby(lobbyId, { type: 'confirm_count', count: confirmCount, total: 4 });
  }

  res.json({ success: true });
});

app.post('/api/lobbies/:id/not_confirm', auth, async (req, res) => {
  const d = await getDB();
  const lobbyId = parseInt(req.params.id);
  await d.leaveLobby(lobbyId, req.user.id);
  broadcastLobbies();
  broadcastToLobby(lobbyId, { type: 'confirm_failed', userId: req.user.id });
  res.json({ success: true, backToLobby: true });
});

// Pick map
app.post('/api/match/:id/pick_map', auth, async (req, res) => {
  const d = await getDB();
  const matchId = parseInt(req.params.id);
  const { map, team } = req.body;
  const match = await d.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  if (!global.matchPicks) global.matchPicks = {};
  if (!global.matchPicks[matchId]) global.matchPicks[matchId] = { maps: [] };

  global.matchPicks[matchId].maps.push({ map, pickedBy: team });

  if (global.matchPicks[matchId].maps.length >= 3) {
    await d.updateMatch(matchId, { map_pick: JSON.stringify(global.matchPicks[matchId].maps), status: 'pick_players' });
    broadcastToMatch(matchId, { type: 'maps_picked', maps: global.matchPicks[matchId].maps });
    broadcastToMatch(matchId, { type: 'start_player_pick', matchId, captainTId: match.captain_t_id, captainCTId: match.captain_ct_id });
  } else {
    await d.updateMatch(matchId, { map_pick: JSON.stringify(global.matchPicks[matchId].maps) });
    broadcastToMatch(matchId, { type: 'map_picked', map, pickedBy: team, mapIndex: global.matchPicks[matchId].maps.length - 1 });
  }

  res.json({ success: true });
});

// Pick players
app.post('/api/match/:id/pick_player', auth, async (req, res) => {
  const d = await getDB();
  const matchId = parseInt(req.params.id);
  const { playerId, team } = req.body;
  const match = await d.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  if (team === 'T') {
    const hasSlot = !match.team_t_player1_id || match.team_t_player1_id === match.captain_t_id;
    if (hasSlot) {
      await d.updateMatch(matchId, {
        team_t_player1_id: match.team_t_player1_id === match.captain_t_id ? playerId : match.team_t_player1_id,
        team_t_player2_id: match.team_t_player2_id === match.captain_t_id ? playerId : playerId
      });
    }
  } else {
    const hasSlot = !match.team_ct_player1_id || match.team_ct_player1_id === match.captain_ct_id;
    if (hasSlot) {
      await d.updateMatch(matchId, {
        team_ct_player1_id: match.team_ct_player1_id === match.captain_ct_id ? playerId : match.team_ct_player1_id,
        team_ct_player2_id: match.team_ct_player2_id === match.captain_ct_id ? playerId : playerId
      });
    }
  }

  const updatedMatch = await d.getMatch(matchId);
  broadcastToMatch(matchId, {
    type: 'player_picked',
    player: await d.getUserById(parseInt(playerId)),
    team,
    match: updatedMatch
  });

  if (updatedMatch.team_t_player1_id && updatedMatch.team_t_player2_id &&
      updatedMatch.team_ct_player1_id && updatedMatch.team_ct_player2_id) {
    await d.updateMatch(matchId, { status: 'ready' });
    broadcastToMatch(matchId, {
      type: 'match_ready',
      match: updatedMatch,
      captainT: await d.getUserById(updatedMatch.captain_t_id),
      captainCT: await d.getUserById(updatedMatch.captain_ct_id),
      teamT: (await Promise.all([updatedMatch.team_t_player1_id, updatedMatch.team_t_player2_id].filter(Boolean).map(id => d.getUserById(id)))),
      teamCT: (await Promise.all([updatedMatch.team_ct_player1_id, updatedMatch.team_ct_player2_id].filter(Boolean).map(id => d.getUserById(id)))),
      maps: global.matchPicks[matchId]?.maps || []
    });
  }

  res.json({ success: true });
});

// Submit results
app.post('/api/match/:id/submit_result', auth, upload.single('screenshot'), async (req, res) => {
  const d = await getDB();
  const matchId = parseInt(req.params.id);
  const { winner } = req.body;
  const match = await d.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  const screenshotPath = req.file ? `/uploads/${req.file.filename}` : null;
  const result = await d.addMatchResult(matchId, winner, screenshotPath, req.user.id);

  broadcastToMatch(matchId, {
    type: 'result_submitted',
    resultId: result.lastInsertRowid,
    winner,
    screenshotPath
  });

  res.json({ success: true, resultId: result.lastInsertRowid });
});

app.get('/api/match/:id', auth, async (req, res) => {
  const d = await getDB();
  const match = await d.getMatch(parseInt(req.params.id));
  if (!match) return res.status(404).json({ error: 'Match not found' });
  res.json({ match });
});

app.get('/api/leaderboard', auth, async (req, res) => {
  const d = await getDB();
  const leaderboard = await d.getLeaderboard();
  res.json({ leaderboard });
});

// Admin routes
app.get('/api/admin/pending', auth, async (req, res) => {
  const d = await getDB();
  if (!(await d.isAdmin(req.user.id))) return res.status(403).json({ error: 'Forbidden' });
  const results = await d.getPendingResults();
  res.json({ results });
});

app.post('/api/admin/confirm/:id', auth, async (req, res) => {
  const d = await getDB();
  if (!(await d.isAdmin(req.user.id))) return res.status(403).json({ error: 'Forbidden' });

  const resultId = parseInt(req.params.id);
  const { winner } = req.body;

  const result = await d.confirmResult(resultId, req.user.id);
  if (!result) return res.status(404).json({ error: 'Result not found' });

  // Apply ELO
  const match = await d.getMatch(result.match_id);
  if (match && !result.elo_changes_applied) {
    const teamTPlayers = [match.team_t_player1_id, match.team_t_player2_id].filter(Boolean);
    const teamCTPlayers = [match.team_ct_player1_id, match.team_ct_player2_id].filter(Boolean);

    const getAvgElo = async (playerIds) => {
      const players = (await Promise.all(playerIds.map(id => d.getUserById(id)))).filter(Boolean);
      if (players.length === 0) return 1000;
      return players.reduce((sum, p) => sum + p.elo, 0) / players.length;
    };

    const tElo = await getAvgElo(teamTPlayers);
    const ctElo = await getAvgElo(teamCTPlayers);

    const expectedScore = (playerElo, opponentElo) => 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
    const K = 32;

    const applyEloChange = async (playerIds, opponentAvgElo, didWin) => {
      for (const id of playerIds) {
        const player = await d.getUserById(id);
        if (!player) continue;
        const expected = expectedScore(player.elo, opponentAvgElo);
        const actual = didWin ? 1 : 0;
        const change = Math.round(K * (actual - expected));
        await d.updateElo(id, change);
        await d.recordMatchResult(id, didWin);
      }
    };

    if (winner === 'T') {
      await applyEloChange(teamTPlayers, ctElo, true);
      await applyEloChange(teamCTPlayers, tElo, false);
    } else {
      await applyEloChange(teamCTPlayers, tElo, true);
      await applyEloChange(teamTPlayers, ctElo, false);
    }

    // Mark ELO as applied using raw exec
    const d2 = await getDB();
    // We need the raw db object - do a simple update via function
    await d2.run('UPDATE match_results SET elo_changes_applied = 1 WHERE id = ?', [resultId]);
  }

  broadcastAdmins({ type: 'result_confirmed', resultId, matchId: result.match_id });
  res.json({ success: true, result });
});

app.post('/api/admin/make_admin', auth, async (req, res) => {
  const d = await getDB();
  if (!(await d.isAdmin(req.user.id))) return res.status(403).json({ error: 'Forbidden' });
  const { gameId } = req.body;
  const user = await d.getUserByGameId(gameId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await d.makeAdmin(user.id);
  res.json({ success: true });
});

// WebSocket
const clients = new Map();

wss.on('connection', (ws) => {
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
      console.error('WS error:', e);
    }
  });

  ws.on('close', () => {
    if (userId) clients.delete(userId);
  });
});

async function broadcastToLobby(lobbyId, message) {
  const d = await getDB();
  const lobby = await d.getLobby(lobbyId);
  if (!lobby) return;
  const playerIds = [lobby.player1_id, lobby.player2_id, lobby.player3_id, lobby.player4_id].filter(Boolean);
  for (const id of playerIds) {
    const ws = clients.get(id);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }
}

async function broadcastToMatch(matchId, message) {
  const d = await getDB();
  const match = await d.getMatch(matchId);
  if (!match) return;
  await broadcastToLobby(match.lobby_id, message);
}

async function broadcastLobbies() {
  const d = await getDB();
  const lobbies = await d.getLobbies();
  const enriched = [];
  for (const l of lobbies) {
    const players = [
      l.player1_id ? await d.getUserById(l.player1_id) : null,
      l.player2_id ? await d.getUserById(l.player2_id) : null,
      l.player3_id ? await d.getUserById(l.player3_id) : null,
      l.player4_id ? await d.getUserById(l.player4_id) : null
    ].filter(Boolean);
    enriched.push({ ...l, players });
  }

  const message = JSON.stringify({ type: 'lobbies_update', lobbies: enriched });
  for (const [uid, ws] of clients) {
    if (ws.readyState === 1) ws.send(message);
  }
}

function broadcastAdmins(message) {
  const msg = JSON.stringify(message);
  for (const [uid, ws] of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// Initialize and start
async function start() {
  const d = await getDB();
  
  // Create initial lobbies
  const existing = await d.getLobbies();
  if (existing.length === 0) {
    for (let i = 1; i <= 5; i++) {
      await d.createLobby(i);
    }
  }

  server.listen(PORT, () => {
    console.log(`StandLeo server running on http://localhost:${PORT}`);
    console.log(`WebSocket available on ws://localhost:${PORT}`);
  });
}

start().catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});