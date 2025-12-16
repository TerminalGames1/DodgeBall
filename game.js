const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

const W = canvas.width, H = canvas.height;

const CFG = {
LANES: 3,

BASE_SPEED_PX: 280,
SPEED_INCREMENT: 0.10, // +10% every 10 points

KILL_OVERLAP_RATIO: 0.40, // die if overlap > 40% of obstacle radius
CLOSE_LOW_RATIO: 0.15, // close call if overlap >= 15% (but < 40%)

STREAK_TIMEOUT: 1.8, // seconds

PLAYER_R: 18,
OB_R: 20,

// FX timing
RING_T: 0.38,
POPUP_T: 0.38,
FLASH_T_DEATH: 0.18,
FLASH_T_CLOSE: 0.08,

SHAKE_DEATH_T: 0.28,
SHAKE_DEATH_MAG: 8,
SHAKE_CLOSE_T: 0.10,
SHAKE_CLOSE_MAG: 2.5,
};

const PREFERS_REDUCED_MOTION =
window.matchMedia &&
window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpExp = (cur, tgt, s, dt) => cur + (tgt - cur) * (1 - Math.exp(-s * dt));
const laneX = (lane) => (W / (CFG.LANES + 1)) * (lane + 1);

// ---------- Audio (unlocked on first user gesture) ----------
let audioCtx = null;
function ensureAudioUnlocked() {
try {
if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
if (audioCtx.state === "suspended") audioCtx.resume();
} catch (_) {}
}
function beep({ type, f0, f1, tLen, a0, a1, aOut }) {
try {
ensureAudioUnlocked();
if (!audioCtx) return;

const t = audioCtx.currentTime;
const o = audioCtx.createOscillator();
const g = audioCtx.createGain();

o.type = type;
o.frequency.setValueAtTime(f0, t);
if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + tLen);

g.gain.setValueAtTime(0.0001, t);
g.gain.exponentialRampToValueAtTime(a0, t + a1);
g.gain.exponentialRampToValueAtTime(0.0001, t + aOut);

o.connect(g); g.connect(audioCtx.destination);
o.start(t); o.stop(t + aOut + 0.02);
} catch (_) {}
}
const playClick = () => beep({ type:"square", f0:780, f1:520, tLen:0.035, a0:0.14, a1:0.006, aOut:0.06 });
const playDeath = () => beep({ type:"sawtooth", f0:240, f1:65, tLen:0.22, a0:0.35, a1:0.015, aOut:0.28 });

// ---------- Haptics ----------
function vibrate(pattern) {
try {
if (PREFERS_REDUCED_MOTION) return;
if (navigator.vibrate) navigator.vibrate(pattern);
} catch (_) {}
}
const hapticLane = () => vibrate(10);
const hapticClose = () => vibrate([12, 25, 12]);
const hapticDeath = () => vibrate([40, 30, 60]);

// ---------- Share ----------
async function shareScore(score, best) {
const url = location.href;
const text = `I scored ${score} on Obstacle Dodge. Best: ${best}. Can you beat me?\n${url}`;

if (navigator.share) {
try {
await navigator.share({ title: "Obstacle Dodge", text, url });
return true;
} catch (_) {}
}
if (navigator.clipboard?.writeText) {
try {
await navigator.clipboard.writeText(text);
alert("Share text copied to clipboard!");
return true;
} catch (_) {}
}
prompt("Copy this to share:", text);
return true;
}

// ---------- State ----------
const Player = {
lane: 0,
x: laneX(0),
targetX: laneX(0),
y: H - 120,
r: CFG.PLAYER_R,
};

const Game = {
running: true,
paused: false,

score: 0,
best: Number(localStorage.getItem("best") || 0),

speedMul: 1.0,
speedPx: CFG.BASE_SPEED_PX,

closeCalls: 0,
streak: 0,
maxStreak: 0,
streakTimer: 0,

// FX
shakeT: 0,
shakeMag: 0,
flashT: 0,
closePopupT: 0,
ringT: 0,
};

let obstacles = [];
let spawnAcc = 0;

function updateSpeedFromScore() {
const level = Math.floor(Game.score / 10);
Game.speedMul = Math.pow(1 + CFG.SPEED_INCREMENT, level);
Game.speedPx = CFG.BASE_SPEED_PX * Game.speedMul;
}

