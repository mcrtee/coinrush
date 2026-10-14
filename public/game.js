// =====================================================================
//  Coin Rush Online — клиент
//  Делает три вещи: 1) шлёт на сервер нажатия, 2) принимает состояние,
//  3) плавно рисует его на canvas. Никакой игровой логики здесь нет.
// =====================================================================
const W = 900, H = 560, R = 14;
const $ = id => document.getElementById(id);

const canvas = $('c'), ctx = canvas.getContext('2d');
const el = {
  menu: $('menu'), game: $('game'), name: $('name'), code: $('code'), msg: $('menuMsg'),
  lobby: $('lobby'), plist: $('plist'), startBtn: $('startBtn'), dur: $('dur'),
  hostControls: $('hostControls'), waitMsg: $('waitMsg'),
  chatlog: $('chatlog'), chatinput: $('chatinput')
};

let ws = null, myId = null, roomCode = '';
let state = null;                 // последнее состояние от сервера
const view = {};                  // сглаженные позиции игроков
const particles = [], floaters = [];
let muted = false;

// ---------- Звук (WebAudio, без файлов) ----------
let audio = null;
function beep(freq, dur = 0.1, type = 'sine', vol = 0.08, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, audio.currentTime + dur);
    g.gain.setValueAtTime(vol, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + dur);
  } catch (e) { /* звук необязателен */ }
}
const SOUNDS = {
  coin: () => beep(880, 0.08, 'square', 0.05, 300),
  gold: () => { beep(660, 0.1, 'triangle', 0.08, 500); setTimeout(() => beep(990, 0.15, 'triangle', 0.08), 90); },
  bomb: () => beep(140, 0.35, 'sawtooth', 0.12, -90),
  pu: () => beep(520, 0.2, 'sine', 0.09, 400),
  shield: () => beep(300, 0.15, 'square', 0.08, 200),
  steal: () => beep(200, 0.15, 'square', 0.1, 150),
  tick: () => beep(600, 0.08, 'square', 0.06),
  go: () => beep(900, 0.3, 'square', 0.08),
  end: () => { beep(500, 0.2, 'triangle'); setTimeout(() => beep(400, 0.2, 'triangle'), 180); setTimeout(() => beep(300, 0.4, 'triangle'), 360); }
};
const play = n => SOUNDS[n] && SOUNDS[n]();

// ---------- Подключение ----------
function connect(action) {
  const name = el.name.value.trim();
  const code = el.code.value.trim().toUpperCase();
  if (action === 'join' && code.length !== 4) { el.msg.textContent = 'Введите 4-буквенный код'; return; }
  try { localStorage.setItem('cr_name', name); } catch (e) {}

  el.msg.textContent = 'Подключаемся…';
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host);

  ws.onopen = () => ws.send(JSON.stringify({ t: action, name, room: code }));
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => { if (myId) backToMenu('Соединение потеряно'); else el.msg.textContent = el.msg.textContent === 'Подключаемся…' ? 'Не удалось подключиться' : el.msg.textContent; };
}
const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function backToMenu(text) {
  myId = null; state = null;
  for (const k in view) delete view[k];
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  el.game.hidden = true; el.menu.style.display = '';
  el.msg.textContent = text || '';
  history.replaceState(null, '', location.pathname);
}

function onMessage(m) {
  switch (m.t) {
    case 'w':
      myId = m.id; roomCode = m.room;
      el.menu.style.display = 'none'; el.game.hidden = false;
      $('roomLabel').textContent = $('lobbyCode').textContent = roomCode;
      history.replaceState(null, '', '?room=' + roomCode);
      break;
    case 'err': el.msg.textContent = m.text; if (ws) { ws.onclose = null; ws.close(); ws = null; } break;
    case 's': onState(m); break;
    case 'ev': onEvent(m); break;
    case 'chat': addChat(m); break;
  }
}

let prevPhase = null, prevCd = 0;
function onState(s) {
  state = s;
  // Звуки смены фаз
  if (s.ph === 'countdown') { const c = Math.ceil(s.cd); if (c !== prevCd) { play('tick'); prevCd = c; } }
  if (prevPhase === 'countdown' && s.ph === 'play') play('go');
  if (prevPhase === 'play' && s.ph === 'over') play('end');
  prevPhase = s.ph;

  // Лобби показываем только в фазе lobby
  el.lobby.hidden = s.ph !== 'lobby';
  if (s.ph === 'lobby') {
    el.plist.innerHTML = '';
    s.ps.forEach(p => {
      const li = document.createElement('li');
      li.style.borderLeft = '6px solid ' + p.c;
      li.textContent = (p.i === s.hd ? '👑 ' : '') + p.n + (p.i === myId ? ' (вы)' : '') + (p.w ? '  🏆' + p.w : '');
      el.plist.appendChild(li);
    });
    const iAmHost = s.hd === myId;
    el.hostControls.style.display = iAmHost ? 'flex' : 'none';
    el.waitMsg.style.display = iAmHost ? 'none' : '';
    el.dur.value = String(s.d);
  }
}

