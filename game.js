/* Snake for Maybaah's Arcade.

   The run is tick-discrete, so it is fully determined by a seed and the ticks
   at which the player turned. The client records only that tape; the
   leaderboard Worker replays it and computes apples and steps itself. The
   simulation below (grid size, apple draw, collision order, what counts as an
   effective turn) must stay identical to the copy in the Worker.

   Boost is deliberately outside all of it: holding space shortens the timer,
   nothing else. It changes how much real time a run takes, never how many
   ticks it takes, so it never touches the tape and never touches the score. */
(function () {
  "use strict";

  var W = 20, H = 20, CELLS = W * H;
  var START_LEN = 3;
  var MAX_TICKS = 50000;
  var MAX_EVENTS = 8000;
  var TICK_MS = 110;
  var BOOST_MS = 55;
  var CELL_PX = 30;

  /* must match the worker's copy exactly */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomSeed() {
    if (window.crypto && crypto.getRandomValues) {
      return crypto.getRandomValues(new Uint32Array(1))[0];
    }
    return (Math.random() * 4294967296) >>> 0;
  }

  function utcDayKey() {
    var n = new Date();
    return n.getUTCFullYear() * 10000 + (n.getUTCMonth() + 1) * 100 + n.getUTCDate();
  }

  /* the daily board's apple sequence: the Worker derives it the same way from
     its own clock, so the client's copy is only a preview */
  function seedForDay(day) {
    return Math.imul(day, 2654435761) >>> 0;
  }

  var OPPOSITE = { u: "d", d: "u", l: "r", r: "l" };

  /* free cells in ascending index order, then one draw */
  function spawnApple(occ, rnd) {
    var free = [];
    for (var i = 0; i < CELLS; i++) if (!occ[i]) free.push(i);
    if (!free.length) return -1;
    return free[Math.floor(rnd() * free.length)];
  }

  function newState(seed) {
    var rnd = mulberry32(seed >>> 0);
    var occ = new Uint8Array(CELLS);
    var start = ((H / 2) | 0) * W + ((W / 2) | 0);
    var body = [];
    for (var i = 0; i < START_LEN; i++) {
      body.push(start - i);
      occ[start - i] = 1;
    }
    /* vacated is render bookkeeping only, never a rule: it is the cell the tail
       left this tick, so the drawing can slide off it. The worker has no such
       field and does not need one. */
    var st = { rnd: rnd, occ: occ, body: body, dir: "r", apples: 0, steps: 0, route: 0,
               apple: -1, vacated: null, done: false };
    st.apple = spawnApple(occ, rnd);
    return st;
  }

  /* one tick. "wall" / "self" / "full" end the run, "eat" and "ok" continue. */
  function step(st) {
    var head = st.body[0];
    var x = head % W, y = (head / W) | 0;
    if (st.dir === "l") x--;
    else if (st.dir === "r") x++;
    else if (st.dir === "u") y--;
    else y++;

    if (x < 0 || x >= W || y < 0 || y >= H) { st.done = true; return "wall"; }
    var next = y * W + x;

    var last = st.body[st.body.length - 1];
    var eat = next === st.apple;
    // the tail cell is vacated on this same tick unless the apple is there
    if (st.occ[next] && !(next === last && !eat)) { st.done = true; return "self"; }

    st.vacated = null;
    if (!eat) {
      st.body.pop();
      st.occ[last] = 0;
      st.vacated = last;
    }
    st.body.unshift(next);
    st.occ[next] = 1;
    st.steps++;

    if (eat) {
      st.apples++;
      st.route = st.steps;
      st.apple = spawnApple(st.occ, st.rnd);
      if (st.apple < 0) { st.done = true; return "full"; }
      return "eat";
    }
    return "ok";
  }

  /* ── state ── */
  var st, seed, mode, day, moveLog, events, lastEventTick, tickIndex;
  var queue, running, over, boosting, timer, tickMs, lastTickAt;

  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var overlay = document.getElementById("overlay");
  var elApples = document.getElementById("s-apples");
  var elBest = document.getElementById("s-best");
  var elSteps = document.getElementById("s-steps");
  var elRoute = document.getElementById("s-route");
  var elLen = document.getElementById("s-len");
  var elSeed = document.getElementById("s-seed");

  canvas.width = W * CELL_PX;
  canvas.height = H * CELL_PX;

  var COL_BG = "#111111";
  var COL_GRID = "#1a1a1a";
  var COL_BODY = "#8a8a8a";
  var COL_HEAD = "#e8e8e8";
  var COL_APPLE = "#ef4444";
  var COL_APPLE_DARK = "#c02b2b";
  var COL_LEAF = "#22c55e";
  var COL_STEM = "#7a5230";

  var REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function cellXY(i) {
    return [(i % W) * CELL_PX, ((i / W) | 0) * CELL_PX];
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }

  /* two overlapping lobes, a bent stem and a leaf: reads as an apple rather
     than a red dot, and breathes gently so a still board is not dead */
  function drawApple(now) {
    var p = cellXY(st.apple);
    var cx = p[0] + CELL_PX / 2;
    var cy = p[1] + CELL_PX / 2;
    var r = CELL_PX * 0.3 * (REDUCED ? 1 : 1 + Math.sin(now / 340) * 0.06);

    ctx.fillStyle = COL_APPLE;
    ctx.beginPath();
    ctx.arc(cx - r * 0.3, cy + r * 0.12, r * 0.8, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.3, cy + r * 0.12, r * 0.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COL_APPLE_DARK;
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.55, r * 0.5, r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = COL_STEM;
    ctx.lineWidth = Math.max(1.4, r * 0.16);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.62);
    ctx.quadraticCurveTo(cx + r * 0.12, cy - r * 1.15, cx + r * 0.42, cy - r * 1.22);
    ctx.stroke();

    ctx.fillStyle = COL_LEAF;
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.66, cy - r * 1.0, r * 0.42, r * 0.2, -0.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.44, cy - r * 0.3, r * 0.18, r * 0.3, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawEyes(x, y) {
    var cx = x + CELL_PX / 2, cy = y + CELL_PX / 2;
    var fx = st.dir === "l" ? -1 : st.dir === "r" ? 1 : 0;
    var fy = st.dir === "u" ? -1 : st.dir === "d" ? 1 : 0;
    var side = CELL_PX * 0.17, fwd = CELL_PX * 0.13, r = CELL_PX * 0.075;
    ctx.fillStyle = COL_BG;
    for (var s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.arc(cx + fx * fwd - fy * side * s, cy + fy * fwd + fx * side * s, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* The simulation stays on whole cells; only the picture slides between them.
     The head eases out of the neck it just left and the tail eases off the cell
     it just vacated, which is the whole of the smoothing. */
  function draw() {
    var now = performance.now();
    var t = REDUCED || !running || st.done
      ? 1
      : Math.min(1, (now - lastTickAt) / tickMs);

    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = COL_GRID;
    ctx.lineWidth = 1;
    for (var g = 1; g < W; g++) {
      ctx.beginPath();
      ctx.moveTo(g * CELL_PX + 0.5, 0);
      ctx.lineTo(g * CELL_PX + 0.5, canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, g * CELL_PX + 0.5);
      ctx.lineTo(canvas.width, g * CELL_PX + 0.5);
      ctx.stroke();
    }

    if (st.apple >= 0) drawApple(now);

    /* Every segment slides into the cell the one ahead of it just left, which
       is what makes the whole body flow instead of only the two ends. On a
       growth tick the tail vacated nothing, so it stays put and the rest
       stretches away from it. */
    var last = st.body.length - 1;
    var pts = [];
    for (var i = 0; i <= last; i++) {
      var to = cellXY(st.body[i]);
      var from = i === last
        ? (st.vacated !== null ? cellXY(st.vacated) : to)
        : cellXY(st.body[i + 1]);
      pts.push([
        from[0] + (to[0] - from[0]) * t + CELL_PX / 2,
        from[1] + (to[1] - from[1]) * t + CELL_PX / 2
      ]);
    }

    /* one stroked path rather than a row of separate tiles: round joins keep
       the corners continuous at any point between cells */
    ctx.strokeStyle = COL_BODY;
    ctx.lineWidth = CELL_PX - 7;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var k = 1; k <= last; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    ctx.stroke();

    var hx = pts[0][0] - CELL_PX / 2, hy = pts[0][1] - CELL_PX / 2;
    ctx.fillStyle = COL_HEAD;
    roundRect(hx + 2, hy + 2, CELL_PX - 4, CELL_PX - 4, 8);
    drawEyes(hx, hy);
  }

  function frame() {
    draw();
    requestAnimationFrame(frame);
  }

  function refreshStats() {
    elApples.textContent = st.apples;
    elSteps.textContent = st.steps;
    elRoute.textContent = st.route;
    elLen.textContent = st.body.length;
  }

  /* The boost is read here and nowhere else, so tapping space only takes effect
     from the next tick. Rescheduling a tick already in flight would let anyone
     postpone it forever by drumming on the key. */
  function schedule() {
    clearTimeout(timer);
    tickMs = boosting ? BOOST_MS : TICK_MS;
    lastTickAt = performance.now();
    timer = setTimeout(tick, tickMs);
  }

  function tick() {
    /* At most one turn per tick, applied at the top of it. Any looser and a
       fast double tap folds two turns into a single step, which is how you end
       up driving the head into your own neck. */
    if (queue.length) {
      var d = queue.shift();
      if (events < MAX_EVENTS) {
        moveLog += (tickIndex - lastEventTick) + d;
        lastEventTick = tickIndex;
        events++;
        st.dir = d;
      }
    }
    var r = step(st);
    tickIndex++;
    refreshStats();
    /* the animation frame loop does the smoothing, but it is throttled to
       nothing in a background tab, so every tick also paints once itself */
    draw();
    if (st.done) { endRun(r); return; }
    if (tickIndex >= MAX_TICKS) { endRun("cap"); return; }
    schedule();
  }

  /* Checked against the last turn already queued rather than the heading on
     screen, so two quick taps buffer into two separate ticks. */
  function turn(d) {
    if (over) return;
    if (!running) {
      running = true;
      overlay.classList.remove("show");
      schedule();
    }
    var ref = queue.length ? queue[queue.length - 1] : st.dir;
    if (d === ref || d === OPPOSITE[ref]) return;
    if (queue.length >= 2) return;
    queue.push(d);
  }

  function showOverlay(title, sub, buttonLabel) {
    document.getElementById("ov-title").textContent = title;
    document.getElementById("ov-sub").textContent = sub;
    document.getElementById("ov-again").textContent = buttonLabel;
    overlay.classList.add("show");
  }

  var ENDINGS = {
    wall: "you hit the wall",
    self: "you ran into yourself",
    full: "perfect run, the board is full",
    cap: "tick limit reached"
  };

  function endRun(reason) {
    over = true;
    running = false;
    clearTimeout(timer);
    showOverlay(ENDINGS[reason] || "run over",
      st.apples + " apples, " + st.route + " steps to the last one. ranked on those.", "New game");
    Arcade.addScore("snake", { apples: st.apples, steps: st.route, total: st.steps, mode: mode });
    if (st.apples > storedBest()) elBest.textContent = st.apples;
    if (reason !== "cap") showSubmitUI();
  }

  /* ── submission: the worker replays the tape and scores the run itself ── */
  function showSubmitUI() {
    var input = document.getElementById("run-name");
    var stored = Arcade.getPlayer();
    input.value = stored === "player" ? "" : stored;
    document.getElementById("run-status").textContent = "";
    document.getElementById("btn-submit-run").disabled = false;
    document.getElementById("submit-run").style.display = "flex";
  }

  function submitRun() {
    var input = document.getElementById("run-name");
    var status = document.getElementById("run-status");
    var btn = document.getElementById("btn-submit-run");
    var name = input.value.trim();
    if (!name) {
      status.textContent = "enter a name first";
      input.focus();
      return;
    }
    if (!window.Arcade || !Arcade.submit) return;
    Arcade.setPlayer(name);
    btn.disabled = true;
    status.textContent = "verifying…";
    Arcade.submit("snake", { mode: mode, seed: seed, day: day, moves: moveLog }).then(function (res) {
      status.textContent = res && res.rank ? "verified, ranked #" + res.rank : "verified";
    }).catch(function (e) {
      status.textContent = e.message || "submission failed";
      btn.disabled = false;
    });
  }

  /* ── lifecycle ── */
  function newGame() {
    day = utcDayKey();
    seed = mode === "daily" ? seedForDay(day) : randomSeed();
    st = newState(seed);
    moveLog = "";
    events = 0;
    lastEventTick = 0;
    tickIndex = 0;
    queue = [];
    tickMs = TICK_MS;
    lastTickAt = performance.now();
    running = false;
    over = false;
    boosting = false;
    clearTimeout(timer);
    document.getElementById("submit-run").style.display = "none";
    elSeed.textContent = mode === "daily" ? "day " + day : "#" + seed;
    showOverlay(mode === "daily" ? "daily seed" : "classic",
      mode === "daily"
        ? "same apples for everyone today. arrows, WASD or swipe to start."
        : "arrows, WASD or swipe to start.",
      "Start");
    draw();
    refreshStats();
  }

  function storedBest() {
    var runs = Arcade.getScores("snake");
    var m = 0;
    for (var i = 0; i < runs.length; i++) if (runs[i].apples > m) m = runs[i].apples;
    return m;
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    var pills = document.querySelectorAll("[data-mode]");
    for (var i = 0; i < pills.length; i++) {
      pills[i].setAttribute("aria-pressed", pills[i].getAttribute("data-mode") === mode ? "true" : "false");
    }
    newGame();
  }

  /* ── input ── */
  var KEYS = {
    ArrowUp: "u", ArrowRight: "r", ArrowDown: "d", ArrowLeft: "l",
    w: "u", d: "r", s: "d", a: "l", W: "u", D: "r", S: "d", A: "l"
  };

  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (!boosting && running) { boosting = true; schedule(); }
      return;
    }
    var dir = KEYS[e.key];
    if (!dir) return;
    e.preventDefault();
    turn(dir);
  });

  document.addEventListener("keyup", function (e) {
    if (e.key === " " || e.key === "Spacebar") boosting = false;
  });

  window.addEventListener("blur", function () { boosting = false; });

  /* A hidden tab still fires the tick timer, so without this the snake keeps
     walking into a wall while nobody is looking. Pausing only delays the next
     tick, it does not touch tickIndex, so the tape stays intact. */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden || !running || over) return;
    running = false;
    boosting = false;
    clearTimeout(timer);
    showOverlay("paused", "you switched away. the run is exactly where you left it.", "Resume");
  });

  var touchX = null, touchY = null;
  canvas.addEventListener("touchstart", function (e) {
    var t = e.changedTouches[0];
    touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });
  canvas.addEventListener("touchend", function (e) {
    if (touchX === null) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - touchX, dy = t.clientY - touchY;
    touchX = null;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "r" : "l") : (dy > 0 ? "d" : "u"));
  }, { passive: true });

  var pad = document.getElementById("dpad");
  pad.addEventListener("click", function (e) {
    var d = e.target.getAttribute("data-dir");
    if (d) turn(d);
  });

  var boostBtn = document.getElementById("btn-boost");
  function boostOn(e) { e.preventDefault(); if (running) { boosting = true; schedule(); } }
  function boostOff() { boosting = false; }
  boostBtn.addEventListener("touchstart", boostOn, { passive: false });
  boostBtn.addEventListener("touchend", boostOff);
  boostBtn.addEventListener("mousedown", boostOn);
  boostBtn.addEventListener("mouseup", boostOff);
  boostBtn.addEventListener("mouseleave", boostOff);

  document.getElementById("btn-new").addEventListener("click", newGame);
  document.getElementById("ov-again").addEventListener("click", function () {
    if (over) newGame();
    else turn(st.dir);
  });
  document.getElementById("btn-submit-run").addEventListener("click", submitRun);
  document.getElementById("run-name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitRun();
  });
  document.getElementById("modes").addEventListener("click", function (e) {
    var m = e.target.getAttribute("data-mode");
    if (m) setMode(m);
  });

  mode = "classic";
  elBest.textContent = storedBest();
  newGame();
  requestAnimationFrame(frame);

  /* exposed for the staging checks */
  window.__snake = {
    turn: turn,
    draw: draw,
    state: function () {
      return {
        mode: mode, seed: seed, day: day, moves: moveLog,
        apples: st.apples, steps: st.route, total: st.steps, len: st.body.length, over: over,
        apple: st.apple, body: st.body.slice(), dir: st.dir, w: W, h: H
      };
    }
  };
})();
