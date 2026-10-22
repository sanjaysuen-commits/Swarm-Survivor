'use strict';

// ===== Tunables (one place to retune the whole game) =====
const BEST_KEY = 'swarm-best';     // localStorage: longest survived time (seconds)
const MUTE_KEY = 'swarm-muted';    // localStorage: sound on/off

const ARENA = { w: 720, h: 480 };  // play field in CSS pixels

// Base hero stats. `damage` is seeded from the equipped weapon in freshGame.
const PLAYER_BASE = { maxHp: 100, fireRate: 2, moveSpeed: 180, projectiles: 1, bigShotTimer: 0, radius: 16 };
const MAX_LIVES = 3;               // hearts you start with (lose one per "death")

const GEM_XP = 1;                  // XP per chip a kill drops
const GEM_MAGNET_SPEED = 320;      // how fast XP chips fly to the hero
const ENEMY_TOUCH_DAMAGE = 8;      // HP lost when an enemy reaches you
const ENEMY_HIT_COOLDOWN = 0.6;    // seconds of i-frames after a touch

const PROJECTILE_SPEED = 380;      // px/sec
const PROJECTILE_RADIUS = 6;
const PROJECTILE_LIFE = 1.6;       // seconds before a shot fizzles

const SHAKE_ON_HIT = 0.25;         // seconds of screen shake on a player hit
const POP_TIME = 0.18;             // hero squash/stretch duration

const SPAWN_BASE = 1.3;            // seconds between spawns at t=0
const SPAWN_MIN = 0.35;            // fastest the swarm can spawn
const SPAWN_RAMP = 0.012;          // spawn interval shed per second survived

const BOSS_INTERVAL = 90;          // seconds between bosses (1.5 minutes)
const BOSS_WARNING = 5;            // seconds the red "BOSS HAS ARRIVED" sign shows
const BOSS_SCALE = 3;              // boss is 3× bigger than a normal enemy

const MONSTER_REGEN_SECONDS = 10;  // monsters gain HP this often
const MONSTER_REGEN_HP = 1;        // +1 HP each time a monster ages a full 10s

const AUTO_PERIOD = 30;            // every 30 seconds…
const AUTO_DURATION = 10;          // …the blaster auto-fires for 10 seconds

const SLOW_DURATION = 30;          // "Time Slow" upgrade: enemies crawl this long
const SLOW_FACTOR = 0.5;           // ...at half their normal speed

const BIG_SHOT_SIZE = 5;           // "Big Shot" upgrade: shots are 5× bigger
const BIG_SHOT_DURATION = 15;      // ...for 15 seconds

// ===== Registries (the kid's edit points — one row per entry, auto-wired) =====
// Each is generic/neutral so a kid's CLAUDE.md re-skins it. Adding a row is the
// whole "add an enemy / weapon / upgrade" move — the loop picks it up for free.

// Enemies. behavior ∈ chase | zigzag | splitter (the engine supports all three;
// the starter ships `glitch`, a basic chaser). Row shape: { id, emoji, hp, speed, behavior }.
const ENEMIES = {
  glitch: { id: 'glitch', emoji: '👾', hp: 50, speed: 60, behavior: 'chase' },
};

// The boss — one big tanky monster that shows up every 1.5 minutes. It isn't a
// normal ENEMIES row; the boss director summons it with 3,000 HP, 3× bigger.
const BOSS = { id: 'boss', emoji: '👹', hp: 3000, speed: 40, score: 50, xp: 10 };

// Weapons (auto-fire). pattern ∈ straight | spread | boomerang (engine supports all
// three; starter ships `blaster`, straight). cadence multiplies the hero fireRate.
const WEAPONS = {
  blaster: { id: 'blaster', pattern: 'straight', damage: 100, cadence: 1 },
};

// Upgrades (level-up cards). name + flavor are the VOICE surface — neutral in the
// starter, re-skinned by the kid's CLAUDE.md. apply(state) mutates the run's stats.
const UPGRADES = {
  power: { id: 'power', name: 'Power Up',    flavor: 'Your shots hit harder.', apply: (s) => { s.player.damage += 5; } },
  large: { id: 'large', name: 'Big Shot', flavor: 'Your shots are 5× bigger and pierce for 15 seconds.', apply: (s) => { s.player.bigShotTimer = BIG_SHOT_DURATION; } },
  slow: { id: 'slow', name: 'Time Slow', flavor: 'Enemies crawl slowly for 30 seconds.', apply: (s) => { s.slowTimer = SLOW_DURATION; } },
};

// Particle bursts per content id, with a graceful fallback. Add a row when you add
// content; if you forget, `_default` keeps the kill/hit from looking unfinished.
const BURSTS = {
  _default: ['✨', '💥'],
  glitch: ['💥', '✨', '⚡'],
  boss: ['💥', '💥', '💫', '🔥'],
};

// ===== Pure helpers: clamp + collision/distance math =====
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// Squared distance — cheaper than hypot when you only need to compare.
function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// Do two circles overlap or touch? (radii sum compared in squared space)
function circleHit(ax, ay, ar, bx, by, br) {
  const r = ar + br;
  return dist2(ax, ay, bx, by) <= r * r;
}