// ---------- События (эффекты) ----------
function onEvent(e) {
  const mine = e.id === myId;
  const colors = { coin: '#ffd24a', gold: '#fff27a', bomb: '#ff5c5c', pu: '#7dffb0', shield: '#7ad0ff', steal: '#ff9cf0' };
  const col = colors[e.k] || '#fff';
  floaters.push({ x: e.x, y: e.y, text: e.v, color: col, life: 1 });
  const n = e.k === 'bomb' ? 24 : e.k === 'gold' ? 18 : 8;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 160;
    particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.6, color: col, size: 2 + Math.random() * 3 });
  }
  if (mine || e.k === 'bomb') play(e.k);
}

// ---------- Чат ----------
function addChat(m) {
  const d = document.createElement('div');
  if (m.sys) { d.className = 'sys'; d.textContent = '• ' + m.text; }
  else {
    const b = document.createElement('b'); b.style.color = m.c; b.textContent = m.n + ': ';
    d.appendChild(b); d.appendChild(document.createTextNode(m.text));
  }
  el.chatlog.appendChild(d);
  while (el.chatlog.children.length > 60) el.chatlog.removeChild(el.chatlog.firstChild);
  el.chatlog.scrollTop = el.chatlog.scrollHeight;
}

// ---------- Управление ----------
const keys = {};
let sentDx = 0, sentDy = 0;
let joy = { dx: 0, dy: 0 };
const typing = () => document.activeElement === el.chatinput;