function spawnObstacle() {
obstacles.push({
lane: Math.floor(Math.random() * CFG.LANES),
y: -30,
r: CFG.OB_R,

scored: false,

// close-call tracking
wasSameLaneEver: false,
maxOverlap: -9999,
closeEvaluated: false,
});
}

function hardResetFX() {
Game.shakeT = 0; Game.shakeMag = 0; Game.flashT = 0;
Game.closePopupT = 0; Game.ringT = 0;
}

function restart() {
Game.running = true;
Game.paused = false;

Game.score = 0;
Game.closeCalls = 0;
Game.streak = 0;
Game.maxStreak = 0;
Game.streakTimer = 0;

hardResetFX();

obstacles = [];
spawnAcc = 0;

Player.lane = 0;
Player.x = laneX(0);
Player.targetX = laneX(0);

updateSpeedFromScore();
}

// ---------- UI (canvas buttons) ----------
const ui = {
pauseRect() { return { x: W - 16 - 86, y: 12, w: 86, h: 34 }; },
shareRectGameOver() { return { x: (W - 150) / 2, y: H * 0.72 + 22, w: 150, h: 44 }; },
};

function pointerToCanvas(e) {
const r = canvas.getBoundingClientRect();
return {
x: (e.clientX - r.left) * (W / r.width),
y: (e.clientY - r.top) * (H / r.height),
};
}

const inRect = (px, py, r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

function roundRect(x, y, w, h, rr) {
const r = Math.min(rr, w / 2, h / 2);
ctx.beginPath();
ctx.moveTo(x + r, y);
ctx.arcTo(x + w, y, x + w, y + h, r);
ctx.arcTo(x + w, y + h, x, y + h, r);
ctx.arcTo(x, y + h, x, y, r);
ctx.arcTo(x, y, x + w, y, r);
ctx.closePath();
}

function drawButton(rect, label) {
ctx.save();
ctx.fillStyle = "rgba(255,255,255,0.12)";
roundRect(rect.x, rect.y, rect.w, rect.h, 10);
ctx.fill();
ctx.strokeStyle = "rgba(255,255,255,0.18)";
ctx.lineWidth = 1;
ctx.stroke();
ctx.fillStyle = "#fff";
ctx.font = "700 14px system-ui";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2);
ctx.restore();
}

// ---------- HTML buttons ----------
const btnRestart = document.getElementById("restart");
const btnPause = document.getElementById("pause");
const btnShare = document.getElementById("share");

btnRestart.addEventListener("click", () => { ensureAudioUnlocked(); restart(); canvas.focus(); });
btnPause.addEventListener("click", () => {
ensureAudioUnlocked();
if (!Game.running) return;
Game.paused = !Game.paused;
canvas.focus();
});
btnShare.addEventListener("click", async () => {
ensureAudioUnlocked();
await shareScore(Game.score, Game.best);
canvas.focus();
});

// ---------- Input ----------
function moveLane(delta) {
if (!Game.running || Game.paused) return;
const next = clamp(Player.lane + delta, 0, CFG.LANES - 1);
if (next === Player.lane) return;
Player.lane = next;
Player.targetX = laneX(Player.lane);
playClick(); hapticLane();
}
function cycleLane() {
if (!Game.running || Game.paused) return;
Player.lane = (Player.lane + 1) % CFG.LANES;
Player.targetX = laneX(Player.lane);
playClick(); hapticLane();
}

document.addEventListener("keydown", (e) => {
ensureAudioUnlocked();
const k = e.key.toLowerCase();

if (k === "p" && Game.running) { Game.paused = !Game.paused; return; }
if (!Game.running && k === "r") { restart(); return; }

if (!Game.running || Game.paused) return;

if (e.key === "ArrowLeft" || k === "a") moveLane(-1);
if (e.key === "ArrowRight" || k === "d") moveLane(+1);

if (e.code === "Space") { e.preventDefault(); cycleLane(); }
});