// The enemy closest to (x, y), or null if the swarm is empty. Drives auto-fire aim.
function nearestEnemy(x, y, enemies) {
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    const d = dist2(x, y, e.x, e.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// ===== Progression: XP → level =====
// XP needed to advance FROM `level` to the next. Gentle, predictable ramp.
function xpForLevel(level) {
  return 5 + (level - 1) * 3;
}

// Add XP to `state` (which carries level/xp/xpToNext), rolling over as many
// level-ups as the amount earns. Mutates state; returns the count of levels gained.
function applyXp(state, amount) {
  state.xp += amount;
  let gained = 0;
  while (state.xp >= state.xpToNext) {
    state.xp -= state.xpToNext;
    state.level += 1;
    state.xpToNext = xpForLevel(state.level);
    gained += 1;
  }
  return gained;
}

// ===== Difficulty ramp =====
// Seconds between enemy spawns — shrinks the longer you survive, down to a floor.
function spawnInterval(time) {
  return Math.max(SPAWN_MIN, SPAWN_BASE - time * SPAWN_RAMP);
}

// ===== Small formatting / record helpers (pure) =====
function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

// The better of a previous best and a new run (both in seconds, whole numbers).
function betterBest(prev, time) {
  return Math.max(Math.round(prev || 0), Math.round(time || 0));
}

// ===== Firing & aim (pure) =====
// Unit vector from (x,y) toward (tx,ty), scaled by `speed` → {vx,vy}. (0,0) if identical.
function steer(x, y, tx, ty, speed) {
  const dx = tx - x, dy = ty - y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { vx: 0, vy: 0 };
  return { vx: (dx / len) * speed, vy: (dy / len) * speed };
}

// Build one volley of projectiles from `player` toward (tx,ty) using `weapon`.
// straight = aimed shot(s) (× player.projectiles, lightly fanned); spread = a 3-shot
// fan; boomerang = an aimed shot flagged to return. Pure — the caller pushes them.
function spawnProjectiles(player, weapon, tx, ty) {
  const base = steer(player.x, player.y, tx, ty, PROJECTILE_SPEED);
  const baseAngle = (base.vx === 0 && base.vy === 0) ? 0 : Math.atan2(base.vy, base.vx);
  const mk = (angle, extra) => {
    const big = player.bigShotTimer > 0;
    return Object.assign({
      x: player.x, y: player.y,
      vx: Math.cos(angle) * PROJECTILE_SPEED,
      vy: Math.sin(angle) * PROJECTILE_SPEED,
      damage: player.damage,
      radius: PROJECTILE_RADIUS * (big ? BIG_SHOT_SIZE : 1),
      life: PROJECTILE_LIFE,
      weaponId: weapon.id,
      pierce: big, hits: [],
    }, extra || {});
  };
  const shots = [];
  if (weapon.pattern === 'spread') {
    for (const off of [-0.25, 0, 0.25]) shots.push(mk(baseAngle + off));
  } else if (weapon.pattern === 'boomerang') {
    shots.push(mk(baseAngle, { boomerang: true, age: 0 }));
  } else { // straight (default)
    const n = Math.max(1, player.projectiles | 0);
    for (let i = 0; i < n; i++) {
      const off = (n === 1) ? 0 : (i / (n - 1) - 0.5) * 0.3;
      shots.push(mk(baseAngle + off));
    }
  }
  return shots;
}

// ===== Upgrades: offer 3, apply the chosen one (pure) =====
// 3 distinct upgrade ids (all of them, shuffled, when only 3 ship). Pass a seeded
// rng for deterministic tests; defaults to Math.random.
function offerUpgrades(rng) {
  const r = rng || Math.random;
  const pool = Object.keys(UPGRADES);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool.slice(0, 3);
}

// Apply the chosen upgrade to the run and record it. Returns false for an unknown id.
function chooseUpgrade(state, id) {
  const up = UPGRADES[id];
  if (!up) return false;
  up.apply(state);
  state.upgradesTaken.push(id);
  return true;
}

// ===== State factory (ONE game-state object) =====
// A fresh run. weaponId picks the equipped weapon (default blaster); the hero's
// live `damage` is seeded from that weapon so the +damage upgrade has a base to grow.
function freshGame(weaponId) {
  const wId = (weaponId && WEAPONS[weaponId]) ? weaponId : 'blaster';
  const weapon = WEAPONS[wId];
  const player = Object.assign({}, PLAYER_BASE, {
    x: ARENA.w / 2, y: ARENA.h / 2,
    hp: PLAYER_BASE.maxHp, damage: weapon.damage, weaponId: wId,
    pop: 0, invuln: 0, aim: 0, lives: MAX_LIVES,
  });
  return {
    status: 'start', time: 0, score: 0,
    level: 1, xp: 0, xpToNext: xpForLevel(1),
    player,
    enemies: [], projectiles: [], gems: [], particles: [], floaters: [],
    shake: 0, spawnTimer: spawnInterval(0), fireTimer: 0,
    bossTimer: BOSS_INTERVAL, bossWarning: 0,
    autoTimer: AUTO_PERIOD, autoRemaining: 0, autoMode: false,
    slowTimer: 0,
    upgradesTaken: [], offered: [], pendingLevels: 0,
  };
}

// ===== Best-run persistence (parse logic is pure via betterBest; I/O is guarded) =====
function loadBest() {
  if (typeof localStorage === 'undefined') return 0;
  const n = Number(localStorage.getItem(BEST_KEY));
  return (Number.isFinite(n) && n > 0) ? Math.round(n) : 0;
}
function saveBest(time) {
  const best = betterBest(loadBest(), time);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {}
  }
  return best;
}

// ===== Engine: spawning, kills, juice data, level-up, game over =====
// Spawn one enemy from the ENEMIES pool just outside a random edge. Pure data push;
// `rng` is injectable for tests. The spawn director (in update) sets the cadence.
function spawnEnemy(state, rng) {
  const r = rng || Math.random;
  const ids = Object.keys(ENEMIES);
  const def = ENEMIES[ids[Math.floor(r() * ids.length)]];
  const edge = Math.floor(r() * 4);
  let x, y;
  if (edge === 0) { x = r() * ARENA.w; y = -20; }
  else if (edge === 1) { x = ARENA.w + 20; y = r() * ARENA.h; }
  else if (edge === 2) { x = r() * ARENA.w; y = ARENA.h + 20; }
  else { x = -20; y = r() * ARENA.h; }
  state.enemies.push({
    id: def.id, emoji: def.emoji, behavior: def.behavior,
    x, y, hp: def.hp, maxHp: def.hp, speed: def.speed,
    xp: def.xp || GEM_XP, radius: 16, age: 0, split: def.behavior === 'splitter',
  });
}

// Summon the boss just off a random edge — 3,000 HP, drawn 3× bigger. Slower
// but very tanky; drops a big XP chip and big score.
function spawnBoss(state, rng) {
  const r = rng || Math.random;
  const hp = BOSS.hp;
  const edge = Math.floor(r() * 4);
  let x, y;
  if (edge === 0) { x = r() * ARENA.w; y = -60; }
  else if (edge === 1) { x = ARENA.w + 60; y = r() * ARENA.h; }
  else if (edge === 2) { x = r() * ARENA.w; y = ARENA.h + 60; }
  else { x = -60; y = r() * ARENA.h; }
  state.enemies.push({
    id: BOSS.id, emoji: BOSS.emoji, behavior: 'chase',
    x, y, hp, maxHp: hp, speed: BOSS.speed,
    xp: BOSS.xp, radius: 16 * BOSS_SCALE, age: 0, split: false,
    isBoss: true, scale: BOSS_SCALE, score: BOSS.score,
  });
}

// A dead enemy scores, drops an XP chip, throws a burst, and — if a splitter —
// breaks into two smaller non-splitting chasers (the engine supports it; the
// starter doesn't ship one).
function killEnemy(state, e) {
  state.score += (e.score || 5);
  state.gems.push({ x: e.x, y: e.y, value: e.xp || GEM_XP, radius: 8, age: 0 });
  spawnBurst(state, e.x, e.y, e.id);
  state._kill = true;
  if (e.split) {
    const childHp = Math.max(1, Math.round(e.maxHp / 2));
    for (let i = 0; i < 2; i++) {
      state.enemies.push({
        id: e.id, emoji: e.emoji, behavior: 'chase',
        x: e.x + (i ? 14 : -14), y: e.y, hp: childHp, maxHp: childHp,
        speed: e.speed * 1.2, xp: e.xp, radius: 12, age: 0, split: false,
      });
    }
  }
}

// A floating number (real damage or +N XP). Plain data; the renderer draws + ages it.
function spawnFloater(state, x, y, text, kind) {
  state.floaters.push({ x, y, text, kind: kind || 'dmg', age: 0, life: 0.9 });
}

// A particle burst keyed off content id, with graceful fallback. Plain data only.
function spawnBurst(state, x, y, id) {
  const emojis = BURSTS[id] || BURSTS._default;
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI * 2 * i) / 6 + (Math.random() * 0.5);
    const spd = 60 + Math.random() * 80;
    state.particles.push({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      emoji: emojis[i % emojis.length], age: 0, life: 0.7,
    });
  }
}

