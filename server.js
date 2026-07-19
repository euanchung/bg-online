// ============================================================
// BATTLE GROUNDS 멀티플레이 서버 (2단계)
// 파밍/무기/수류탄/차량/에어드랍/폭격/비 동기화
// 실행: npm install ws  →  node server.js
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const MAP_HALF = 600;
const CAR_N = 10;
const FAST = !!process.env.FASTEVENTS; // 테스트용

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'multiplayer.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('multiplayer.html 파일이 서버와 같은 폴더에 있어야 합니다.'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end(); }
});
const wss = new WebSocket.Server({ server });

// ---------- 무기별 피해 테이블 (서버 판정) ----------
const WDMG = {
  rifle:   { b: 26,  h: 62,  rng: 380 },
  shotgun: { b: 9,   h: 18,  rng: 80 },
  sniper:  { b: 80,  h: 200, rng: 950 },
  fist:    { b: 20,  h: 20,  rng: 4.5 },
  car:     { b: 70,  h: 70,  rng: 7 },
  nade:    { b: 0,   h: 0,   rng: 70 }, // dmg는 클라이언트 계산(거리 감쇠), 상한만 적용
};

let seed = Math.floor(Math.random() * 1e9);
let nextId = 1;
let roundActive = false;
let gameState = 'lobby'; // 'lobby' | 'playing' | 'ended'
let planeStartAt = 0;    // 게임 시작(수송기 출발) 시각
let matchStartCount = 0; // 이번 판을 시작한 인원 수
const players = new Map();
let taken = new Set();       // 획득된 아이템 idx
let dynIdx = 100000;         // 동적 아이템(투하/드랍) idx 시작
let cars = [];
function resetCars(){
  cars = [];
  for (let i = 0; i < CAR_N; i++) cars.push({ hp: 500, fuel: 45, x: 0, z: 0, h: 0, drv: 0, dead: false, mv: 0, pass: [] });
}
resetCars();

// ---------- 자기장 ----------
const phases = [
  { wait: 50, shrink: 50, mult: 0.74, dps: 1 },
  { wait: 35, shrink: 40, mult: 0.70, dps: 2 },
  { wait: 28, shrink: 34, mult: 0.64, dps: 4 },
  { wait: 22, shrink: 28, mult: 0.58, dps: 7 },
  { wait: 16, shrink: 22, mult: 0.50, dps: 10 },
  { wait: 12, shrink: 16, mult: 0.40, dps: 15 },
];
let zone;
function resetZone() {
  zone = { cx: 0, cz: 0, r: MAP_HALF * 0.95, phase: 0, timer: phases[0].wait, shrinking: false, dps: phases[0].dps, ncx: 0, ncz: 0, nr: 0, sr: 0, scx: 0, scz: 0 };
  pickNext();
}
function pickNext() {
  const p = phases[Math.min(zone.phase, phases.length - 1)];
  zone.nr = zone.r * p.mult;
  const maxOff = (zone.r - zone.nr) * 0.8;
  const a = Math.random() * Math.PI * 2, d = Math.random() * maxOff;
  zone.ncx = zone.cx + Math.cos(a) * d;
  zone.ncz = zone.cz + Math.sin(a) * d;
}
resetZone();

function send(p, obj) { try { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    try { if (p.ws.readyState === 1) p.ws.send(s); } catch (e) {}
  }
}
function spawnPos(i) {
  const a = (i * 2.399963) % (Math.PI * 2);
  const r = MAP_HALF * 0.55;
  return [Math.cos(a) * r, Math.sin(a) * r];
}
function sendLobby() {
  if (gameState !== 'lobby') return;
  const list = [...players.values()].map(q => ({ id: q.id, name: q.name, color: q.color, ready: q.ready }));
  broadcast({ t: 'lobby', players: list, count: players.size });
}
function startMatch() {
  gameState = 'playing';
  roundActive = true;
  // seed는 그대로 유지 — 모든 접속자가 init에서 이미 같은 seed로 월드를 만들었음
  resetZone(); resetCars();
  taken = new Set();
  planeStartAt = Date.now();
  matchStartCount = players.size;
  for (const q of players.values()) {
    const [sx2, sz2] = spawnPos(q.id);
    q.hp = 100; q.armor = 0; q.helmet = false; q.bag = 0; q.w = '';
    q.alive = true; q.x = sx2; q.z = sz2; q.kills = 0; q.d = 1; q.ready = false;
    q.spectating = false;
  }
  broadcast({ t: 'start', seed });
  console.log('[게임 시작] 시드 ' + seed + ' (' + players.size + '명)');
}
const WIDX = { '': 0, rifle: 1, shotgun: 2, sniper: 3 };