canvas.addEventListener("pointerdown", async (e) => {
e.preventDefault();
ensureAudioUnlocked();

const { x, y } = pointerToCanvas(e);

// pause button (in-canvas)
if (Game.running && inRect(x, y, ui.pauseRect())) {
Game.paused = !Game.paused;
return;
}

// paused => tap anywhere to resume
if (Game.running && Game.paused) { Game.paused = false; return; }

// game over => share button or restart
if (!Game.running) {
const sr = ui.shareRectGameOver();
if (inRect(x, y, sr)) { await shareScore(Game.score, Game.best); return; }
restart();
return;
}

// normal tap => cycle lanes
cycleLane();
}, { passive: false });

// ---------- Game loop ----------
function fxTick(dt) {
Game.shakeT = Math.max(0, Game.shakeT - dt);
Game.flashT = Math.max(0, Game.flashT - dt);
Game.closePopupT = Math.max(0, Game.closePopupT - dt);
Game.ringT = Math.max(0, Game.ringT - dt);

if (!Game.paused && Game.streakTimer > 0) {
Game.streakTimer = Math.max(0, Game.streakTimer - dt);
if (Game.streakTimer === 0) Game.streak = 0;
}
}

function die() {
Game.running = false;
Game.paused = false;

if (!PREFERS_REDUCED_MOTION) {
Game.shakeT = CFG.SHAKE_DEATH_T;
Game.shakeMag = CFG.SHAKE_DEATH_MAG;
Game.flashT = CFG.FLASH_T_DEATH;
} else {
Game.shakeT = 0; Game.shakeMag = 0;
Game.flashT = 0.10;
}

playDeath();
hapticDeath();

Game.best = Math.max(Game.best, Game.score);
localStorage.setItem("best", String(Game.best));
}

function closeCall() {
Game.closeCalls++;
Game.streak++;
Game.maxStreak = Math.max(Game.maxStreak, Game.streak);
Game.streakTimer = CFG.STREAK_TIMEOUT;

Game.closePopupT = CFG.POPUP_T;
Game.ringT = CFG.RING_T;

if (!PREFERS_REDUCED_MOTION) {
Game.shakeT = CFG.SHAKE_CLOSE_T;
Game.shakeMag = CFG.SHAKE_CLOSE_MAG;
Game.flashT = CFG.FLASH_T_CLOSE;
}
hapticClose();
}

function update(dt) {
// smooth lane movement always
Player.x = lerpExp(Player.x, Player.targetX, 18, dt);

fxTick(dt);
if (!Game.running || Game.paused) return;

// spawn
const spawnInterval = Math.max(0.45, 0.90 - Game.score * 0.01);
spawnAcc += dt;
while (spawnAcc >= spawnInterval) { spawnObstacle(); spawnAcc -= spawnInterval; }

const killOverlapFor = (o) => CFG.KILL_OVERLAP_RATIO * o.r;
const closeLowFor = (o) => CFG.CLOSE_LOW_RATIO * o.r;

for (const o of obstacles) {
o.y += Game.speedPx * dt;

const ox = laneX(o.lane);
const dist = Math.hypot(Player.x - ox, Player.y - o.y);
const overlap = (Player.r + o.r) - dist;

if (o.lane === Player.lane) o.wasSameLaneEver = true;
if (overlap > o.maxOverlap) o.maxOverlap = overlap;

const kill = killOverlapFor(o);
if (overlap > kill) { die(); break; }

if (!o.scored && o.y > H + 40) {
o.scored = true;
Game.score++;
updateSpeedFromScore();
}

if (!o.closeEvaluated && o.y > Player.y + 30) {
o.closeEvaluated = true;
const low = closeLowFor(o);
if (o.wasSameLaneEver && o.maxOverlap >= low && o.maxOverlap < kill) closeCall();
}
}

obstacles = obstacles.filter(o => o.y < H + 120);
}

function drawHUD() {
ctx.fillStyle = "#fff";
ctx.textAlign = "left";
ctx.font = "16px system-ui";
ctx.fillText(`Score: ${Game.score}`, 16, 28);
ctx.fillText(`Close Calls: ${Game.closeCalls} (Streak: ${Game.streak})`, 16, 52);
ctx.font = "13px system-ui";
ctx.fillStyle = "rgba(255,255,255,0.8)";
ctx.fillText(`Speed x${Game.speedMul.toFixed(2)} (+10% every 10 pts)`, 16, 74);
}

