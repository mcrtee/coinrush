// =====================================================================
//  Coin Rush Online — сервер (Node.js + Express + WebSocket)
//  Сервер "авторитетный": вся физика и подсчёт очков считаются ЗДЕСЬ,
//  клиенты только отправляют нажатия клавиш и рисуют то, что прислал сервер.
//  Поэтому жульничать (менять свой счёт) в браузере нельзя.
// =====================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---------- Настройки игры ----------
const W = 900, H = 560, R = 14;      // размер поля и радиус игрока
const MAX_PLAYERS = 8;
const TICK_RATE = 30;                // физика + рассылка: 30 раз в секунду
const BASE_SPEED = 230;              // px/сек
const SPEED_BOOST = 1.55;            // множитель ускорения
const DASH_SPEED = 700, DASH_TIME = 0.18, DASH_COOLDOWN = 2.5;
const MAGNET_RADIUS = 150, MAGNET_PULL = 280;
const COUNTDOWN = 3;                 // секунд перед стартом
const OVER_TIME = 8;                 // сколько показываем итоги
const DURATIONS = [30, 60, 90, 120];
const COLORS = ['#ff5c5c', '#4ecbff', '#7dff6a', '#d98bff', '#ffa94d', '#ff7ad9', '#f5f06a', '#6affd5'];
const POWERUPS = ['speed', 'magnet', 'shield'];

const rooms = new Map();
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- Комнаты ----------
function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    players: new Map(),
    items: [],
    phase: 'lobby',          // lobby -> countdown -> play -> over -> lobby
    clock: 0,                // внутреннее время комнаты (сек)
    duration: 60,
    time: 60,
    cd: 0,
    overT: 0,
    host: null,
    nextId: 1,
    spawn: { gold: 6, bomb: 5, pu: 7 }
  };
  rooms.set(room.code, room);
  return room;
}

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
}