wss.on('connection', (ws) => {
  const id = nextId++;
  const [sx, sz] = spawnPos(id);
  const joinedMidGame = (gameState === 'playing');
  const p = { ws, id, name: '플레이어' + id, x: sx, y: 0, z: sz, yaw: 0, pitch: 0, stance: 'stand', hp: 100, armor: 0, helmet: false, bag: 0, w: '', alive: !joinedMidGame, kills: 0, color: (id-1)%8, ready: false, d: 0, spectating: joinedMidGame };
  players.set(id, p);
  send(p, {
    t: 'init', id, seed, spawn: [sx, sz], taken: [...taken], state: gameState,
    cars: cars.map((c, i) => [i, +c.x.toFixed(1), +c.z.toFixed(1), +c.h.toFixed(2), Math.round(c.hp), c.drv, c.mv, Math.round(c.fuel), c.pass.slice()]),
    players: [...players.values()].filter(q => q.id !== id)
      .map(q => ({ id: q.id, name: q.name, x: q.x, y: q.y, z: q.z, yaw: q.yaw, stance: q.stance, hp: q.hp, alive: q.alive, color: q.color, ready: q.ready })),
  });
  broadcast({ t: 'pjoin', id, name: p.name, color: p.color }, id);
  sendLobby();
  console.log('[+] 접속: #' + id + ' (현재 ' + players.size + '명)');

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'join') { p.name = String(m.name || '').slice(0, 12) || ('플레이어' + id); broadcast({ t: 'pname', id, name: p.name }); sendLobby(); }
    else if (m.t === 'color') {
      if (gameState !== 'lobby') return;
      const c = m.color | 0;
      if (c >= 0 && c < 8) { p.color = c; broadcast({ t: 'pcolor', id, color: c }); sendLobby(); }
    }
    else if (m.t === 'ready') {
      if (gameState !== 'lobby') return;
      p.ready = !!m.ready;
      sendLobby();
    }
    else if (m.t === 'startgame') {
      if (gameState !== 'lobby') return;
      startMatch();
    }
    else if (m.t === 'state') {
      if (!p.alive) return;
      p.x = +m.x || 0; p.y = +m.y || 0; p.z = +m.z || 0;
      p.yaw = +m.yaw || 0; p.pitch = +m.pitch || 0;
      p.stance = (m.stance === 'prone') ? 'prone' : 'stand';
      p.w = WIDX[m.w] !== undefined ? m.w : '';
      p.d = m.d ? 1 : 0;
    }
    else if (m.t === 'gear') {
      p.armor = Math.max(0, Math.min(100, +m.armor || 0));
      p.helmet = !!m.helmet;
      p.bag = Math.max(0, Math.min(3, +m.bag | 0));
      broadcast({ t: 'hp', id, hp: Math.round(p.hp), armor: Math.round(p.armor) });
    }
    else if (m.t === 'take') {
      const idx = +m.idx;
      if (!Number.isFinite(idx) || taken.has(idx)) return;
      taken.add(idx);
      broadcast({ t: 'takeok', idx, by: id });
    }
    else if (m.t === 'drop') {
      const idx = dynIdx++;
      broadcast({ t: 'itemadd', idx, x: +m.x || 0, z: +m.z || 0, type: String(m.type || 'ammo').slice(0, 12) });
    }
    else if (m.t === 'heal') {
      if (!p.alive) return;
      const amt = Math.max(0, Math.min(100, +m.amt || 0));
      p.hp = Math.min(100, p.hp + amt);
      broadcast({ t: 'hp', id, hp: Math.round(p.hp), armor: Math.round(p.armor) });
    }
    else if (m.t === 'selfdmg') {
      if (!p.alive || !roundActive || gameState !== 'playing') return;
      applyDamage(p, Math.max(0, Math.min(130, +m.amt || 0)), null, false, String(m.cause || '피해').slice(0, 20));
    }
    else if (m.t === 'shoot') {
      if (!p.alive || !roundActive) return;
      broadcast({ t: 'shot', id, o: m.o, e: m.e, w: m.w }, id);
    }
    else if (m.t === 'nade') {
      if (!p.alive || !roundActive) return;
      broadcast({ t: 'nade', id, kind: m.kind === 'smoke' ? 'smoke' : 'frag', o: m.o, v: m.v }, id);
    }
    else if (m.t === 'hit') {
      if (!p.alive || !roundActive) return;
      const tgt = players.get(+m.target);
      if (!tgt || !tgt.alive) return;
      const wp = WDMG[m.w] || WDMG.rifle;
      const dx = tgt.x - p.x, dz = tgt.z - p.z;
      if (dx * dx + dz * dz > wp.rng * wp.rng) return;
      let dmg = (m.w === 'nade') ? Math.max(0, Math.min(130, +m.dmg || 0)) : (m.head ? wp.h : wp.b);
      if (m.w === 'rifle' || m.w === 'shotgun' || m.w === 'sniper') {
        const dist = Math.sqrt(dx * dx + dz * dz);
        dmg *= Math.max(0.55, Math.min(1, 1 - (dist - 60) / 500)); // 거리 감쇠
      }
      applyDamage(tgt, dmg, p, !!m.head, null);
    }
    else if (m.t === 'ping') {
      send(p, { t: 'pong', ts: m.ts });
    }
    else if (m.t === 'zone') {
      if (!p.alive || !roundActive || gameState !== 'playing') return;
      if (p.d) return; // 강하(낙하/낙하산) 중에는 자기장 피해 없음
      const d = Math.hypot(p.x - zone.cx, p.z - zone.cz);
      if (d > zone.r - 2 || zone.r < 6) applyDamage(p, zone.dps, null, false, '자기장');
    }
    // ---------- 차량 ----------
    else if (m.t === 'carreq') {
      const c = cars[+m.idx];
      if (!c || c.dead) return;
      // 이미 다른 차에 탑승 중이면 무시
      for (const cc of cars) if (cc.drv === id || cc.pass.includes(id)) return;
      if (!c.drv) {
        c.drv = id;
        broadcast({ t: 'carenter', idx: +m.idx, id, role: 'd' });
      } else if (c.pass.length < 3) {
        c.pass.push(id);
        broadcast({ t: 'carenter', idx: +m.idx, id, role: 'p' });
      }
    }
    else if (m.t === 'carexit') {
      const c = cars[+m.idx];
      if (!c) return;
      if (c.drv === id) {
        c.drv = 0;
        broadcast({ t: 'carexit', idx: +m.idx, id });
      } else {
        const k = c.pass.indexOf(id);
        if (k >= 0) { c.pass.splice(k, 1); broadcast({ t: 'carexit', idx: +m.idx, id }); }
      }
    }
    else if (m.t === 'carstate') {
      const c = cars[+m.idx];
      if (!c || c.drv !== id || c.dead) return;
      c.x = +m.x || 0; c.z = +m.z || 0; c.h = +m.h || 0;
      c.fuel = Math.max(0, Math.min(100, +m.fuel || 0));
      c.mv = 1;
    }
    else if (m.t === 'cardmg') {
      const c = cars[+m.idx];
      if (!c || c.dead) return;
      c.hp -= Math.max(0, Math.min(120, +m.dmg || 0));
      if (c.hp <= 0) {
        c.hp = 0; c.dead = true;
        broadcast({ t: 'carboom', idx: +m.idx });
        const occ = [];
        if (c.drv) occ.push(c.drv);
        for (const pid of c.pass) occ.push(pid);
        c.drv = 0; c.pass = [];
        for (const oid of occ) {
          const d = players.get(oid);
          if (d && d.alive) {
            d.hp = Math.max(6, Math.floor(d.hp * 0.5));
            broadcast({ t: 'hp', id: d.id, hp: Math.round(d.hp), armor: Math.round(d.armor) });
          }
        }
      }
    }
  });

  ws.on('close', () => {
    for (const c of cars) {
      if (c.drv === id) c.drv = 0;
      const k = c.pass.indexOf(id);
      if (k >= 0) c.pass.splice(k, 1);
    }
    players.delete(id);
    broadcast({ t: 'pleave', id });
    console.log('[-] 퇴장: #' + id + ' (현재 ' + players.size + '명)');
    if (gameState === 'lobby') sendLobby();
    else checkWin();
  });
});