function drawOverlay(title, lines, footer) {
ctx.fillStyle = "rgba(0,0,0,0.55)";
ctx.fillRect(0, 0, W, H);

ctx.fillStyle = "#fff";
ctx.textAlign = "center";
ctx.font = "bold 34px system-ui";
ctx.fillText(title, W / 2, H * 0.40);

ctx.font = "16px system-ui";
let y = H * 0.48;
for (const line of lines) { ctx.fillText(line, W / 2, y); y += H * 0.05; }

if (footer) {
ctx.fillStyle = "rgba(255,255,255,0.85)";
ctx.fillText(footer, W / 2, H * 0.72);
}
ctx.textAlign = "left";
}

function draw() {
// shake
let sx = 0, sy = 0;
if (Game.shakeT > 0 && !PREFERS_REDUCED_MOTION) {
sx = (Math.random() - 0.5) * Game.shakeMag;
sy = (Math.random() - 0.5) * Game.shakeMag;
}

ctx.save();
ctx.translate(sx, sy);

ctx.clearRect(0, 0, W, H);
ctx.fillStyle = "#0b1220";
ctx.fillRect(0, 0, W, H);

// lanes
ctx.strokeStyle = "rgba(255,255,255,0.08)";
ctx.lineWidth = 2;
for (let i = 1; i < CFG.LANES; i++) {
const x = (W / CFG.LANES) * i;
ctx.beginPath();
ctx.moveTo(x, 0);
ctx.lineTo(x, H);
ctx.stroke();
}

// obstacles
ctx.fillStyle = "#c0392b";
for (const o of obstacles) {
ctx.beginPath();
ctx.arc(laneX(o.lane), o.y, o.r, 0, Math.PI * 2);
ctx.fill();
}

// player
ctx.fillStyle = "#f1c40f";
ctx.beginPath();
ctx.arc(Player.x, Player.y, Player.r, 0, Math.PI * 2);
ctx.fill();

// ring (close call)
if (Game.ringT > 0) {
const a = clamp(Game.ringT / CFG.RING_T, 0, 1);
const pulse = 1 + (1 - a) * 0.85;
ctx.save();
ctx.globalAlpha = 0.65 * a;
ctx.strokeStyle = "#ffffff";
ctx.lineWidth = 4;
ctx.beginPath();
ctx.arc(Player.x, Player.y, Player.r * 1.7 * pulse, 0, Math.PI * 2);
ctx.stroke();
ctx.restore();
}

drawHUD();

// canvas pause button
if (Game.running) drawButton(ui.pauseRect(), Game.paused ? "Resume" : "Pause");

// popup
if (Game.closePopupT > 0) {
ctx.save();
ctx.globalAlpha = clamp(Game.closePopupT / CFG.POPUP_T, 0, 1);
ctx.fillStyle = "#fff";
ctx.font = "bold 22px system-ui";
ctx.textAlign = "center";
ctx.fillText("CLOSE CALL!", W / 2, 120);
ctx.restore();
ctx.textAlign = "left";
}

// flash
if (Game.flashT > 0) {
const a = clamp(Game.flashT / CFG.FLASH_T_DEATH, 0, 1);
ctx.save();
ctx.globalAlpha = 0.18 * a;
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, W, H);
ctx.restore();
}

// pause overlay
if (Game.running && Game.paused) {
drawOverlay(
"Paused",
[
`Score: ${Game.score}`,
`Best: ${Game.best}`,
`Close Calls: ${Game.closeCalls}`,
`Max Streak: ${Game.maxStreak}`,
],
"Tap anywhere to resume"
);
}

// game over overlay
if (!Game.running) {
drawOverlay(
"Game Over",
[
`Score: ${Game.score}`,
`Best: ${Game.best}`,
`Close Calls: ${Game.closeCalls}`,
`Max Streak: ${Game.maxStreak}`,
],
"Tap anywhere else to restart"
);

drawButton(ui.shareRectGameOver(), "Share Score");
}

ctx.restore();
}

let last = performance.now();
function loop(now) {
const dt = Math.min(0.05, (now - last) / 1000);
last = now;
update(dt);
draw();
requestAnimationFrame(loop);
}

restart();
requestAnimationFrame(loop);