function addPlayer(room, ws, name) {
  const used = new Set([...room.players.values()].map(p => p.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[0];
  const p = {
    id: 'p' + room.nextId++, ws, name: cleanName(name) || 'Игрок', color,
    x: rand(60, W - 60), y: rand(60, H - 60),
    dx: 0, dy: 0, fx: 1, fy: 0,
    score: 0, wins: 0,
    speedUntil: 0, magnetUntil: 0, shield: false,
    stunUntil: 0, dashUntil: 0, dashCd: 0, hitUntil: 0,
    lastChat: 0
  };
  room.players.set(p.id, p);
  if (!room.host) room.host = p.id;
  ws.player = p;
  ws.room = room;
  return p;
}

function removePlayer(ws) {
  const room = ws.room, p = ws.player;
  if (!room || !p) return;
  room.players.delete(p.id);
  ws.room = null; ws.player = null;
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.host === p.id) room.host = room.players.keys().next().value; // новый хост
  sendAll(room, { t: 'chat', sys: true, text: p.name + ' вышел' });
}

// ---------- Отправка ----------
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendAll(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(data);
}

// ---------- Предметы ----------
function addItem(room, k, ttl) {
  room.items.push({ i: room.nextId++, k, x: rand(30, W - 30), y: rand(30, H - 30), ttl: ttl || 0 });
}
function countKind(room, kinds) { return room.items.filter(it => kinds.includes(it.k)).length; }

function startRound(room) {
  room.phase = 'play';
  room.time = room.duration;
  room.items = [];
  room.spawn = { gold: rand(5, 8), bomb: 4, pu: 6 };
  for (const p of room.players.values()) {
    p.score = 0; p.shield = false;
    p.speedUntil = p.magnetUntil = p.stunUntil = p.dashUntil = p.dashCd = 0;
  }
  for (let i = 0; i < 8; i++) addItem(room, 'coin');
}

function endRound(room) {
  room.phase = 'over';
  room.overT = OVER_TIME;
  room.items = [];
  const list = [...room.players.values()].sort((a, b) => b.score - a.score);
  if (list.length && list[0].score > 0) {
    // победителями считаются все с максимальным счётом
    list.filter(p => p.score === list[0].score).forEach(p => p.wins++);
  }
}

// ---------- Физика одного игрока ----------
function movePlayer(room, p, dt) {
  const now = room.clock;
  let vx = 0, vy = 0;
  if (now < p.dashUntil) {
    vx = p.fx * DASH_SPEED; vy = p.fy * DASH_SPEED;
  } else if (now >= p.stunUntil) {
    const sp = BASE_SPEED * (now < p.speedUntil ? SPEED_BOOST : 1);
    vx = p.dx * sp; vy = p.dy * sp;
  }
  p.x = clamp(p.x + vx * dt, R, W - R);
  p.y = clamp(p.y + vy * dt, R, H - R);
  if (p.dashCd > 0) p.dashCd = Math.max(0, p.dashCd - dt);
}

function emit(room, ev) { sendAll(room, Object.assign({ t: 'ev' }, ev)); }

function collectItems(room, p) {
  const now = room.clock;
  for (let i = room.items.length - 1; i >= 0; i--) {
    const it = room.items[i];
    // магнит притягивает только монеты
    if (now < p.magnetUntil && (it.k === 'coin' || it.k === 'gold')) {
      const d = Math.hypot(p.x - it.x, p.y - it.y);
      if (d < MAGNET_RADIUS && d > 1) {
        it.x += (p.x - it.x) / d * MAGNET_PULL * (1 / TICK_RATE);
        it.y += (p.y - it.y) / d * MAGNET_PULL * (1 / TICK_RATE);
      }
    }
    if (Math.hypot(p.x - it.x, p.y - it.y) > R + 11) continue;

    room.items.splice(i, 1);
    if (it.k === 'coin') {
      p.score += 1; addItem(room, 'coin');
      emit(room, { k: 'coin', id: p.id, x: it.x, y: it.y, v: '+1' });
    } else if (it.k === 'gold') {
      p.score += 5;
      emit(room, { k: 'gold', id: p.id, x: it.x, y: it.y, v: '+5' });
    } else if (it.k === 'bomb') {
      if (p.shield) {
        p.shield = false;
        emit(room, { k: 'shield', id: p.id, x: p.x, y: p.y, v: 'Щит!' });
      } else {
        p.score = Math.max(0, p.score - 3);
        p.stunUntil = now + 1.0;
        emit(room, { k: 'bomb', id: p.id, x: it.x, y: it.y, v: '-3' });
      }
    } else if (it.k === 'speed') {
      p.speedUntil = now + 6;
      emit(room, { k: 'pu', id: p.id, x: it.x, y: it.y, v: '⚡ Скорость' });
    } else if (it.k === 'magnet') {
      p.magnetUntil = now + 7;
      emit(room, { k: 'pu', id: p.id, x: it.x, y: it.y, v: '🧲 Магнит' });
    } else if (it.k === 'shield') {
      p.shield = true;
      emit(room, { k: 'pu', id: p.id, x: it.x, y: it.y, v: '🛡 Щит' });
    }
  }
}

// Рывок игрока в другого = кража очков
function dashHits(room, p) {
  const now = room.clock;
  if (now >= p.dashUntil) return;
  for (const q of room.players.values()) {
    if (q === p || now < q.hitUntil) continue;
    if (Math.hypot(p.x - q.x, p.y - q.y) > R * 2 + 2) continue;
    q.hitUntil = now + 1.2;
    if (q.shield) {
      q.shield = false;
      emit(room, { k: 'shield', id: q.id, x: q.x, y: q.y, v: 'Щит!' });
    } else {
      const steal = Math.min(2, q.score);
      q.score -= steal; p.score += steal;
      q.stunUntil = now + 0.4;
      emit(room, { k: 'steal', id: p.id, x: q.x, y: q.y, v: steal ? '-' + steal : 'Бам!' });
    }
  }
}

function tickRoom(room, dt) {
  room.clock += dt;

  for (const p of room.players.values()) movePlayer(room, p, dt);

  if (room.phase === 'countdown') {
    room.cd -= dt;
    if (room.cd <= 0) startRound(room);
  } else if (room.phase === 'play') {
    room.time -= dt;

    // появление особых предметов
    const s = room.spawn;
    s.gold -= dt; s.bomb -= dt; s.pu -= dt;
    if (s.gold <= 0) { addItem(room, 'gold', 8); s.gold = rand(7, 12); }
    if (s.bomb <= 0) { if (countKind(room, ['bomb']) < 4) addItem(room, 'bomb', 14); s.bomb = 4; }
    if (s.pu <= 0) {
      if (countKind(room, POWERUPS) < 2) addItem(room, POWERUPS[Math.floor(Math.random() * 3)], 12);
      s.pu = 9;
    }
    // срок жизни
    room.items = room.items.filter(it => {
      if (!it.ttl) return true;
      it.ttl -= dt;
      return it.ttl > 0;
    });

    for (const p of room.players.values()) { collectItems(room, p); dashHits(room, p); }
    if (room.time <= 0) { room.time = 0; endRound(room); }
  } else if (room.phase === 'over') {
    room.overT -= dt;
    if (room.overT <= 0) room.phase = 'lobby';
  }

  broadcast(room);
}

function broadcast(room) {
  const now = room.clock, r1 = v => Math.round(v * 10) / 10;
  const ps = [];
  for (const p of room.players.values()) {
    ps.push({
      i: p.id, n: p.name, c: p.color, x: r1(p.x), y: r1(p.y), s: p.score, w: p.wins,
      sh: p.shield ? 1 : 0,
      sp: Math.max(0, r1(p.speedUntil - now)),
      mg: Math.max(0, r1(p.magnetUntil - now)),
      st: now < p.stunUntil ? 1 : 0,
      ds: now < p.dashUntil ? 1 : 0,
      dc: r1(p.dashCd)
    });
  }
  const it = room.items.map(i => ({ i: i.i, k: i.k, x: r1(i.x), y: r1(i.y), l: i.ttl ? r1(i.ttl) : 0 }));
  sendAll(room, {
    t: 's', ph: room.phase, tm: r1(room.time), cd: r1(room.cd), ov: r1(room.overT),
    hd: room.host, d: room.duration, ps, it
  });
}

// Один общий цикл для всех комнат
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  for (const room of rooms.values()) tickRoom(room, dt);
}, 1000 / TICK_RATE);