// Pause the run and offer 1-of-3 upgrade cards. Extra levels (from a big gulp of XP)
// queue in pendingLevels so each gets its own card pick.
function levelUp(state, levels) {
  state.status = 'levelup';
  state.pendingLevels = (state.pendingLevels || 0) + (levels - 1);
  state.offered = offerUpgrades();
  state.player.pop = POP_TIME;
  state._levelup = true;
}

function gameOver(state) {
  state.status = 'over';
  state.best = saveBest(state.time);
  state._over = true;
}

// ===== Engine: the simulation step =====
// Advance the whole game by `dt` seconds. `input` is a movement vector {x,y} in
// roughly [-1,1] (the DOM layer builds it from the keys held). Runs only while
// playing. Sets one-shot `_event` flags the audio layer consumes + clears each frame.
function update(state, dt, input) {
  if (state.status !== 'playing') return;
  const p = state.player;

  state.time += dt;
  if (p.pop > 0) p.pop = Math.max(0, p.pop - dt);
  if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
  if (p.bigShotTimer > 0) p.bigShotTimer = Math.max(0, p.bigShotTimer - dt);
  if (state.slowTimer > 0) state.slowTimer = Math.max(0, state.slowTimer - dt);
  if (state.shake > 0) state.shake = Math.max(0, state.shake - dt);

  // age + cull the juice layers (plain data; the renderer just reads them)
  for (const f of state.floaters) { f.age += dt; f.y -= 22 * dt; }
  state.floaters = state.floaters.filter((f) => f.age < f.life);
  for (const t of state.particles) { t.age += dt; t.x += t.vx * dt; t.y += t.vy * dt; t.vy += 120 * dt; }
  state.particles = state.particles.filter((t) => t.age < t.life);
  for (const gm of state.gems) {
    gm.age += dt;
    // every chip flies straight to the hero (no walking needed)
    const gs = steer(gm.x, gm.y, p.x, p.y, GEM_MAGNET_SPEED);
    gm.x += gs.vx * dt;
    gm.y += gs.vy * dt;
  }

  // --- the hero stays anchored in the center (no WASD movement) ---
  p.x = ARENA.w / 2;
  p.y = ARENA.h / 2;

  // --- spawn director ---
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0 || state.enemies.length === 0) {
    spawnEnemy(state);
    state.spawnTimer = spawnInterval(state.time);
  }

  // --- boss director: every 1.5 min, warn 5s, then spawn the big one ---
  state.bossTimer -= dt;
  if (state.bossTimer <= 0) {
    state.bossTimer = BOSS_INTERVAL;
    state.bossWarning = BOSS_WARNING;
    state._warn = true;
  }
  if (state.bossWarning > 0) {
    state.bossWarning -= dt;
    if (state.bossWarning <= 0) {
      state.bossWarning = 0;
      spawnBoss(state);
      state._boss = true;
    }
  }

  // --- auto-fire burst: every 30s the blaster auto-aims and fires for 10s ---
  state.autoTimer -= dt;
  if (state.autoTimer <= 0) {
    state.autoTimer = AUTO_PERIOD;
    state.autoRemaining = AUTO_DURATION;
    state._autoOn = true;
  }
  if (state.autoRemaining > 0) state.autoRemaining -= dt;

  // --- firing: auto-aim while AUTO is on (toggle or timed burst), else manual ---
  const weapon = WEAPONS[p.weaponId];
  if (state.autoMode || state.autoRemaining > 0) {
    const target = nearestEnemy(p.x, p.y, state.enemies);
    if (target) {
      p.aim = Math.atan2(target.y - p.y, target.x - p.x);
      state.fireTimer -= dt;
      if (state.fireTimer <= 0) {
        for (const shot of spawnProjectiles(p, weapon, target.x, target.y)) state.projectiles.push(shot);
        state.fireTimer = 1 / (p.fireRate * (weapon.cadence || 1));
        p.pop = POP_TIME;
        state._fired = true;
      }
    }
  } else {
    const aimX = (input && input.aimX !== undefined) ? input.aimX : p.x;
    const aimY = (input && input.aimY !== undefined) ? input.aimY : p.y;
    p.aim = Math.atan2(aimY - p.y, aimX - p.x);
    state.fireTimer -= dt;
    if (input && input.fire && state.fireTimer <= 0) {
      for (const shot of spawnProjectiles(p, weapon, aimX, aimY)) state.projectiles.push(shot);
      state.fireTimer = 1 / (p.fireRate * (weapon.cadence || 1));
      p.pop = POP_TIME;
      state._fired = true;
    }
  }

  // --- move enemies by behavior (monsters also slowly gain HP) ---
  for (const e of state.enemies) {
    e.age += dt;
    if (!e.isBoss) {
      e.regen = (e.regen || 0) + dt;
      if (e.regen >= MONSTER_REGEN_SECONDS) {
        e.regen -= MONSTER_REGEN_SECONDS;
        e.hp += MONSTER_REGEN_HP;
        e.maxHp += MONSTER_REGEN_HP;
      }
    }
    const speed = (state.slowTimer > 0) ? e.speed * SLOW_FACTOR : e.speed;
    const s = steer(e.x, e.y, p.x, p.y, speed);
    let vx = s.vx, vy = s.vy;
    if (e.behavior === 'zigzag') {
      const perp = Math.atan2(vy, vx) + Math.PI / 2;
      const wob = Math.sin(e.age * 6) * e.speed * 0.6;
      vx += Math.cos(perp) * wob; vy += Math.sin(perp) * wob;
    }
    e.x += vx * dt; e.y += vy * dt;
  }

  // --- move projectiles (boomerangs reverse once at half-life) ---
  for (const pr of state.projectiles) {
    pr.life -= dt;
    if (pr.boomerang) {
      pr.age += dt;
      if (pr.age > PROJECTILE_LIFE / 2) { pr.vx *= -1; pr.vy *= -1; pr.boomerang = false; }
    }
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
  }
  state.projectiles = state.projectiles.filter((pr) =>
    pr.life > 0 && pr.x > -40 && pr.x < ARENA.w + 40 && pr.y > -40 && pr.y < ARENA.h + 40);

  // --- projectile → enemy (big shots pierce and hit several monsters) ---
  for (const pr of state.projectiles) {
    for (const e of state.enemies) {
      if (e.hp <= 0) continue;
      if (pr.pierce && pr.hits.indexOf(e) !== -1) continue; // already pierced this one
      if (circleHit(pr.x, pr.y, pr.radius, e.x, e.y, e.radius)) {
        e.hp -= pr.damage;
        if (pr.pierce) pr.hits.push(e);
        else pr.life = 0;
        spawnFloater(state, e.x, e.y, String(pr.damage), 'dmg');
        spawnBurst(state, e.x, e.y, e.id);
        state._hit = true;
        if (e.hp <= 0) killEnemy(state, e);
        if (!pr.pierce) break;
      }
    }
  }
  state.projectiles = state.projectiles.filter((pr) => pr.life > 0);
  state.enemies = state.enemies.filter((e) => e.hp > 0);

  // --- enemy → hero (respecting i-frames) ---
  if (p.invuln <= 0) {
    for (const e of state.enemies) {
      if (circleHit(p.x, p.y, p.radius, e.x, e.y, e.radius)) {
        p.hp = clamp(p.hp - ENEMY_TOUCH_DAMAGE, 0, p.maxHp);
        p.invuln = ENEMY_HIT_COOLDOWN;
        state.shake = SHAKE_ON_HIT;
        state._hurt = true;
        if (p.hp <= 0) {
          p.lives -= 1;
          if (p.lives > 0) {
            p.hp = p.maxHp;
            p.invuln = 1.5; // a short shield so you don't lose another heart instantly
            spawnFloater(state, p.x, p.y, '-1 LIFE', 'dmg');
            state._respawn = true;
          } else {
            gameOver(state);
            return;
          }
        }
        break;
      }
    }
  }

  // --- hero → gems (a gentle pickup magnet via a larger collect radius) ---
  let gained = 0;
  const kept = [];
  for (const gm of state.gems) {
    if (circleHit(p.x, p.y, p.radius + 18, gm.x, gm.y, gm.radius)) {
      gained += gm.value;
      state.score += gm.value * 10;
      spawnFloater(state, gm.x, gm.y, '+' + gm.value, 'xp');
      state._gem = true;
    } else kept.push(gm);
  }
  state.gems = kept;

  if (gained > 0) {
    const levels = applyXp(state, gained);
    if (levels > 0) levelUp(state, levels);
  }
}