function applyDamage(tgt, dmg, from, head, cause) {
  if (head && tgt.helmet) dmg *= 0.55;
  if (tgt.armor > 0) {
    const ab = Math.min(tgt.armor, dmg * 0.6);
    tgt.armor -= ab; dmg -= ab;
  }
  tgt.hp -= dmg;
  if (tgt.hp <= 0 && tgt.alive) {
    tgt.hp = 0; tgt.alive = false;
    for (const c of cars) {
      if (c.drv === tgt.id) c.drv = 0;
      const k = c.pass.indexOf(tgt.id);
      if (k >= 0) c.pass.splice(k, 1);
    }
    if (from) from.kills++;
    broadcast({ t: 'kill', killer: from ? from.name : (cause || '전장'), victim: tgt.name, killerId: from ? from.id : 0, victimId: tgt.id, head: !!head });
    // 사망 지점 보급상자
    const idx = dynIdx++;
    broadcast({ t: 'itemadd', idx, x: +tgt.x.toFixed(1), z: +tgt.z.toFixed(1), type: 'crate' });
    checkWin();
  } else {
    broadcast({ t: 'hp', id: tgt.id, hp: Math.max(0, Math.round(tgt.hp)), armor: Math.round(tgt.armor) });
  }
}

function endMatch(winnerName, winnerKills) {
  if (gameState !== 'playing') return;
  roundActive = false;
  gameState = 'ended';
  broadcast({ t: 'win', name: winnerName || '-', kills: winnerKills || 0 });
  console.log('[게임 종료] 승자: ' + (winnerName || '-') + ' → 곧 대기실로');
  // 잠시 후 대기실(로비)로 복귀. 남아있는 사람들은 다시 준비 후 시작 가능
  setTimeout(() => {
    gameState = 'lobby';
    roundActive = false;
    seed = Math.floor(Math.random() * 1e9); // 다음 판은 새 맵
    resetZone(); resetCars();
    taken = new Set();
    for (const q of players.values()) {
      q.hp = 100; q.armor = 0; q.helmet = false; q.bag = 0; q.w = '';
      q.alive = true; q.kills = 0; q.ready = false; q.d = 0; q.spectating = false;
    }
    broadcast({ t: 'tolobby', seed });
    sendLobby();
    console.log('[대기실] 복귀 완료');
  }, 6000);
}
function checkWin() {
  if (gameState !== 'playing') return;
  const arr = [...players.values()];
  const alive = arr.filter(q => q.alive);
  // 접속자가 아예 없을 때만 종료(서버 정리). 남아있으면 계속.
  if (arr.length === 0) { endMatch('-', 0); return; }
  // 혼자 플레이(연습): 게임을 끝내지 않는다. 죽어도 라운드 유지.
  if (matchStartCount <= 1) return;
  // 2명 이상으로 시작한 경우에만 '마지막 1인 승리' 판정
  if (alive.length <= 1) { endMatch(alive.length ? alive[0].name : '-', alive.length ? alive[0].kills : 0); return; }
}