// ---------- HTTP + WebSocket ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    // --- вход в игру ---
    if (m.t === 'create' || m.t === 'join') {
      if (ws.room) return;
      let room;
      if (m.t === 'create') {
        if (rooms.size >= 200) return send(ws, { t: 'err', text: 'Сервер переполнен, попробуйте позже' });
        room = createRoom();
      } else {
        room = rooms.get(String(m.room || '').toUpperCase());
        if (!room) return send(ws, { t: 'err', text: 'Комната не найдена' });
        if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', text: 'Комната заполнена' });
      }
      const p = addPlayer(room, ws, m.name);
      send(ws, { t: 'w', id: p.id, room: room.code });
      sendAll(room, { t: 'chat', sys: true, text: p.name + ' присоединился' });
      return;
    }

    const room = ws.room, p = ws.player;
    if (!room || !p) return;

    switch (m.t) {
      case 'in': { // направление движения (можно дробное — для джойстика)
        let dx = Number(m.dx) || 0, dy = Number(m.dy) || 0;
        const len = Math.hypot(dx, dy);
        if (len > 1) { dx /= len; dy /= len; }
        p.dx = dx; p.dy = dy;
        if (len > 0.1) { p.fx = dx / len; p.fy = dy / len; }
        break;
      }
      case 'dash':
        if (room.phase !== 'lobby' && room.phase !== 'play' && room.phase !== 'countdown') break;
        if (p.dashCd <= 0 && room.clock >= p.stunUntil) {
          p.dashUntil = room.clock + DASH_TIME;
          p.dashCd = DASH_COOLDOWN;
        }
        break;
      case 'start':
        if (room.host === p.id && room.phase === 'lobby') { room.phase = 'countdown'; room.cd = COUNTDOWN; }
        break;
      case 'dur':
        if (room.host === p.id && room.phase === 'lobby' && DURATIONS.includes(m.v)) room.duration = m.v;
        break;
      case 'chat': {
        const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
        const now = Date.now();
        if (!text || now - p.lastChat < 500) break;
        p.lastChat = now;
        sendAll(room, { t: 'chat', n: p.name, c: p.color, text });
        break;
      }
    }
  });

  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => {});
});

// Убираем "мёртвые" соединения
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Coin Rush Online запущен: http://localhost:' + PORT));