window.addEventListener('keydown', e => {
  if (!myId) return;
  if (typing()) {
    if (e.key === 'Enter') {
      const text = el.chatinput.value.trim();
      if (text) send({ t: 'chat', text });
      el.chatinput.value = ''; el.chatinput.blur();
    } else if (e.key === 'Escape') el.chatinput.blur();
    return;
  }
  if (e.key === 'Enter') { el.chatinput.focus(); e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
  if (e.key === ' ' && !e.repeat) { send({ t: 'dash' }); beep(250, 0.12, 'sawtooth', 0.05, 200); }
  keys[k] = true;
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// Раскладка: WASD работает и на русской (ц ф ы в)
const K = {
  left: ['a', 'arrowleft', 'ф'], right: ['d', 'arrowright', 'в'],
  up: ['w', 'arrowup', 'ц'], down: ['s', 'arrowdown', 'ы']
};
const down = list => list.some(k => keys[k]);

function readInput() {
  let dx = (down(K.right) ? 1 : 0) - (down(K.left) ? 1 : 0);
  let dy = (down(K.down) ? 1 : 0) - (down(K.up) ? 1 : 0);
  if (!dx && !dy) { dx = joy.dx; dy = joy.dy; }
  return { dx, dy };
}

// Отправляем ввод только при изменении + раз в 200 мс (на случай потери пакета)
let lastSend = 0;
setInterval(() => {
  if (!myId) return;
  const { dx, dy } = readInput();
  const r = v => Math.round(v * 100) / 100;
  const now = performance.now();
  if (r(dx) !== sentDx || r(dy) !== sentDy || now - lastSend > 200) {
    sentDx = r(dx); sentDy = r(dy); lastSend = now;
    send({ t: 'in', dx: sentDx, dy: sentDy });
  }
}, 33);

// Тач-управление
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
  $('touch').hidden = false;
  const joyEl = $('joy'), knob = $('knob');
  const moveJoy = t => {
    const r = joyEl.getBoundingClientRect();
    let x = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    joy = { dx: Math.abs(x) < 0.15 ? 0 : x, dy: Math.abs(y) < 0.15 ? 0 : y };
    knob.style.transform = `translate(${x * 35}px, ${y * 35}px)`;
  };
  joyEl.addEventListener('touchstart', e => { e.preventDefault(); moveJoy(e.touches[0]); }, { passive: false });
  joyEl.addEventListener('touchmove', e => { e.preventDefault(); moveJoy(e.touches[0]); }, { passive: false });
  const stopJoy = () => { joy = { dx: 0, dy: 0 }; knob.style.transform = ''; };
  joyEl.addEventListener('touchend', stopJoy);
  joyEl.addEventListener('touchcancel', stopJoy);
  $('dashBtn').addEventListener('touchstart', e => { e.preventDefault(); send({ t: 'dash' }); }, { passive: false });
}

// ---------- Рисование ----------
let lastFrame = performance.now();

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  draw(dt, now);
  requestAnimationFrame(frame);
}

function draw(dt, now) {
  ctx.clearRect(0, 0, W, H);
  drawGrid();
  if (!state) return;

  // сглаживание позиций (интерполяция к данным сервера)
  const k = 1 - Math.pow(1e-6, dt);
  const alive = new Set();
  for (const p of state.ps) {
    alive.add(p.i);
    const v = view[p.i] || (view[p.i] = { x: p.x, y: p.y });
    if (Math.hypot(p.x - v.x, p.y - v.y) > 120) { v.x = p.x; v.y = p.y; }
    else { v.x += (p.x - v.x) * k; v.y += (p.y - v.y) * k; }
    if (p.ds) for (let i = 0; i < 2; i++) particles.push({ x: v.x, y: v.y, vx: (Math.random() - .5) * 40, vy: (Math.random() - .5) * 40, life: 0.35, color: p.c, size: 6 });
  }
  for (const id in view) if (!alive.has(id)) delete view[id];

  drawItems(now);
  drawPlayers(now);
  drawParticles(dt);
  drawHUD(now);
}

function drawGrid() {
  ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
}

function drawItems(now) {
  const t = now / 200;
  for (const it of state.it) {
    // мигаем, когда предмет скоро исчезнет
    if (it.l && it.l < 3 && Math.floor(now / 150) % 2) continue;
    ctx.save(); ctx.translate(it.x, it.y);
    if (it.k === 'coin') {
      ctx.beginPath(); ctx.ellipse(0, 0, 10 * Math.abs(Math.cos(t + it.i)) + 2, 10, 0, 0, 7);
      ctx.fillStyle = '#ffd24a'; ctx.fill(); ctx.strokeStyle = '#b8860b'; ctx.lineWidth = 2; ctx.stroke();
    } else if (it.k === 'gold') {
      ctx.shadowColor = '#fff27a'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.ellipse(0, 0, 14 * Math.abs(Math.cos(t * .8)) + 3, 14, 0, 0, 7);
      ctx.fillStyle = '#fff27a'; ctx.fill(); ctx.strokeStyle = '#e0a800'; ctx.lineWidth = 3; ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = '#b8860b'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'; ctx.fillText('5', 0, 5);
    } else if (it.k === 'bomb') {
      const pulse = 1 + Math.sin(now / 120) * 0.08;
      ctx.scale(pulse, pulse);
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, 7); ctx.fillStyle = '#222'; ctx.fill();
      ctx.strokeStyle = '#ff5c5c'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#ff5c5c'; ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('💣', 0, 5);
    } else {
      const icon = { speed: '⚡', magnet: '🧲', shield: '🛡' }[it.k];
      const col = { speed: '#ffe14a', magnet: '#ff7a7a', shield: '#7ad0ff' }[it.k];
      ctx.beginPath(); ctx.arc(0, 0, 14 + Math.sin(now / 200) * 1.5, 0, 7);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText(icon, 0, 6);
    }
    ctx.restore();
  }
}

function drawPlayers(now) {
  for (const p of state.ps) {
    const v = view[p.i]; if (!v) continue;
    ctx.save(); ctx.translate(v.x, v.y);
    if (p.mg > 0) { // зона магнита
      ctx.beginPath(); ctx.arc(0, 0, 150, 0, 7);
      ctx.strokeStyle = 'rgba(255,122,122,0.25)'; ctx.setLineDash([6, 8]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.globalAlpha = p.st ? 0.5 + 0.3 * Math.sin(now / 40) : 1;
    ctx.beginPath(); ctx.arc(0, 0, R + (p.sp > 0 ? 2 : 0), 0, 7);
    ctx.fillStyle = p.c; ctx.fill();
    ctx.globalAlpha = 1;
    if (p.i === myId) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); }
    if (p.sh) { ctx.beginPath(); ctx.arc(0, 0, R + 6, 0, 7); ctx.strokeStyle = '#7ad0ff'; ctx.lineWidth = 3; ctx.stroke(); }
    if (p.st) { ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('💫', 0, -R - 18); }
    ctx.fillStyle = '#fff'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(p.n, 0, -R - 6);
    ctx.restore();
  }
}

function drawParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i]; q.life -= dt;
    if (q.life <= 0) { particles.splice(i, 1); continue; }
    q.x += q.vx * dt; q.y += q.vy * dt;
    ctx.globalAlpha = Math.max(0, q.life * 1.6); ctx.fillStyle = q.color;
    ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
  }
  ctx.globalAlpha = 1;
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; f.life -= dt; f.y -= 40 * dt;
    if (f.life <= 0) { floaters.splice(i, 1); continue; }
    ctx.globalAlpha = Math.min(1, f.life * 2); ctx.fillStyle = f.color;
    ctx.font = 'bold 18px system-ui'; ctx.textAlign = 'center'; ctx.fillText(f.text, f.x, f.y - 16);
  }
  ctx.globalAlpha = 1;
}