// ===== Sound (synthesized Web Audio — NO audio files, ever) =====
// Tiny oscillator blips. Guarded so node never touches AudioContext/localStorage.
// A mute toggle persists separately from the run. The context unlocks on the first
// user gesture (start click), per browser autoplay rules.
const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
let audioCtx = null;
let muted = false;

function loadMute() {
  return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';
}
function setMute(on) {
  muted = on;
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch (e) {}
  }
  const btn = (typeof document !== 'undefined') && document.getElementById('mute');
  if (btn) { btn.textContent = on ? '🔇' : '🔊'; btn.setAttribute('aria-pressed', String(on)); }
}
function ensureAudio() {
  if (muted || !AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function tone(ctx, freq, start, dur, type, peak) {
  const o = ctx.createOscillator();
  const gain = ctx.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak || 0.14, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(gain); gain.connect(ctx.destination);
  o.start(start); o.stop(start + dur + 0.03);
}
const SFX = {
  fire:    (c, t) => { tone(c, 660, t, 0.07, 'square', 0.08); },
  hit:     (c, t) => { tone(c, 320, t, 0.05, 'triangle', 0.07); },
  kill:    (c, t) => { tone(c, 180, t, 0.12, 'square', 0.12); tone(c, 90, t + 0.06, 0.12, 'square', 0.1); },
  gem:     (c, t) => { tone(c, 880, t, 0.07, 'triangle', 0.1); tone(c, 1320, t + 0.05, 0.08, 'triangle', 0.09); },
  hurt:    (c, t) => { tone(c, 140, t, 0.18, 'sawtooth', 0.12); },
  levelup: (c, t) => { [523, 659, 784, 1047].forEach((f, i) => tone(c, f, t + i * 0.07, 0.18, 'triangle', 0.13)); },
  over:    (c, t) => { [440, 330, 247].forEach((f, i) => tone(c, f, t + i * 0.12, 0.26, 'sine', 0.13)); },
  warn:    (c, t) => { [220, 220, 220].forEach((f, i) => tone(c, f, t + i * 0.22, 0.14, 'square', 0.11)); },
  boss:    (c, t) => { tone(c, 70, t, 0.5, 'sawtooth', 0.16); tone(c, 55, t + 0.18, 0.5, 'sawtooth', 0.14); },
  auto:    (c, t) => { [440, 660, 880].forEach((f, i) => tone(c, f, t + i * 0.06, 0.09, 'square', 0.08)); },
  respawn: (c, t) => { [330, 220, 165].forEach((f, i) => tone(c, f, t + i * 0.1, 0.14, 'triangle', 0.12)); },
};
function sfx(name) {
  const ctx = ensureAudio();
  if (!ctx) return;
  (SFX[name] || SFX.fire)(ctx, ctx.currentTime); // unknown cues fall back to a soft blip
}

// Intense boss music — synthesized, no audio files. A driving bass + kick +
// tense arpeggio that loops while a boss is on the way or on the field. Started
// and stopped from the browser loop so the engine stays pure.
let bossMusicTimer = null;
let bossMusicOn = false;

function bossMusicTick() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(ctx, 55, t, 0.4, 'sawtooth', 0.14);            // heavy low bass pulse
  tone(ctx, 55, t + 0.25, 0.35, 'sawtooth', 0.14);
  tone(ctx, 130, t, 0.1, 'square', 0.12);             // kick thump
  [110, 131, 165, 220].forEach((f, i) => tone(ctx, f, t + i * 0.11, 0.09, 'square', 0.05)); // tense arpeggio
}

function startBossMusic() {
  if (bossMusicOn || typeof setInterval === 'undefined') return;
  bossMusicOn = true;
  bossMusicTick();
  bossMusicTimer = setInterval(bossMusicTick, 480);
}

function stopBossMusic() {
  bossMusicOn = false;
  if (bossMusicTimer) { clearInterval(bossMusicTimer); bossMusicTimer = null; }
}

// Map the one-shot event flags update() set this frame to sounds, then clear them.
function consumeAudioEvents(state) {
  if (state._fired)   { sfx('fire');    state._fired = false; }
  if (state._hit)     { sfx('hit');     state._hit = false; }
  if (state._kill)    { sfx('kill');    state._kill = false; }
  if (state._gem)     { sfx('gem');     state._gem = false; }
  if (state._hurt)    { sfx('hurt');    state._hurt = false; }
  if (state._levelup) { sfx('levelup'); state._levelup = false; }
  if (state._over)    { sfx('over');    state._over = false; }
  if (state._warn)    { sfx('warn');    state._warn = false; }
  if (state._boss)    { sfx('boss');    state._boss = false; }
  if (state._autoOn)  { sfx('auto');    state._autoOn = false; }
  if (state._respawn) { sfx('respawn'); state._respawn = false; }
}

// ===== Render (canvas 2D — browser only) =====
// Neutral palette, read from CSS custom properties so a kid's CLAUDE.md can re-skin
// the look by editing style.css. Falls back to literals if the page hasn't loaded them.
function cssVar(name, fallback) {
  if (typeof document === 'undefined' || !document.documentElement) return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// The placeholder hero: a simple drawn "ship" that points where it's aiming and
// squashes on a pop. Generic on purpose — kids re-theme it via their CLAUDE.md.
function drawHero(ctx, p) {
  const squash = 1 + (p.pop > 0 ? (p.pop / POP_TIME) * 0.35 : 0);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.aim || 0);
  ctx.scale(squash, 2 - squash);
  if (p.invuln > 0 && Math.floor(p.invuln * 20) % 2 === 0) ctx.globalAlpha = 0.5; // blink during i-frames
  ctx.fillStyle = cssVar('--hero', '#6fd3ff');
  ctx.beginPath();
  ctx.moveTo(p.radius, 0);
  ctx.lineTo(-p.radius * 0.8, p.radius * 0.7);
  ctx.lineTo(-p.radius * 0.4, 0);
  ctx.lineTo(-p.radius * 0.8, -p.radius * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function render(ctx, state) {
  const shakeX = state.shake > 0 ? (Math.random() - 0.5) * state.shake * 40 : 0;
  const shakeY = state.shake > 0 ? (Math.random() - 0.5) * state.shake * 40 : 0;
  ctx.save();
  ctx.clearRect(0, 0, ARENA.w, ARENA.h);
  ctx.translate(shakeX, shakeY);

  // arena floor + subtle grid
  ctx.fillStyle = cssVar('--arena', '#161a24');
  ctx.fillRect(-40, -40, ARENA.w + 80, ARENA.h + 80);
  ctx.strokeStyle = cssVar('--grid', '#222838');
  ctx.lineWidth = 1;
  for (let x = 0; x <= ARENA.w; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ARENA.h); ctx.stroke(); }
  for (let y = 0; y <= ARENA.h; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA.w, y); ctx.stroke(); }

  // XP chips (warm drawn diamonds)
  ctx.fillStyle = cssVar('--xp', '#ffcf5c');
  for (const gm of state.gems) {
    ctx.save(); ctx.translate(gm.x, gm.y); ctx.rotate(gm.age * 3);
    ctx.fillRect(-gm.radius / 2, -gm.radius / 2, gm.radius, gm.radius);
    ctx.restore();
  }

  // projectiles
  ctx.fillStyle = cssVar('--shot', '#bdecff');
  for (const pr of state.projectiles) {
    ctx.beginPath(); ctx.arc(pr.x, pr.y, pr.radius, 0, Math.PI * 2); ctx.fill();
  }

  // enemies (emoji from their registry row; bosses are drawn 3× bigger)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const e of state.enemies) {
    ctx.font = Math.round(28 * (e.scale || 1)) + 'px system-ui, sans-serif';
    ctx.fillText(e.emoji, e.x, e.y);
  }

  // hero
  drawHero(ctx, state.player);

  // particle bursts (emoji)
  ctx.font = '20px system-ui, sans-serif';
  for (const t of state.particles) {
    ctx.globalAlpha = Math.max(0, 1 - t.age / t.life);
    ctx.fillText(t.emoji, t.x, t.y);
  }
  ctx.globalAlpha = 1;

  // floating numbers (real damage / +N XP)
  ctx.font = 'bold 16px system-ui, sans-serif';
  for (const f of state.floaters) {
    ctx.globalAlpha = Math.max(0, 1 - f.age / f.life);
    ctx.fillStyle = f.kind === 'xp' ? cssVar('--xp', '#ffcf5c') : cssVar('--ink', '#e8edf5');
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;

  // Boss warning — a big red sign in the middle, shown 5s before the boss arrives.
  if (state.bossWarning > 0) {
    const cx = ARENA.w / 2, cy = ARENA.h / 2;
    const bw = 440, bh = 116;
    ctx.fillStyle = '#e0243c';
    ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.strokeStyle = '#ffc2c9';
    ctx.lineWidth = 4;
    ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 42px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('BOSS HAS ARRIVED!', cx, cy);
  }

  // Auto-fire indicator — a gold tag while auto is on (toggle or timed burst).
  if (state.autoMode || state.autoRemaining > 0) {
    ctx.fillStyle = cssVar('--xp', '#ffcf5c');
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = state.autoMode ? 'AUTO ON' : 'AUTO-FIRE ON — ' + Math.ceil(state.autoRemaining) + 's';
    ctx.fillText(label, ARENA.w / 2, 26);
  }

  // Time-slow countdown — a purple tag while enemies are slowed.
  if (state.slowTimer > 0) {
    ctx.fillStyle = '#c39bff';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('TIME SLOW — ' + Math.ceil(state.slowTimer) + 's', ARENA.w / 2, 66);
  }

  // Big Shot countdown — a green tag while shots are oversized.
  if (state.player.bigShotTimer > 0) {
    ctx.fillStyle = '#7dffb0';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('BIG SHOT — ' + Math.ceil(state.player.bigShotTimer) + 's', ARENA.w / 2, 86);
  }

  ctx.restore();
}

// ===== HUD + overlays (DOM — browser only) =====
function updateHud(state) {
  if (typeof document === 'undefined') return;
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('hp-fill', (el) => { el.style.width = clamp(state.player.hp / state.player.maxHp * 100, 0, 100) + '%'; });
  set('hearts', (el) => {
    let s = '';
    for (let i = 0; i < MAX_LIVES; i++) s += (i < state.player.lives) ? '❤️' : '🖤';
    el.textContent = s;
  });
  set('timer', (el) => { el.textContent = formatTime(state.time); });
  set('score', (el) => { el.textContent = String(state.score); });
  set('level', (el) => { el.textContent = 'Lv ' + state.level; });
  set('xp-fill', (el) => { el.style.width = clamp(state.xp / state.xpToNext * 100, 0, 100) + '%'; });

  const autoBtn = document.getElementById('auto');
  if (autoBtn) {
    autoBtn.classList.toggle('on', state.autoMode);
    autoBtn.setAttribute('aria-pressed', String(state.autoMode));
  }

  const boss = state.enemies.find((e) => e.isBoss);
  const bossBar = document.getElementById('boss-bar');
  if (bossBar) bossBar.hidden = !boss;
  set('boss-fill', (el) => { el.style.width = (boss ? clamp(boss.hp / boss.maxHp * 100, 0, 100) : 0) + '%'; });
}

// Show exactly the overlay the current status calls for. `handlers` wires the
// buttons: { onStart, onChoose(id), onRestart }. Built fresh each status change.
function showOverlays(state, handlers) {
  if (typeof document === 'undefined') return;
  const start = document.getElementById('start-screen');
  const levelup = document.getElementById('levelup');
  const over = document.getElementById('gameover');
  if (!start || !levelup || !over) return;
  start.hidden = state.status !== 'start';
  levelup.hidden = state.status !== 'levelup';
  over.hidden = state.status !== 'over';

  if (state.status === 'levelup') {
    const row = document.getElementById('cards');
    row.innerHTML = '';
    for (const id of state.offered) {
      const u = UPGRADES[id];
      const card = document.createElement('button');
      card.className = 'card';
      card.innerHTML = '<span class="card-name">' + u.name + '</span><span class="card-flavor">' + u.flavor + '</span>';
      card.addEventListener('click', () => handlers.onChoose(id));
      row.appendChild(card);
    }
  }
  if (state.status === 'over') {
    const t = document.getElementById('over-time');
    const b = document.getElementById('over-best');
    if (t) t.textContent = formatTime(state.time);
    if (b) b.textContent = formatTime(state.best || loadBest());
  }
}

// ===== Input + game loop + wiring (browser only) =====
const KEYS_LEFT  = ['ArrowLeft', 'a', 'A'];
const KEYS_RIGHT = ['ArrowRight', 'd', 'D'];
const KEYS_UP    = ['ArrowUp', 'w', 'W'];
const KEYS_DOWN  = ['ArrowDown', 's', 'S'];
const held = new Set();
const mouse = { x: ARENA.w / 2, y: ARENA.h / 2, fire: false }; // aim + right-click fire

function inputVector() {
  let x = 0, y = 0;
  if (KEYS_LEFT.some((k) => held.has(k))) x -= 1;
  if (KEYS_RIGHT.some((k) => held.has(k))) x += 1;
  if (KEYS_UP.some((k) => held.has(k))) y -= 1;
  if (KEYS_DOWN.some((k) => held.has(k))) y += 1;
  return { x, y, aimX: mouse.x, aimY: mouse.y, fire: mouse.fire };
}

let state = null;
let lastStatus = null;

function startRun() {
  state.status = 'playing';
  ensureAudio(); // unlock audio on this user gesture
}

function resumeFromLevelUp(id) {
  chooseUpgrade(state, id);
  if (state.pendingLevels > 0) {        // another level queued → offer again
    state.pendingLevels -= 1;
    state.offered = offerUpgrades();
    showOverlays(state, { onChoose: resumeFromLevelUp });
  } else {
    state.status = 'playing';
  }
}

function init() {
  const canvas = document.getElementById('arena');
  if (!canvas) return;
  canvas.width = ARENA.w;
  canvas.height = ARENA.h;
  const ctx = canvas.getContext('2d');

  state = freshGame();
  muted = loadMute();
  setMute(muted);

  const handlers = {
    onChoose: resumeFromLevelUp,
    onStart: startRun,
    onRestart: () => { state = freshGame(); startRun(); },
  };

  window.addEventListener('keydown', (e) => {
    if ([].concat(KEYS_LEFT, KEYS_RIGHT, KEYS_UP, KEYS_DOWN).includes(e.key)) e.preventDefault();
    held.add(e.key);
  });
  window.addEventListener('keyup', (e) => held.delete(e.key));

  // Mouse aim + right-click to shoot. Convert page coords → arena coords so the
  // aim stays accurate even though the canvas is scaled by CSS.
  const toArena = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  };
  window.addEventListener('mousemove', (e) => {
    const p = toArena(e.clientX, e.clientY);
    mouse.x = p.x; mouse.y = p.y;
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault(); // stop the browser menu — right-click shoots instead
    const p = toArena(e.clientX, e.clientY);
    mouse.x = p.x; mouse.y = p.y;
    mouse.fire = true;
  });

  const startBtn = document.getElementById('start-btn');
  if (startBtn) startBtn.addEventListener('click', handlers.onStart);
  const restartBtn = document.getElementById('restart-btn');
  if (restartBtn) restartBtn.addEventListener('click', handlers.onRestart);
  const muteBtn = document.getElementById('mute');
  if (muteBtn) muteBtn.addEventListener('click', () => setMute(!muted));
  const autoBtn = document.getElementById('auto');
  if (autoBtn) autoBtn.addEventListener('click', () => { state.autoMode = !state.autoMode; });

  const bestEl = document.getElementById('start-best');
  if (bestEl) bestEl.textContent = formatTime(loadBest());

  let last = (typeof performance !== 'undefined') ? performance.now() : 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); // clamp dt so a tab-out doesn't teleport the swarm
    last = now;
    update(state, dt, inputVector());
    mouse.fire = false;
    consumeAudioEvents(state);
    render(ctx, state);
    updateHud(state);
    // intense music on while a boss is on the way or alive; off otherwise
    const bossActive = (state.status === 'playing' || state.status === 'levelup')
      && (state.bossWarning > 0 || state.enemies.some((e) => e.isBoss));
    if (bossActive) startBossMusic(); else stopBossMusic();
    if (state.status !== lastStatus) { showOverlays(state, handlers); lastStatus = state.status; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', init);
}

// ===== Node export guard (the browser ignores this; node --test reads it) =====
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ARENA, PLAYER_BASE, GEM_XP, ENEMY_TOUCH_DAMAGE, PROJECTILE_SPEED,
    ENEMIES, WEAPONS, UPGRADES, BURSTS, BOSS,
    clamp, dist2, circleHit, nearestEnemy,
    xpForLevel, applyXp, spawnInterval, formatTime, betterBest,
    steer, spawnProjectiles, offerUpgrades, chooseUpgrade,
    freshGame, loadBest, saveBest,
    spawnEnemy, spawnBoss, killEnemy, spawnFloater, spawnBurst, levelUp, gameOver, update,
  };
}