// ---------- 서버 이벤트: 에어드랍 / 폭격 / 비 ----------
let dropT = FAST ? 2 : 75, redT = FAST ? 4 : 110, rainT = FAST ? 6 : 90, rainOn = false, rainLeft = 0;
setInterval(() => {
  if (gameState !== 'playing' || players.size === 0) return;
  dropT -= 1;
  if (dropT <= 0) {
    dropT = FAST ? 6 : (70 + Math.random() * 40);
    const a = Math.random() * Math.PI * 2, rr = Math.random() * zone.r * 0.7;
    const x = Math.max(-MAP_HALF + 30, Math.min(MAP_HALF - 30, zone.cx + Math.cos(a) * rr));
    const z = Math.max(-MAP_HALF + 30, Math.min(MAP_HALF - 30, zone.cz + Math.sin(a) * rr));
    const idx = dynIdx++;
    broadcast({ t: 'airdrop', idx, x: +x.toFixed(1), z: +z.toFixed(1) });
  }
  redT -= 1;
  if (redT <= 0) {
    redT = FAST ? 8 : (100 + Math.random() * 50);
    const a = Math.random() * Math.PI * 2, rr = Math.random() * zone.r * 0.8;
    broadcast({ t: 'redzone', x: +(zone.cx + Math.cos(a) * rr).toFixed(1), z: +(zone.cz + Math.sin(a) * rr).toFixed(1) });
  }
  if (!rainOn) {
    rainT -= 1;
    if (rainT <= 0) { rainOn = true; rainLeft = 40 + Math.random() * 40; broadcast({ t: 'rain', on: 1 }); }
  } else {
    rainLeft -= 1;
    if (rainLeft <= 0) { rainOn = false; rainT = 80 + Math.random() * 60; broadcast({ t: 'rain', on: 0 }); }
  }
}, 1000);

