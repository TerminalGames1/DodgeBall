const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

const W = canvas.width;
const H = canvas.height;

const LANES = 3;

const BASE_SPEED_PX = 280;
const SPEED_INCREMENT = 0.10;

const KILL_OVERLAP_RATIO = 0.40;
const CLOSE_LOW_RATIO = 0.15;

const STREAK_TIMEOUT = 1.8;

const PREFERS_REDUCED_MOTION =
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// -------- Audio --------
let audioCtx = null;
function ensureAudioUnlocked() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) {}
}

function playClick() {
  try {
    ensureAudioUnlocked();
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();

    o.type = "square";
    o.frequency.setValueAtTime(780, t);
    o.frequency.exponentialRampToValueAtTime(520, t + 0.035);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);

    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.07);
  } catch (_) {}
}

function playDeath() {
  try {
    ensureAudioUnlocked();
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();

    o.type = "sawtooth";
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(65, t + 0.22);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.30);
  } catch (_) {}
}

// -------- Haptics --------
function vibrate(pattern) {
  try {
    if (PREFERS_REDUCED_MOTION) return;
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (_) {}
}
function hapticLane() { vibrate(10); }
function hapticClose() { vibrate([12, 25, 12]); }
function hapticDeath() { vibrate([40, 30, 60]); }

// -------- Share --------
async function shareScore() {
  const url = location.href;
  const text = `I scored ${Game.score} on Ball Blazter. Best: ${Game.best}. Can you beat me?\n${url}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: "Ball Blazter", text, url });
      return true;
    } catch (_) {}
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      alert("Share text copied to clipboard!");
      return true;
    } catch (_) {}
  }

  prompt("Copy this to share:", text);
  return true;
}

// -------- Game State --------
const Player = {
  lane: 0,
  x: 0,
  y: H - 150,
  r: 18,
  targetX: 0
};

const Game = {
  started: false,
  menuT: 0,

  running: true,
  paused: false,

  score: 0,
  best: Number(localStorage.getItem("best") || 0),

  speedMul: 1.0,
  speedPx: BASE_SPEED_PX,

  closeCalls: 0,
  streak: 0,
  maxStreak: 0,
  streakTimer: 0,

  shakeT: 0,
  shakeMag: 0,
  flashT: 0,

  closePopupT: 0,
  ringT: 0
};

let obstacles = [];
let spawnAcc = 0;

function laneX(lane) {
  return (W / (LANES + 1)) * (lane + 1);
}

function updateSpeedFromScore() {
  const level = Math.floor(Game.score / 10);
  Game.speedMul = Math.pow(1 + SPEED_INCREMENT, level);
  Game.speedPx = BASE_SPEED_PX * Game.speedMul;
}

function spawnObstacle() {
  obstacles.push({
    lane: Math.floor(Math.random() * LANES),
    y: -30,
    r: 20,

    scored: false,

    wasSameLaneEver: false,
    maxOverlap: -9999,
    closeEvaluated: false
  });
}

function startGameNow() {
  if (Game.started) return;
  ensureAudioUnlocked();
  Game.started = true;
  Game.paused = false;
}

function restart() {
  Game.running = true;

  Game.started = false;
  Game.paused = true;
  Game.menuT = 0;

  Game.score = 0;
  Game.closeCalls = 0;
  Game.streak = 0;
  Game.maxStreak = 0;
  Game.streakTimer = 0;

  Game.shakeT = 0;
  Game.shakeMag = 0;
  Game.flashT = 0;

  Game.closePopupT = 0;
  Game.ringT = 0;

  obstacles = [];
  spawnAcc = 0;

  Player.lane = 0;
  Player.x = laneX(Player.lane);
  Player.targetX = Player.x;

  updateSpeedFromScore();
}

Player.x = laneX(Player.lane);
Player.targetX = Player.x;
updateSpeedFromScore();

// -------- Canvas UI geometry --------
function uiPlayRect() {
  const w = 190, h = 52;
  return { x: (W - w) / 2, y: H * 0.52, w, h };
}

function uiShareRect_GameOver() {
  const w = 160, h = 46;
  return { x: (W - w) / 2, y: H * 0.62, w, h };
}

/* ✅ NEW: bottom control bar (always stable on mobile) */
function uiBar() {
  const pad = 14;
  const h = 64;
  return { x: pad, y: H - pad - h, w: W - pad * 2, h };
}
function uiBarButtons() {
  const bar = uiBar();
  const gap = 12;
  const bw = (bar.w - gap * 2) / 3;
  const bh = bar.h;
  return {
    pause:   { x: bar.x,            y: bar.y, w: bw, h: bh },
    share:   { x: bar.x + bw + gap, y: bar.y, w: bw, h: bh },
    restart: { x: bar.x + (bw + gap) * 2, y: bar.y, w: bw, h: bh },
  };
}

function inRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawButton(rect, label, sub = "") {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  roundRect(rect.x, rect.y, rect.w, rect.h, 12);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = "800 15px system-ui";
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 - (sub ? 7 : 0));

  if (sub) {
    ctx.font = "600 11px system-ui";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText(sub, rect.x + rect.w / 2, rect.y + rect.h / 2 + 11);
  }

  ctx.restore();
}

function drawGlowText(text, x, y, font, fill, glow, blur) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = fill;

  ctx.shadowColor = glow;
  ctx.shadowBlur = blur;
  ctx.fillText(text, x, y);

  ctx.shadowBlur = 0;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function pointerToCanvas(e) {
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) * (W / r.width);
  const py = (e.clientY - r.top) * (H / r.height);
  return { x: px, y: py };
}

// -------- Keyboard input --------
document.addEventListener("keydown", (e) => {
  ensureAudioUnlocked();

  if (Game.running && !Game.started) {
    const k0 = e.key;
    if (!["Shift", "Control", "Alt", "Meta"].includes(k0)) {
      startGameNow();
      playClick();
      return;
    }
  }

  const k = e.key.toLowerCase();

  if (k === "p" && Game.running && Game.started) {
    Game.paused = !Game.paused;
    return;
  }

  if (!Game.running && k === "r") {
    restart();
    return;
  }

  if (!Game.running || Game.paused) return;

  if ((e.key === "ArrowLeft" || k === "a") && Player.lane > 0) {
    Player.lane--;
    Player.targetX = laneX(Player.lane);
    playClick(); hapticLane();
  }

  if ((e.key === "ArrowRight" || k === "d") && Player.lane < LANES - 1) {
    Player.lane++;
    Player.targetX = laneX(Player.lane);
    playClick(); hapticLane();
  }

  if (e.code === "Space") {
    e.preventDefault();
    Player.lane = (Player.lane + 1) % LANES;
    Player.targetX = laneX(Player.lane);
    playClick(); hapticLane();
  }
});

// -------- Pointer (tap) input --------
canvas.addEventListener("pointerdown", async (e) => {
  e.preventDefault();
  ensureAudioUnlocked();

  const { x, y } = pointerToCanvas(e);

  // Start menu: tap anywhere or play button
  if (Game.running && !Game.started) {
    startGameNow();
    playClick();
    return;
  }

  // Game over: share button or restart
  if (!Game.running) {
    const sr = uiShareRect_GameOver();
    if (inRect(x, y, sr)) {
      await shareScore();
      return;
    }
    restart();
    return;
  }

  // Bottom bar always active while running
  if (Game.running && Game.started) {
    const b = uiBarButtons();

    if (inRect(x, y, b.pause)) {
      Game.paused = !Game.paused;
      playClick();
      return;
    }
    if (inRect(x, y, b.share)) {
      await shareScore();
      playClick();
      return;
    }
    if (inRect(x, y, b.restart)) {
      restart();
      playClick();
      return;
    }
  }

  // Paused: tap anywhere to resume
  if (Game.running && Game.paused && Game.started) {
    Game.paused = false;
    playClick();
    return;
  }

  // Gameplay tap: cycle lane
  if (!Game.started || Game.paused) return;
  Player.lane = (Player.lane + 1) % LANES;
  Player.targetX = laneX(Player.lane);
  playClick(); hapticLane();
}, { passive: false });

// -------- Update + Draw --------
function update(dt) {
  if (!PREFERS_REDUCED_MOTION) Game.menuT += dt;

  const smoothing = 18;
  Player.x += (Player.targetX - Player.x) * (1 - Math.exp(-smoothing * dt));

  if (Game.shakeT > 0) Game.shakeT = Math.max(0, Game.shakeT - dt);
  if (Game.flashT > 0) Game.flashT = Math.max(0, Game.flashT - dt);
  if (Game.closePopupT > 0) Game.closePopupT = Math.max(0, Game.closePopupT - dt);
  if (Game.ringT > 0) Game.ringT = Math.max(0, Game.ringT - dt);

  if (!Game.paused && Game.streakTimer > 0) {
    Game.streakTimer = Math.max(0, Game.streakTimer - dt);
    if (Game.streakTimer === 0) Game.streak = 0;
  }

  if (!Game.running || Game.paused) return;

  const spawnInterval = Math.max(0.45, 0.90 - Game.score * 0.01);
  spawnAcc += dt;
  while (spawnAcc >= spawnInterval) {
    spawnObstacle();
    spawnAcc -= spawnInterval;
  }

  const killOverlapFor = (o) => KILL_OVERLAP_RATIO * o.r;
  const closeLowFor = (o) => CLOSE_LOW_RATIO * o.r;

  for (const o of obstacles) {
    o.y += Game.speedPx * dt;

    const ox = laneX(o.lane);
    const dist = Math.hypot(Player.x - ox, Player.y - o.y);
    const overlap = (Player.r + o.r) - dist;

    if (o.lane === Player.lane) o.wasSameLaneEver = true;
    if (overlap > o.maxOverlap) o.maxOverlap = overlap;

    const killOverlap = killOverlapFor(o);
    if (overlap > killOverlap) {
      Game.running = false;
      Game.paused = false;

      if (!PREFERS_REDUCED_MOTION) {
        Game.shakeT = 0.28;
        Game.shakeMag = 8;
        Game.flashT = 0.18;
      } else {
        Game.shakeT = 0;
        Game.shakeMag = 0;
        Game.flashT = 0.10;
      }

      playDeath();
      hapticDeath();

      Game.best = Math.max(Game.best, Game.score);
      localStorage.setItem("best", String(Game.best));
      break;
    }

    if (!o.scored && o.y > H + 40) {
      o.scored = true;
      Game.score++;
      updateSpeedFromScore();
    }

    if (!o.closeEvaluated && o.y > Player.y + 30) {
      o.closeEvaluated = true;
      const closeLow = closeLowFor(o);

      if (o.wasSameLaneEver && o.maxOverlap >= closeLow && o.maxOverlap < killOverlap) {
        Game.closeCalls++;
        Game.streak++;
        Game.maxStreak = Math.max(Game.maxStreak, Game.streak);
        Game.streakTimer = STREAK_TIMEOUT;

        Game.closePopupT = 0.38;
        Game.ringT = 0.38;

        if (!PREFERS_REDUCED_MOTION) {
          Game.shakeT = 0.10;
          Game.shakeMag = 2.5;
          Game.flashT = 0.08;
        }

        hapticClose();
      }
    }
  }

  obstacles = obstacles.filter(o => o.y < H + 120);
}

function draw() {
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
  for (let i = 1; i < LANES; i++) {
    const x = (W / LANES) * i;
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

  // close call ring
  if (Game.ringT > 0) {
    const a = Math.min(1, Game.ringT / 0.38);
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

  // HUD
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.font = "16px system-ui";
  ctx.fillText(`Score: ${Game.score}`, 16, 28);
  ctx.fillText(`Close Calls: ${Game.closeCalls} (Streak: ${Game.streak})`, 16, 52);

  ctx.font = "13px system-ui";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(`Speed x${Game.speedMul.toFixed(2)}  (+10% every 10 pts)`, 16, 74);

  // Close call popup
  if (Game.closePopupT > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, Game.closePopupT / 0.38);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("CLOSE CALL!", W / 2, 120);
    ctx.restore();
  }

  // flash
  if (Game.flashT > 0) {
    const a = Math.min(1, Game.flashT / 0.18);
    ctx.save();
    ctx.globalAlpha = 0.18 * a;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // START MENU
  if (Game.running && !Game.started) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, 0, W, H);

    const t = PREFERS_REDUCED_MOTION ? 0 : Game.menuT;
    const floatY = PREFERS_REDUCED_MOTION ? 0 : Math.sin(t * 1.4) * 6;
    const titleY = H * 0.40 + floatY;
    const glow = PREFERS_REDUCED_MOTION ? 14 : 18 + (Math.sin(t * 1.2) * 6);

    drawGlowText(
      "Ball Blazter",
      W / 2,
      titleY,
      "bold 46px system-ui",
      "#ffffff",
      "rgba(255,255,255,0.60)",
      glow
    );

    const pulse = PREFERS_REDUCED_MOTION ? 1 : (1 + (Math.sin(t * 3.2) * 0.05));
    const pr = uiPlayRect();

    ctx.save();
    ctx.translate(pr.x + pr.w / 2, pr.y + pr.h / 2);
    ctx.scale(pulse, pulse);
    ctx.translate(-(pr.x + pr.w / 2), -(pr.y + pr.h / 2));

    ctx.fillStyle = "rgba(255,255,255,0.14)";
    roundRect(pr.x, pr.y, pr.w, pr.h, 14);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "800 18px system-ui";
    ctx.fillText("▶ PLAY", pr.x + pr.w / 2, pr.y + pr.h / 2);

    ctx.restore();

    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textAlign = "center";
    ctx.font = "14px system-ui";
    ctx.fillText("Tap or press any key to start", W / 2, H * 0.63);
    ctx.fillText("Tap to switch lane • Space to switch • P pause • R restart", W / 2, H * 0.67);

    ctx.textAlign = "left";
  }

  // Pause overlay
  if (Game.running && Game.paused && Game.started) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.font = "bold 34px system-ui";
    ctx.fillText("Paused", W / 2, H * 0.40);

    ctx.font = "16px system-ui";
    ctx.fillText(`Score: ${Game.score}`, W / 2, H * 0.48);
    ctx.fillText(`Best: ${Game.best}`, W / 2, H * 0.53);
    ctx.fillText(`Close Calls: ${Game.closeCalls}`, W / 2, H * 0.58);
    ctx.fillText(`Max Streak: ${Game.maxStreak}`, W / 2, H * 0.63);

    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText("Tap anywhere to resume", W / 2, H * 0.72);
    ctx.textAlign = "left";
  }

  // Game over overlay
  if (!Game.running) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.font = "bold 34px system-ui";
    ctx.fillText("Game Over", W / 2, H * 0.40);

    ctx.font = "16px system-ui";
    ctx.fillText(`Score: ${Game.score}`, W / 2, H * 0.48);
    ctx.fillText(`Best: ${Game.best}`, W / 2, H * 0.53);
    ctx.fillText(`Close Calls: ${Game.closeCalls}`, W / 2, H * 0.58);
    ctx.fillText(`Max Streak: ${Game.maxStreak}`, W / 2, H * 0.63);

    const sr = uiShareRect_GameOver();
    drawButton(sr, "Share Score");

    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText("Tap anywhere else to restart", W / 2, H * 0.69);
    ctx.textAlign = "left";
  }

  // ✅ Bottom bar (only when started and not on start menu)
  if (Game.running && Game.started) {
    const b = uiBarButtons();
    drawButton(b.pause, Game.paused ? "Resume" : "Pause", "P");
    drawButton(b.share, "Share", "");
    drawButton(b.restart, "Restart", "R");
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
requestAnimationFrame(loop);

restart();