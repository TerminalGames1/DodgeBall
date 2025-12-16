const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

const W = canvas.width;
const H = canvas.height;

const LANES = 3;

// Speed model (stable across devices)
const BASE_SPEED_PX = 280;      // pixels/second baseline
const SPEED_INCREMENT = 0.10;   // +10% every 10 points

// ✅ NEW close-call model
// Touch is allowed; die once overlap reaches >= 50% of obstacle radius.
const KILL_OVERLAP_RATIO = 0.50;  // 50% of obstacle radius
const TOUCH_OVERLAP_MIN = 0.01;   // any visible contact counts as "touched" (raise to ~1.0 if too sensitive)

// Streak expires if no close call within this time
const STREAK_TIMEOUT = 1.8;        // seconds

// Audio
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

    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.07);
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

    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.30);
  } catch (_) {}
}

// Share score (mobile share sheet + fallback)
async function shareScore() {
  const url = location.href;
  const text = `I scored ${Game.score} on Obstacle Dodge. Best: ${Game.best}. Can you beat me?\n${url}`;

  if (navigator.share) {
    try {
      await navigator.share({
        title: "Obstacle Dodge",
        text,
        url
      });
      return;
    } catch (_) {
      // user cancelled or share failed
    }
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      alert("Share text copied to clipboard!");
      return;
    } catch (_) {}
  }

  prompt("Copy this to share:", text);
}

const Player = {
  lane: 0,
  x: 0,
  y: H - 120,
  r: 18,
  targetX: 0
};

const Game = {
  running: true,
  paused: false,  // ✅ NEW
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

    // ✅ NEW close-call tracking (replaces wasSameLaneEver/maxOverlap/closeEvaluated)
    touched: false,   // has player ever touched (overlapped) this obstacle?
    resolved: false   // has this obstacle already awarded a close call (or ended game)?
  });
}

function restart() {
  Game.running = true;
  Game.paused = false;     // ✅ NEW
  Game.score = 0;
  Game.closeCalls = 0;
  Game.streak = 0;
  Game.maxStreak = 0;
  Game.streakTimer = 0;

  Game.shakeT = 0;
  Game.shakeMag = 0;

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

/* ---------- BUTTONS ---------- */
document.getElementById("restart").addEventListener("click", () => {
  ensureAudioUnlocked();
  restart();
});

document.getElementById("pause").addEventListener("click", () => {
  ensureAudioUnlocked();
  if (!Game.running) return;           // don’t pause a game-over screen
  Game.paused = !Game.paused;
});

document.getElementById("share").addEventListener("click", async () => {
  ensureAudioUnlocked();
  await shareScore();
});

/* ---------- INPUT ---------- */
document.addEventListener("keydown", (e) => {
  ensureAudioUnlocked();
  const k = e.key.toLowerCase();

  // pause toggle
  if (k === "p" && Game.running) {
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
    playClick();
  }

  if ((e.key === "ArrowRight" || k === "d") && Player.lane < LANES - 1) {
    Player.lane++;
    Player.targetX = laneX(Player.lane);
    playClick();
  }
});

// Tap anywhere: alive => move RIGHT (cycle). dead => restart.
// If paused: ignore tap (use Pause button or P to resume)
canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  ensureAudioUnlocked();

  if (!Game.running) {
    restart();
    return;
  }

  if (Game.paused) return;

  Player.lane = (Player.lane + 1) % LANES;
  Player.targetX = laneX(Player.lane);
  playClick();
}, { passive: false });

function update(dt) {
  // Smooth lane movement
  const smoothing = 18;
  Player.x += (Player.targetX - Player.x) * (1 - Math.exp(-smoothing * dt));

  // timers always tick
  if (Game.shakeT > 0) Game.shakeT = Math.max(0, Game.shakeT - dt);
  if (Game.closePopupT > 0) Game.closePopupT = Math.max(0, Game.closePopupT - dt);
  if (Game.ringT > 0) Game.ringT = Math.max(0, Game.ringT - dt);

  // streak timer ticks even during pause (optional — feels more natural to freeze it)
  // We'll freeze it during pause so it doesn't expire while paused.
  if (!Game.paused && Game.streakTimer > 0) {
    Game.streakTimer = Math.max(0, Game.streakTimer - dt);
    if (Game.streakTimer === 0) Game.streak = 0;
  }

  if (!Game.running || Game.paused) return;

  // Spawn
  const spawnInterval = Math.max(0.45, 0.90 - Game.score * 0.01);
  spawnAcc += dt;
  while (spawnAcc >= spawnInterval) {
    spawnObstacle();
    spawnAcc -= spawnInterval;
  }

  const killOverlapFor = (o) => KILL_OVERLAP_RATIO * o.r;

  for (const o of obstacles) {
    o.y += Game.speedPx * dt;

    const ox = laneX(o.lane);
    const dist = Math.hypot(Player.x - ox, Player.y - o.y);
    const overlap = (Player.r + o.r) - dist;

    const killOverlap = killOverlapFor(o);
    const touching = overlap > TOUCH_OVERLAP_MIN;
    const killing = overlap >= killOverlap;

    // ✅ Mark that we touched at least once (touch is allowed)
    if (touching && !o.resolved) {
      o.touched = true;
    }

    // ✅ Death only when deep overlap reaches threshold (>= 50% obstacle radius)
    if (killing) {
      Game.running = false;
      Game.paused = false;
      Game.shakeT = 0.25;
      Game.shakeMag = 7;
      playDeath();

      Game.best = Math.max(Game.best, Game.score);
      localStorage.setItem("best", String(Game.best));

      o.resolved = true;
      break;
    }

    // ✅ Close call: you touched, then you escaped (stopped touching) before dying
    if (!touching && o.touched && !o.resolved) {
      o.resolved = true;
      o.touched = false;

      Game.closeCalls++;
      Game.streak++;
      Game.maxStreak = Math.max(Game.maxStreak, Game.streak);

      Game.streakTimer = STREAK_TIMEOUT;

      Game.closePopupT = 0.35;
      Game.ringT = 0.35;

      Game.shakeT = 0.10;
      Game.shakeMag = 2;
    }

    // Score
    if (!o.scored && o.y > H + 40) {
      o.scored = true;
      Game.score++;
      updateSpeedFromScore();
    }
  }

  obstacles = obstacles.filter(o => o.y < H + 120);
}

function draw() {
  let sx = 0, sy = 0;
  if (Game.shakeT > 0) {
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
    const a = Math.min(1, Game.ringT / 0.35);
    const pulse = 1 + (1 - a) * 0.8;
    ctx.save();
    ctx.globalAlpha = 0.65 * a;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(Player.x, Player.y, Player.r * 1.7 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // HUD (Best NOT shown at top-right)
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
    ctx.globalAlpha = Math.min(1, Game.closePopupT / 0.35);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("CLOSE CALL!", W / 2, 120);
    ctx.restore();
  }

  // Pause overlay menu
  if (Game.running && Game.paused) {
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
    ctx.fillText("Press P or hit Pause to resume", W / 2, H * 0.72);
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
    ctx.fillText("Tap or Press R to Restart", W / 2, H * 0.72);
    ctx.textAlign = "left";
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