// ---------- 자기장 틱 ----------
setInterval(() => {
  if (gameState !== 'playing') return;
  const dt = 0.1;
  const ph = phases[Math.min(zone.phase, phases.length - 1)];
  if (!zone.shrinking) {
    zone.timer -= dt;
    if (zone.timer <= 0) { zone.shrinking = true; zone.timer = ph.shrink; zone.sr = zone.r; zone.scx = zone.cx; zone.scz = zone.cz; }
  } else {
    zone.timer -= dt;
    const k = 1 - Math.max(0, zone.timer / ph.shrink);
    zone.r = zone.sr + (zone.nr - zone.sr) * k;
    zone.cx = zone.scx + (zone.ncx - zone.scx) * k;
    zone.cz = zone.scz + (zone.ncz - zone.scz) * k;
    if (zone.timer <= 0) {
      zone.shrinking = false; zone.phase++;
      const np = phases[Math.min(zone.phase, phases.length - 1)];
      zone.dps = np.dps; zone.timer = np.wait;
      pickNext();
    }
  }
}, 100);

// ---------- 스냅샷 (20Hz) ----------
setInterval(() => {
  if (players.size === 0 || gameState !== 'playing') return;
  const list = [...players.values()].filter(p => !p.spectating).map(p =>
    [p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(3),
     p.stance === 'prone' ? 1 : 0, Math.round(p.hp), p.alive ? 1 : 0,
     p.helmet ? 1 : 0, p.bag, WIDX[p.w] || 0, Math.round(p.armor), p.d || 0, p.color]);
  // 대역폭 절감: 움직였거나 탑승/파손된 차량만 전송
  const carList = [];
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (c.mv || c.drv || c.pass.length > 0 || c.hp < 500) {
      carList.push([i, +c.x.toFixed(1), +c.z.toFixed(1), +c.h.toFixed(2), Math.round(c.hp), c.drv, c.mv, Math.round(c.fuel), c.pass.slice()]);
    }
  }
  broadcast({
    t: 'snap', p: list, c: carList,
    z: [+zone.cx.toFixed(1), +zone.cz.toFixed(1), +zone.r.toFixed(1), +zone.ncx.toFixed(1), +zone.ncz.toFixed(1), +zone.nr.toFixed(1), zone.shrinking ? 1 : 0, Math.max(0, Math.ceil(zone.timer)), zone.phase],
  });
}, 50);

server.listen(PORT, () => {
  console.log('====================================================');
  console.log('  BATTLE GROUNDS 멀티플레이 서버 v2 실행 중');
  console.log('  내 접속 주소   : http://localhost:' + PORT);
  console.log('  친구 접속 주소 : http://<내 IP 주소>:' + PORT);
  console.log('====================================================');
});