function drawHUD(now) {
  const sorted = [...state.ps].sort((a, b) => b.s - a.s);

  // таблица очков
  ctx.textAlign = 'left'; ctx.font = 'bold 16px system-ui';
  sorted.forEach((p, i) => {
    ctx.fillStyle = p.c;
    ctx.fillText((i === 0 && p.s > 0 && state.ph === 'play' ? '👑 ' : '') + p.n + ': ' + p.s + (p.w ? '  🏆' + p.w : ''), 12, 24 + i * 22);
  });

  // таймер
  if (state.ph === 'play') {
    ctx.textAlign = 'right'; ctx.font = 'bold 26px system-ui';
    ctx.fillStyle = state.tm <= 10 ? (Math.floor(now / 250) % 2 ? '#ff5c5c' : '#fff') : '#fff';
    ctx.fillText('⏱ ' + Math.ceil(state.tm), W - 14, 32);
  }

  // моё состояние: рывок и эффекты
  const me = state.ps.find(p => p.i === myId);
  if (me && state.ph !== 'over') {
    const ready = me.dc <= 0, w = 120;
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(W / 2 - w / 2, H - 22, w, 10);
    ctx.fillStyle = ready ? '#7dff6a' : '#ffa94d';
    ctx.fillRect(W / 2 - w / 2, H - 22, w * (ready ? 1 : 1 - me.dc / 2.5), 10);
    ctx.fillStyle = '#fff'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(ready ? 'РЫВОК готов (Пробел)' : 'рывок…', W / 2, H - 28);
    const fx = [];
    if (me.sp > 0) fx.push('⚡ ' + Math.ceil(me.sp));
    if (me.mg > 0) fx.push('🧲 ' + Math.ceil(me.mg));
    if (me.sh) fx.push('🛡');
    ctx.textAlign = 'right'; ctx.font = '16px system-ui'; ctx.fillStyle = '#fff';
    ctx.fillText(fx.join('   '), W - 14, H - 14);
  }

  // центральные сообщения
  if (state.ph === 'countdown') {
    ctx.fillStyle = '#ffd24a'; ctx.textAlign = 'center'; ctx.font = 'bold 120px system-ui';
    ctx.fillText(Math.max(1, Math.ceil(state.cd)), W / 2, H / 2 + 40);
  } else if (state.ph === 'over') {
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, 70, W, H - 140);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffd24a'; ctx.font = 'bold 34px system-ui';
    const top = sorted[0];
    const winners = sorted.filter(p => p.s === top.s);
    ctx.fillText(top.s > 0 ? '🏆 ' + winners.map(p => p.n).join(' и ') + ' — победа!' : 'Ничья!', W / 2, 120);
    ctx.font = 'bold 22px system-ui';
    sorted.slice(0, 8).forEach((p, i) => {
      ctx.fillStyle = p.c; ctx.fillText((i + 1) + '. ' + p.n + ' — ' + p.s, W / 2, 165 + i * 30);
    });
    ctx.fillStyle = '#9fb3ff'; ctx.font = '16px system-ui';
    ctx.fillText('Возврат в лобби через ' + Math.ceil(state.ov) + ' сек', W / 2, H - 85);
  }
}

// ---------- Кнопки ----------
$('createBtn').onclick = () => connect('create');
$('joinBtn').onclick = () => connect('join');
$('leaveBtn').onclick = () => backToMenu('');
$('startBtn').onclick = () => send({ t: 'start' });
el.dur.onchange = () => send({ t: 'dur', v: Number(el.dur.value) });
$('muteBtn').onclick = e => { muted = !muted; e.target.textContent = muted ? '🔇' : '🔊'; };
$('copyBtn').onclick = e => {
  const link = location.origin + '/?room=' + roomCode;
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
    .then(() => { e.target.textContent = '✅ Скопировано'; }, () => { prompt('Скопируйте ссылку:', link); })
    .finally(() => setTimeout(() => { e.target.textContent = '📋 Ссылка'; }, 1500));
};
el.code.addEventListener('input', () => { el.code.value = el.code.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4); });
el.name.addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });
el.code.addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

// Имя из прошлого раза и вход по ссылке ?room=ABCD
try { el.name.value = localStorage.getItem('cr_name') || ''; } catch (e) {}
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) { el.code.value = urlRoom.toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4); el.msg.textContent = 'Введите имя и нажмите «Войти»'; }

requestAnimationFrame(frame);
