/*
 * Lyr TV displays: one dependency-free canvas renderer for the full-screen /
 * TV "now playing" views (cassette, meters, peak, signal, reel, turntable).
 *
 * Hosts: the Core's TV page (plain <script src>), the desktop full-screen view,
 * and the Chromecast receiver. Plain ES2019, no imports, no build step. The
 * global `LyrDisplays` is the interface; `module.exports` is set too so Node
 * tests can load it. Types: renderer.d.ts beside this file.
 *
 * Everything draws in a 1600 x 900 logical space, letterboxed to 16:9 inside
 * the canvas. Static parts of each view are drawn once into an offscreen layer
 * (keyed by size + view + variant + track text + font generation); each frame
 * blits that layer and draws only the moving parts.
 *
 * Motion is honest: needles and LEDs follow the decoded per-channel levels at
 * the play position, reels and the platter follow the POSITION DELTA, and with
 * no levels the meters rest at their stops.
 */
(function (root, factory) {
  var api = factory(root);
  root.LyrDisplays = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  var W = 1600, H = 900, TAU = Math.PI * 2;
  // Family names first so hosts that load the web fonts get them; system stacks
  // after, because a Chromecast may have none of them.
  var DISPLAY = '"Big Shoulders Display", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
  var SANS = '"IBM Plex Sans", -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  var MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, "Roboto Mono", "DejaVu Sans Mono", monospace';
  var HAND = 'Kalam, "Marker Felt", "Comic Sans MS", cursive';

  var VIEWS = [
    { id: "cassette", name: "Cassette deck", description: "A cassette plays in a deck window. Tape moves from the left reel to the right as the track plays, so the packs show how far in you are. The smaller pack spins faster, as on a real deck. A tape counter and two VU meters sit underneath." },
    { id: "meters", name: "VU meters", description: "Two large analogue meters with the needles following the track's loudness at VU speed. The peak lamp lights on loud transients. Title and format sit quietly underneath.", variants: [] },
    { id: "peak", name: "Peak meter", description: "Studio-style LED bars for left and right with a held peak, and the title set large above them. The bars rise instantly and fall at broadcast speed, 20 dB in 1.7 seconds." },
    { id: "signal", name: "Signal readout", description: "A hi-fi information screen: large readouts of rate, bit depth and codec, the path from source to player, and slim level bars." },
    { id: "reel", name: "Reel-to-reel", description: "A portable reel-to-reel recorder. Tape runs from the supply reel past the heads to the take-up reel as the track plays, so the packs show how far in you are, and the smaller pack spins faster. A single modulation meter shows left and right as a white and a red needle." },
    { id: "turntable", name: "Turntable", description: "A record turns at 33⅓ while the tonearm moves in from the outer groove to the run-out as the track plays. The label carries the album art. It stops when you pause." },
  ];

  // ---------------------------------------------------------------------------
  // Level data.
  var BYTE_LIN = new Float32Array(256);
  for (var bi = 1; bi < 256; bi++) BYTE_LIN[bi] = Math.pow(10, (bi / 4 - 64) / 20);

  function b64bytes(s) {
    if (typeof root.atob === "function") {
      var bin = root.atob(s), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
      return out;
    }
    if (typeof root.Buffer === "function") return new Uint8Array(root.Buffer.from(s, "base64"));
    throw new Error("LyrDisplays: no base64 decoder");
  }

  function decodeLevels(p) {
    if (!p || typeof p.data !== "string") return null;
    if (p.encoding && p.encoding !== "u8-db-quarter") return null;
    var frame = Array.isArray(p.frame) && p.frame.length ? p.frame : ["rmsL", "rmsR", "peakL", "peakR"];
    var bytes = b64bytes(p.data), fl = frame.length, n = Math.floor(bytes.length / fl);
    var idx = function (name, alt) { var i = frame.indexOf(name); return i >= 0 ? i : frame.indexOf(alt); };
    var cols = { rmsL: idx("rmsL", "rms"), rmsR: idx("rmsR", "rms"), peakL: idx("peakL", "peak"), peakR: idx("peakR", "peak") };
    var bucket = +p.bucketSeconds > 0 ? +p.bucketSeconds : 0.25;
    var out = { bucketSeconds: bucket, duration: +p.duration > 0 ? +p.duration : n * bucket };
    Object.keys(cols).forEach(function (k) {
      var a = new Float32Array(n), ci = cols[k];
      if (ci >= 0) for (var i = 0; i < n; i++) a[i] = BYTE_LIN[bytes[i * fl + ci]];
      out[k] = a;
    });
    return out;
  }

  function levelAt(arr, bucket, pos) {
    var n = arr ? arr.length : 0;
    if (!n || !(pos >= 0)) return 0;
    // A bucket's value describes its MIDDLE; treating it as its start made
    // every reading half a bucket late.
    var x = pos / bucket - 0.5;
    if (x > n) return 0; // past the analysed data: silence, not the last bucket forever
    if (x < 0) x = 0;
    if (n === 1) return arr[0];
    x = Math.min(n - 1.001, x);
    var i = Math.floor(x), f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  // VU scale: linear in voltage from -20 to +3 VU; 0 VU = -14 dBFS.
  var VU_LO = Math.pow(10, -20 / 20), VU_HI = Math.pow(10, 3 / 20);
  function vuFrac(vu) { return (Math.pow(10, Math.min(4.5, vu) / 20) - VU_LO) / (VU_HI - VU_LO); }
  function dbfs(v) { return 20 * Math.log10(Math.max(v, 1e-5)); }
  var VU_REF_DEFAULT = -14;
  function reelRadius(share) { return Math.sqrt(44 * 44 + share * (118 * 118 - 44 * 44)); }
  var TAPE = TAU * 1.25 * 44; // a hub-size pack turns ~1.25 rev/s
  var PLATTER = (100 / 3 / 60) * TAU; // 33 1/3 rpm in rad/s

  // ---------------------------------------------------------------------------
  // Text and drawing helpers.
  function str(v) { return v == null || (typeof v === "number" && !isFinite(v)) ? "" : String(v).trim(); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fmtTime(s) {
    s = isFinite(s) ? Math.max(0, Math.floor(s)) : 0;
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }
  function khz(rate) {
    var n = +rate;
    if (!(n > 0) || !isFinite(n)) return "";
    if (n >= 1000) n /= 1000;
    return String(Math.round(n * 10) / 10);
  }
  function bits(b) { var n = +b; return n > 0 && isFinite(n) ? String(Math.round(n)) : ""; }
  function formatText(codec, bd, rate) {
    var c = str(codec).toUpperCase(), nums = [bits(bd), khz(rate)].filter(Boolean).join(" / ");
    return [c, nums].filter(Boolean).join(" ");
  }
  function join(parts, sep) { return parts.filter(Boolean).join(sep); }

  function font(c, weight, size, family) { c.font = weight + " " + size + "px " + family; }
  function measure(c, t) { var w = c.measureText(t).width; return isFinite(w) ? w : 0; }
  // Set the font and return `text` shrunk (down to minScale) and then
  // ellipsised so it fits maxW. The fallback fonts are wider than the condensed
  // display face, so every free-length string goes through here.
  function fit(c, weight, size, family, text, maxW, minScale) {
    text = str(text);
    font(c, weight, size, family);
    if (!text || !(maxW > 0)) return text;
    var w = measure(c, text);
    if (w <= maxW) return text;
    var s = Math.max(size * (minScale || 0.6), size * maxW / w);
    font(c, weight, s, family);
    if (measure(c, text) <= maxW) return text;
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (measure(c, text.slice(0, mid).replace(/\s+$/, "") + "…") <= maxW) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo).replace(/\s+$/, "") + "…";
  }
  function addRR(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function rr(c, x, y, w, h, r) { c.beginPath(); addRR(c, x, y, w, h, r); }
  function circle(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); }
  function disc(c, x, y, r, fill) { circle(c, x, y, r); c.fillStyle = fill; c.fill(); }

  function makeCanvas(w, h) {
    var cv = null;
    try {
      var doc = root.document;
      if (doc && typeof doc.createElement === "function") cv = doc.createElement("canvas");
      else if (typeof root.OffscreenCanvas === "function") cv = new root.OffscreenCanvas(w, h);
      if (cv) { cv.width = w; cv.height = h; }
    } catch (e) { cv = null; }
    return cv;
  }

  // ---------------------------------------------------------------------------
  // Analogue VU meter, split into a static face and the moving needle + lamp.
  // A skin is the whole treatment of one face: face gradient, backlight, print,
  // red zone, needle, lamp, bezel, and the room it sits in (meters view).
  // bezel: one colour, or two for a top-to-bottom metal gradient. panel: a
  // surround drawn behind both meters on the meters view.
  var SKIN = {
    cream: { top: "#f6e3b0", bot: "#e2c27e", glow: "rgba(255,190,90,0.55)", ink: "#2b2114", red: "#c8321f", needle: "#141008", lampOff: "#8a5a3a", bezel: ["#1a1612"], bw: 0.025, label: "rgba(43,33,20,0.65)", bg: "#0e0c0a", bgGlow: "rgba(120,80,30,0.25)", title: "#f1e7d3", sub: "#a8926a", line: "#f2a93b" },
    blue: { top: "#0d2233", bot: "#06121c", glow: "rgba(80,180,255,0.45)", ink: "#8fd3ff", red: "#ff6b5a", needle: "#f3f7ff", lampOff: "#2a1512", bezel: ["#1b2630"], bw: 0.025, label: "rgba(143,211,255,0.7)", bg: "#05080b", bgGlow: "rgba(40,90,140,0.25)", title: "#e6f2ff", sub: "#6f9fc4", line: "#8fd3ff" },
    // 1970s receiver: black glass, warm lamp behind amber print.
    amber: { top: "#17110a", bot: "#070504", glow: "rgba(255,140,30,0.42)", ink: "#ffb24a", inkGlow: "rgba(255,150,40,0.75)", red: "#ff5b30", needle: "#ffe3b8", lampOff: "#3a1a0c", bezel: ["#4a4640", "#1c1a18"], bw: 0.03, label: "rgba(255,178,74,0.7)", bg: "#0a0806", bgGlow: "rgba(170,95,20,0.22)", title: "#ffdcaa", sub: "#c08a45", line: "#ffb24a" },
    // 1960s broadcast console: unlit off-white face, aged, in a satin-silver bezel.
    ivory: { top: "#f3ecd6", bot: "#e2d5ad", vignette: "rgba(176,140,60,0.22)", ink: "#161616", red: "#b8261a", needle: "#101010", lampOff: "#7a5a48", bezel: ["#eceded", "#8a8c90"], bw: 0.05, label: "rgba(22,22,22,0.6)", bg: "#1b1c1e", bgGlow: "rgba(210,205,190,0.08)", title: "#ecebe4", sub: "#a8a79f", line: "#d9d6cc" },
    // Test gear: grey-green face, phosphor-green print and glow.
    green: { top: "#1f2a23", bot: "#0e1611", glow: "rgba(80,255,130,0.22)", ink: "#7dff9f", inkGlow: "rgba(90,255,140,0.7)", red: "#e8ff5a", needle: "#d6ffe0", lampOff: "#23382a", bezel: ["#3a403b", "#1a1e1b"], bw: 0.035, scan: true, label: "rgba(125,255,159,0.6)", bg: "#050906", bgGlow: "rgba(40,150,70,0.16)", title: "#c9f7d4", sub: "#5fae78", line: "#7dff9f" },
    // Studio furniture: cream faces set in walnut, thin brass bezels.
    walnut: { top: "#f4e6c2", bot: "#dfca98", glow: "rgba(255,196,110,0.4)", ink: "#2a1f14", red: "#b33a22", needle: "#1a120a", lampOff: "#7a4a2a", bezel: ["#e4c46e", "#8a6a26"], bw: 0.02, panel: "walnut", label: "rgba(42,31,20,0.6)", bg: "#0f0905", bgGlow: "rgba(140,90,40,0.2)", title: "#efe0c0", sub: "#b0915f", line: "#c9a24e" },
    // 1970s tape deck: white faces in a brushed-aluminium faceplate, blue needle.
    silver: { top: "#fcfcfa", bot: "#e9e8e3", glow: "rgba(255,255,255,0.18)", ink: "#141414", red: "#d0281c", needle: "#2459c8", lampOff: "#8a8f96", bezel: ["#4d5157"], bw: 0.018, panel: "alu", label: "rgba(20,20,20,0.55)", bg: "#141619", bgGlow: "rgba(180,190,205,0.12)", title: "#e8ebef", sub: "#9aa3ad", line: "#9fc3ff" },
    // Field-recorder modulometer: black face, white print, two needles.
    modulo: { top: "#121213", bot: "#060607", glow: "rgba(255,255,255,0.05)", ink: "#f0f0ec", red: "#ff5a44", needle: "#f5f5f2", lampOff: "#3a1614", bezel: ["#9da1a6", "#4c4f54"], bw: 0.03, label: "rgba(240,240,236,0.6)" },
  };
  var METER_VARIANTS = [["cream", "Cream"], ["blue", "Blue glass"], ["amber", "Amber"], ["ivory", "Ivory"], ["green", "Green phosphor"], ["walnut", "Walnut"], ["silver", "Silver"]];
  // shadowBlur is in device pixels, not affected by the transform; the static
  // layer sets this to its scale so glows look the same at every size.
  var SHADOW_SCALE = 1;

  function vuFace(c, x, y, w, h, s, label) {
    c.save();
    rr(c, x, y, w, h, h * 0.06);
    var face = c.createLinearGradient(x, y, x, y + h);
    face.addColorStop(0, s.top); face.addColorStop(1, s.bot);
    c.fillStyle = face; c.fill();
    c.clip();
    if (s.glow) {
      var glow = c.createRadialGradient(x + w / 2, y + h * 1.05, h * 0.1, x + w / 2, y + h * 1.05, h * 1.1);
      glow.addColorStop(0, s.glow); glow.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = glow; c.fillRect(x, y, w, h);
    }
    if (s.vignette) {
      var vg = c.createRadialGradient(x + w / 2, y + h / 2, h * 0.25, x + w / 2, y + h / 2, w * 0.62);
      vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, s.vignette);
      c.fillStyle = vg; c.fillRect(x, y, w, h);
    }
    if (s.scan) {
      c.beginPath();
      for (var sy = y; sy < y + h; sy += h * 0.02) { c.moveTo(x, sy); c.lineTo(x + w, sy); }
      c.strokeStyle = "rgba(0,0,0,0.18)"; c.lineWidth = h * 0.006; c.stroke();
    }
    if (s.inkGlow) { c.shadowColor = s.inkGlow; c.shadowBlur = h * 0.03 * SHADOW_SCALE; }
    var cx = x + w / 2, cy = y + h * 1.02, R = h * 0.78, ink = s.ink, red = s.red;
    var ang = function (f) { return (-48 + 96 * f) * Math.PI / 180 - Math.PI / 2; };
    c.lineWidth = h * 0.012; c.strokeStyle = ink;
    c.beginPath(); c.arc(cx, cy, R, ang(0), ang(vuFrac(0))); c.stroke();
    c.lineWidth = h * 0.03; c.strokeStyle = red;
    c.beginPath(); c.arc(cx, cy, R + h * 0.01, ang(vuFrac(0)), ang(1)); c.stroke();
    font(c, 600, h * 0.075, SANS); c.textAlign = "center"; c.textBaseline = "middle";
    [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3].forEach(function (v) {
      var a = ang(vuFrac(v)), big = v === -20 || v === -10 || v === -5 || v === 0 || v === 3, len = R + h * (big ? 0.08 : 0.05);
      c.strokeStyle = v > 0 ? red : ink; c.lineWidth = h * (big ? 0.012 : 0.008);
      c.beginPath(); c.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); c.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); c.stroke();
      if (big || v === -7 || v === -3) {
        var tr = R + h * 0.15;
        c.fillStyle = v > 0 ? red : ink;
        c.fillText(v > 0 ? "+" + v : String(v), cx + Math.cos(a) * tr, cy + Math.sin(a) * tr);
      }
    });
    font(c, 800, h * 0.16, DISPLAY); c.fillStyle = ink; c.fillText("VU", cx, y + h * 0.66);
    c.shadowBlur = 0; c.shadowColor = "rgba(0,0,0,0)";
    if (label) { font(c, 500, h * 0.06, MONO); c.fillStyle = s.label; c.fillText(label, cx, y + h * 0.82); }
    disc(c, x + w * 0.9, y + h * 0.18, h * 0.035, s.lampOff);
    c.restore();
    c.save(); rr(c, x, y, w, h, h * 0.06);
    var bz = s.bezel[0];
    if (s.bezel.length > 1) { bz = c.createLinearGradient(x, y, x, y + h); bz.addColorStop(0, s.bezel[0]); bz.addColorStop(1, s.bezel[1]); }
    c.lineWidth = h * s.bw; c.strokeStyle = bz; c.stroke(); c.restore();
    c.textAlign = "left"; c.textBaseline = "alphabetic";
  }
  function vuNeedle(c, R, x, y, w, h, frac, s, peakOn, color) {
    if (peakOn) {
      var lx = x + w * 0.9, ly = y + h * 0.18;
      // Lamp glow from a cached gradient instead of shadowBlur (weak GPUs).
      c.fillStyle = R._grad("lamp" + lx + "," + ly, function () {
        var g = c.createRadialGradient(lx, ly, h * 0.03, lx, ly, h * 0.12);
        g.addColorStop(0, "rgba(255,74,54,0.6)"); g.addColorStop(1, "rgba(255,74,54,0)");
        return g;
      });
      circle(c, lx, ly, h * 0.12); c.fill();
      disc(c, lx, ly, h * 0.035, "#ff4a36");
    }
    var cx = x + w / 2, cy = y + h * 1.02, len = h * 0.85, b = h * Math.max(0.0125, s.bw / 2);
    var a = (-48 + 96 * clamp(frac, -0.03, 1.04)) * Math.PI / 180 - Math.PI / 2;
    c.save();
    c.beginPath(); c.rect(x + b, y + b, w - 2 * b, h - 2 * b); c.clip();
    c.strokeStyle = color || s.needle; c.lineWidth = h * 0.012; c.lineCap = "round";
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); c.stroke();
    c.restore();
  }
  // Brushed metal: a vertical gradient plus hairlines, clipped to the current path.
  function brushed(c, x, y, w, h, top, bot, step) {
    var g = c.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, top); g.addColorStop(0.5, bot); g.addColorStop(1, top);
    c.fillStyle = g; c.fill();
    c.save(); c.clip();
    [["rgba(255,255,255,0.10)", 0], ["rgba(0,0,0,0.06)", step / 2]].forEach(function (l) {
      c.beginPath();
      for (var yy = y + l[1]; yy < y + h; yy += step) { c.moveTo(x, yy); c.lineTo(x + w, yy); }
      c.strokeStyle = l[0]; c.lineWidth = 1; c.stroke();
    });
    c.restore();
  }
  function screw(c, x, y, r) {
    disc(c, x, y, r, "#8d9095");
    c.strokeStyle = "rgba(30,30,32,0.8)"; c.lineWidth = r * 0.28;
    c.beginPath(); c.moveTo(x - r * 0.65, y - r * 0.2); c.lineTo(x + r * 0.65, y + r * 0.2); c.stroke();
  }
  function timeLine(c, x, y, w, color, progress) {
    c.fillStyle = color; rr(c, x, y, Math.max(6, w * progress), 6, 3); c.fill();
  }
  function timeText(S) { return S.dur > 0 ? fmtTime(S.pos) + " / " + fmtTime(S.dur) : fmtTime(S.pos); }

  // ---------------------------------------------------------------------------
  // The views: `bg` fills the letterbox bars, `stat` draws into the cached
  // layer, `dyn` draws the moving parts every frame.
  var IMPL = {};

  IMPL.cassette = {
    bg: "#141517",
    stat: function (c, T) {
      var bg = c.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#232427"); bg.addColorStop(1, "#141517"); c.fillStyle = bg; c.fillRect(0, 0, W, H);
      c.strokeStyle = "rgba(255,255,255,0.025)"; c.lineWidth = 1; c.beginPath();
      for (var yy = 0; yy < H; yy += 4) { c.moveTo(0, yy); c.lineTo(W, yy); }
      c.stroke();
      rr(c, 250, 60, 1100, 640, 26); c.fillStyle = "#0b0b0c"; c.fill();
      rr(c, 290, 92, 1020, 580, 24); c.fillStyle = "#2c2d31"; c.fill();
      c.strokeStyle = "#3b3c41"; c.lineWidth = 3; c.stroke();
      [[320, 122], [1280, 122], [320, 642], [1280, 642], [800, 642]].forEach(function (s) {
        disc(c, s[0], s[1], 11, "#1b1b1e");
        c.strokeStyle = "#55565c"; c.lineWidth = 2; c.beginPath(); c.moveTo(s[0] - 7, s[1]); c.lineTo(s[0] + 7, s[1]); c.stroke();
      });
      rr(c, 350, 130, 900, 200, 10); c.fillStyle = "#efe6cf"; c.fill();
      c.fillStyle = "#d8642f"; c.fillRect(350, 260, 900, 22);
      c.fillStyle = "#e89a3c"; c.fillRect(350, 282, 900, 12);
      c.textBaseline = "alphabetic";
      font(c, 800, 88, DISPLAY); c.fillStyle = "#b8492f"; c.textAlign = "left"; c.fillText("A", 376, 238);
      font(c, 500, 22, MONO);
      var fw = T.fmt ? measure(c, T.fmt) + 24 : 0;
      c.fillStyle = "#6b5a3a"; c.textAlign = "right"; c.fillText(T.fmt, 1226, 168); c.textAlign = "left";
      c.fillStyle = "#1f2a44";
      c.fillText(fit(c, 700, 58, HAND, T.title, Math.max(300, 756 - fw), 0.6), 470, 200);
      c.fillText(fit(c, 400, 38, HAND, join([T.artist, T.album], " · "), 756, 0.7), 470, 246);
      rr(c, 470, 372, 660, 218, 18); c.fillStyle = "rgba(10,10,12,0.85)"; c.fill();
      rr(c, 250, 740, 300, 110, 12); c.fillStyle = "#0b0b0c"; c.fill();
      font(c, 500, 18, MONO); c.fillStyle = "#8b8f88"; c.fillText("COUNTER", 276, 776);
      vuFace(c, 880, 730, 220, 130, SKIN.cream, "L");
      vuFace(c, 1130, 730, 220, 130, SKIN.cream, "R");
    },
    dyn: function (c, S, T, v, R) {
      var cy = 480, lx = 590, rx = 1010, rL = reelRadius(1 - S.progress), rRt = reelRadius(S.progress);
      c.save(); rr(c, 470, 372, 660, 218, 18); c.clip();
      c.beginPath(); c.arc(lx, cy, rL, 0, TAU); c.moveTo(rx + rRt, cy); c.arc(rx, cy, rRt, 0, TAU);
      c.fillStyle = "#3a2618"; c.fill();
      c.beginPath();
      [[lx, rL], [rx, rRt]].forEach(function (p) {
        for (var k = p[1]; k > 46; k -= 6) { c.moveTo(p[0] + k, cy); c.arc(p[0], cy, k, 0, TAU); }
      });
      c.strokeStyle = "rgba(0,0,0,0.18)"; c.lineWidth = 1; c.stroke();
      c.strokeStyle = "#4a3120"; c.lineWidth = 3;
      c.beginPath(); c.moveTo(lx, cy + rL); c.lineTo(rx, cy + rRt); c.stroke();
      c.restore();
      [[lx, S.reelL], [rx, S.reelR]].forEach(function (p) {
        var x = p[0], a = p[1];
        disc(c, x, cy, 42, "#e9e6df");
        disc(c, x, cy, 24, "#2c2d31");
        c.beginPath();
        for (var k = 0; k < 6; k++) {
          var t = a + k * Math.PI / 3, co = Math.cos(t), si = Math.sin(t);
          var pts = [[-4, -26], [4, -26], [4, -14], [-4, -14]];
          for (var j = 0; j < 4; j++) {
            var px = x + pts[j][0] * co - pts[j][1] * si, py = cy + pts[j][0] * si + pts[j][1] * co;
            if (j) c.lineTo(px, py); else c.moveTo(px, py);
          }
          c.closePath();
        }
        c.fillStyle = "#e9e6df"; c.fill();
      });
      var n = String(Math.floor(S.pos * 2.72) % 1000);
      font(c, 500, 56, MONO); c.fillStyle = "#f2a93b"; c.fillText(("00" + n).slice(-3), 276, 830);
      font(c, 500, 34, MONO); c.fillStyle = "#cfcac0"; c.textAlign = "right";
      c.fillText(timeText(S), 850, 812); c.textAlign = "left";
      vuNeedle(c, R, 880, 730, 220, 130, S.vu[0].x, SKIN.cream, S.lamp[0]);
      vuNeedle(c, R, 1130, 730, 220, 130, S.vu[1].x, SKIN.cream, S.lamp[1]);
    },
  };

  function woodPanel(c, x, y, w, h) {
    rr(c, x, y, w, h, 22);
    var g = c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, "#5c3820"); g.addColorStop(0.5, "#4a2c18"); g.addColorStop(1, "#3a2212");
    c.fillStyle = g; c.fill();
    c.save(); c.clip();
    // Grain: long, slightly wavy lines of varying darkness.
    for (var i = 0, gy = y - 20; gy < y + h + 20; i++, gy += 7 + (i * 7) % 5) {
      c.beginPath(); c.moveTo(x, gy);
      c.bezierCurveTo(x + w * 0.3, gy + 10 * Math.sin(i), x + w * 0.6, gy - 8 * Math.cos(i * 1.3), x + w, gy + 6 * Math.sin(i * 0.7));
      c.strokeStyle = i % 3 ? "rgba(20,10,4,0.16)" : "rgba(255,210,160,0.06)"; c.lineWidth = 1 + (i % 4) * 0.6; c.stroke();
    }
    c.restore();
    rr(c, x, y, w, h, 22); c.strokeStyle = "rgba(0,0,0,0.5)"; c.lineWidth = 3; c.stroke();
  }

  IMPL.meters = {
    bg: "#0e0c0a",
    bgFor: function (v) { return (SKIN[v] || SKIN.cream).bg; },
    stat: function (c, T, variant) {
      var s = SKIN[variant] || SKIN.cream;
      c.fillStyle = s.bg; c.fillRect(0, 0, W, H);
      var g = c.createRadialGradient(W / 2, 380, 50, W / 2, 380, 900);
      g.addColorStop(0, s.bgGlow); g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      if (s.panel === "walnut") woodPanel(c, 62, 96, 1476, 508);
      if (s.panel === "alu") {
        rr(c, 62, 96, 1476, 508, 12); brushed(c, 62, 96, 1476, 508, "#dcdee1", "#a7abb0", 3);
        rr(c, 62, 96, 1476, 508, 12); c.strokeStyle = "rgba(0,0,0,0.45)"; c.lineWidth = 2; c.stroke();
        [[86, 120], [1514, 120], [86, 580], [1514, 580]].forEach(function (p) { screw(c, p[0], p[1], 9); });
      }
      vuFace(c, 110, 140, 650, 420, s, "LEFT");
      vuFace(c, 840, 140, 650, 420, s, "RIGHT");
      c.textAlign = "center"; c.textBaseline = "alphabetic";
      c.fillStyle = s.title;
      c.fillText(fit(c, 800, 64, DISPLAY, join([T.title.toUpperCase(), T.artist.toUpperCase()], "  ·  "), 1440, 0.6), W / 2, 690);
      c.fillStyle = "rgba(255,255,255,0.12)"; rr(c, 560, 790, 480, 6, 3); c.fill();
      c.textAlign = "left";
    },
    dyn: function (c, S, T, variant, R) {
      var s = SKIN[variant] || SKIN.cream;
      vuNeedle(c, R, 110, 140, 650, 420, S.vu[0].x, s, S.lamp[0]);
      vuNeedle(c, R, 840, 140, 650, 420, S.vu[1].x, s, S.lamp[1]);
      c.textAlign = "center";
      c.fillStyle = s.sub;
      c.fillText(fit(c, 500, 26, MONO, join([T.fmt, timeText(S)], "   "), 1440, 0.7), W / 2, 740);
      c.textAlign = "left";
      timeLine(c, 560, 790, 480, s.line, S.progress);
    },
  };

  function sheen(c, cx, cy) {
    if (typeof c.createConicGradient === "function") {
      var sh = c.createConicGradient(-0.6, cx, cy);
      [[0, 0], [0.08, 0.09], [0.16, 0], [0.5, 0], [0.58, 0.07], [0.66, 0], [1, 0]].forEach(function (s) {
        sh.addColorStop(s[0], "rgba(255,255,255," + s[1] + ")");
      });
      circle(c, cx, cy, 368); c.fillStyle = sh; c.fill();
      return;
    }
    // Older receivers: the same two light lobes as thin wedges.
    [[0.08, 0.09], [0.58, 0.07]].forEach(function (lobe) {
      for (var i = -8; i < 8; i++) {
        var t0 = lobe[0] + i * 0.01, a = lobe[1] * (1 - Math.abs(t0 + 0.005 - lobe[0]) / 0.08);
        c.fillStyle = "rgba(255,255,255," + Math.max(0, a).toFixed(4) + ")";
        c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, 368, -0.6 + t0 * TAU, -0.6 + (t0 + 0.01) * TAU); c.closePath(); c.fill();
      }
    });
  }

  // The record label: album art (or a neutral blank label) plus the side text,
  // centred on 0,0 with radius 118. Drawn into a sprite that rotates per frame.
  function drawLabel(c, img) {
    c.save();
    circle(c, 0, 0, 118); c.clip();
    var drawn = false;
    if (img) {
      try {
        var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, s = Math.min(iw, ih);
        if (s > 0) { c.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, -118, -118, 236, 236); drawn = true; }
      } catch (e) { drawn = false; }
    }
    if (!drawn) {
      c.fillStyle = "#2e2b27"; c.fillRect(-118, -118, 236, 236);
      c.strokeStyle = "rgba(239,230,207,0.16)"; c.lineWidth = 2;
      circle(c, 0, 0, 96); c.stroke(); circle(c, 0, 0, 40); c.stroke();
    }
    font(c, 600, 16, SANS); c.fillStyle = "#efe6cf"; c.textAlign = "center"; c.textBaseline = "alphabetic";
    c.fillText("SIDE A · 33⅓", 0, 100);
    c.restore();
  }

  IMPL.turntable = {
    bg: "#23150c",
    stat: function (c, T) {
      var bg = c.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#3d2818"); bg.addColorStop(1, "#23150c"); c.fillStyle = bg; c.fillRect(0, 0, W, H);
      c.strokeStyle = "rgba(0,0,0,0.12)"; c.lineWidth = 2; c.beginPath();
      for (var xx = -H; xx < W; xx += 18) { c.moveTo(xx, 0); c.bezierCurveTo(xx + 200, 300, xx + 60, 600, xx + 260, H); }
      c.stroke();
      var cx = 560, cy = 450;
      disc(c, cx, cy, 392, "#1a1a1a");
      disc(c, cx, cy, 372, "#0a0a0a");
      c.lineWidth = 1;
      [true, false].forEach(function (bright) {
        c.beginPath();
        for (var r = 360; r > 130; r -= 4) if ((r % 24 === 0) === bright) { c.moveTo(cx + r, cy); c.arc(cx, cy, r, 0, TAU); }
        c.strokeStyle = bright ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.022)"; c.stroke();
      });
      sheen(c, cx, cy);
      disc(c, 1070, 150, 58, "#2a2a2c");
      disc(c, 1070, 150, 30, "#b9b9bb");
      c.textAlign = "left"; c.textBaseline = "alphabetic";
      c.fillStyle = "#f3e9d6"; c.fillText(fit(c, 800, 96, DISPLAY, T.title.toUpperCase(), 500, 0.55), 1040, 560);
      c.fillStyle = "#e0cfb2"; c.fillText(fit(c, 500, 38, SANS, T.artist, 500, 0.7), 1042, 616);
      c.fillStyle = "#b39c7c"; c.fillText(fit(c, 400, 30, SANS, join([T.album, T.year], " · "), 500, 0.7), 1042, 660);
      c.fillStyle = "#c9b08a"; c.fillText(fit(c, 500, 26, MONO, T.fmt, 500, 0.7), 1042, 740);
    },
    dyn: function (c, S, T, v, R) {
      var cx = 560, cy = 450;
      c.save(); c.translate(cx, cy); c.rotate(S.platter);
      var sprite = R._labelSprite();
      if (sprite) c.drawImage(sprite, -118, -118, 236, 236); else drawLabel(c, R._artReady());
      c.restore();
      disc(c, cx, cy, 9, "#c9c9c9");
      // Tonearm: the stylus sits on the groove for the current position.
      var px = 1070, py = 150, L = 610, rg = 350 - (350 - 132) * S.progress;
      var dx = px - cx, dy = py - cy, d = Math.sqrt(dx * dx + dy * dy);
      var a = (rg * rg - L * L + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, rg * rg - a * a));
      var mx = cx + (a * dx) / d, my = cy + (a * dy) / d;
      var tx = mx + (hh * dy) / d, ty = my - (hh * dx) / d;
      c.lineCap = "round"; c.strokeStyle = "#d4d4d6"; c.lineWidth = 14;
      c.beginPath(); c.moveTo(px, py); c.lineTo(tx, ty); c.stroke();
      c.lineCap = "butt";
      var ang = Math.atan2(ty - py, tx - px);
      c.save(); c.translate(tx, ty); c.rotate(ang);
      c.fillStyle = "#1c1c1e"; c.fillRect(-18, -20, 58, 40);
      c.fillStyle = "#c8a24a"; c.fillRect(22, -8, 12, 16); c.restore();
      c.save(); c.translate(px, py); c.rotate(ang + Math.PI);
      c.fillStyle = "#3a3a3d"; c.fillRect(40, -26, 80, 52); c.restore();
      font(c, 500, 26, MONO); c.fillStyle = "#c9b08a"; c.fillText(timeText(S), 1042, 782);
    },
  };

  var SEG = 44, PX0 = 200, PX1 = 1440, PLO = -48, SEGW = (PX1 - PX0) / SEG;
  var SEG_RGB = ["120,214,140", "242,169,59", "255,74,54"], SEG_COL = [];
  for (var si = 0; si < SEG; si++) {
    var sdb = PLO + (si + 1) * (-PLO / SEG);
    SEG_COL.push(sdb > -3 ? 2 : sdb > -12 ? 1 : 0);
  }
  function segOf(db) { return Math.round(((clamp(isFinite(db) ? db : PLO, PLO, 0) - PLO) / -PLO) * SEG); }
  // Fill LED segments grouped by colour: one path + one fill per colour.
  function segs(c, y, test, alpha) {
    for (var col = 0; col < 3; col++) {
      var any = false;
      c.beginPath();
      for (var s = 0; s < SEG; s++) if (SEG_COL[s] === col && test(s)) { addRR(c, PX0 + s * SEGW + 3, y, SEGW - 6, 60, 4); any = true; }
      if (any) { c.fillStyle = alpha < 1 ? "rgba(" + SEG_RGB[col] + "," + alpha + ")" : "rgb(" + SEG_RGB[col] + ")"; c.fill(); }
    }
  }

  IMPL.peak = {
    bg: "#08090a",
    stat: function (c, T) {
      c.fillStyle = "#08090a"; c.fillRect(0, 0, W, H);
      c.textAlign = "left"; c.textBaseline = "alphabetic";
      font(c, 500, 26, MONO); c.fillStyle = "#6f756f"; c.fillText("NOW PLAYING", 160, 170);
      c.fillStyle = "#f2a93b"; c.textAlign = "right"; c.fillText(T.fmt, 1440, 170); c.textAlign = "left";
      c.fillStyle = "#f2efe8"; c.fillText(fit(c, 800, 150, DISPLAY, T.title.toUpperCase(), 1288, 0.5), 152, 318);
      c.fillStyle = "#b9bdb6"; c.fillText(fit(c, 500, 44, SANS, join([T.artist, T.album], " — "), 1280, 0.7), 160, 382);
      for (var i = 0; i < 2; i++) {
        var y = 520 + i * 110;
        font(c, 600, 34, MONO); c.fillStyle = "#8c918b"; c.fillText(i ? "R" : "L", 160, y + 44);
        segs(c, y, function () { return true; }, 0.1);
      }
      font(c, 500, 20, MONO); c.fillStyle = "#5d635d"; c.textAlign = "center";
      [-48, -36, -24, -18, -12, -6, -3, 0].forEach(function (db) { c.fillText(String(db), PX0 + ((db - PLO) / -PLO) * (PX1 - PX0), 780); });
      c.textAlign = "left";
      c.fillStyle = "rgba(255,255,255,0.08)"; rr(c, 160, 830, 1280, 6, 3); c.fill();
    },
    dyn: function (c, S) {
      for (var i = 0; i < 2; i++) {
        var lit = segOf(S.ppm[i].lvl), hold = segOf(S.ppm[i].hold);
        segs(c, 520 + i * 110, function (s) { return s < lit || s === hold - 1; }, 1);
      }
      font(c, 500, 26, MONO); c.fillStyle = "#6f756f"; c.textAlign = "right";
      c.fillText(timeText(S), 1440, 210); c.textAlign = "left";
      timeLine(c, 160, 830, 1280, "#f2a93b", S.progress);
    },
  };

  IMPL.signal = {
    bg: "#070a0d",
    stat: function (c, T) {
      c.fillStyle = "#070a0d"; c.fillRect(0, 0, W, H);
      c.strokeStyle = "rgba(120,160,190,0.06)"; c.lineWidth = 1; c.beginPath();
      for (var x = 0; x < W; x += 40) { c.moveTo(x, 0); c.lineTo(x, H); }
      for (var y = 0; y < H; y += 40) { c.moveTo(0, y); c.lineTo(W, y); }
      c.stroke();
      c.textAlign = "left"; c.textBaseline = "alphabetic";
      var cell = function (cx, maxW, label, big, unit) {
        font(c, 500, 22, MONO); c.fillStyle = "#6c8597"; c.fillText(label, cx, 190);
        if (!big) { big = "—"; unit = ""; }
        font(c, 500, 44, DISPLAY);
        var uw = unit ? measure(c, unit) + 12 : 0;
        c.fillStyle = "#eaf3f8"; big = fit(c, 700, 210, DISPLAY, big, maxW - uw, 0.4); c.fillText(big, cx - 6, 390);
        var bw = measure(c, big);
        if (unit) { font(c, 500, 44, DISPLAY); c.fillStyle = "#8fb7d0"; c.fillText(unit, cx + bw + 6, 390); }
      };
      cell(140, 480, "SAMPLE RATE", T.rate, "kHz");
      cell(660, 340, "BIT DEPTH", T.bits, "bit");
      cell(1040, 420, "CODEC", T.codec, "");
      var path = T.pathText || (T.out && T.fmt && T.out !== T.fmt ? T.fmt + "  →  " + T.out : "");
      if (path) { c.fillStyle = "#8fb7d0"; c.fillText(fit(c, 500, 26, MONO, path, 1320, 0.6), 140, 480); }
      c.fillStyle = "rgba(143,183,208,0.25)"; c.fillRect(140, 510, 1320, 2);
      c.fillStyle = "#eaf3f8"; c.fillText(fit(c, 800, 72, DISPLAY, T.title.toUpperCase(), 1320, 0.6), 140, 620);
      c.fillStyle = "#9fb4c2"; c.fillText(fit(c, 500, 34, SANS, join([T.artist, T.album], " · "), 1320, 0.7), 142, 670);
      for (var i = 0; i < 2; i++) {
        var yy = 740 + i * 38;
        font(c, 500, 22, MONO); c.fillStyle = "#6c8597"; c.fillText(i ? "R" : "L", 140, yy + 16);
        c.fillStyle = "rgba(143,183,208,0.12)"; c.fillRect(180, yy, 900, 18);
      }
      if (T.dr) { font(c, 500, 26, MONO); c.fillStyle = "#7fcf9a"; c.textAlign = "right"; c.fillText("DR " + T.dr, 1460, 800); c.textAlign = "left"; }
    },
    dyn: function (c, S) {
      c.fillStyle = "#8fd3ff";
      for (var i = 0; i < 2; i++) {
        var w = 900 * clamp(S.vu[i].x, 0, 1) * 0.9;
        if (w > 0) c.fillRect(180, 740 + i * 38, w, 18);
      }
      font(c, 500, 26, MONO); c.fillStyle = "#9fb4c2"; c.textAlign = "right";
      c.fillText(timeText(S), 1460, 760); c.textAlign = "left";
    },
  };

  // ---------------------------------------------------------------------------
  // Reel-to-reel field recorder. Supply reel left, take-up right; packs are
  // area-proportional like the cassette; tape runs from the supply pack round
  // a guide roller, past the heads and capstan, round a second roller to the
  // take-up pack. Tape speed is constant, so the smaller pack turns faster.
  var RL = { lx: 380, rx: 1220, cy: 275, F: 225, hub: 60, max: 210, roll: 20, ry: 540, rlx: 600 };
  var MOD = { x: 560, y: 626, w: 480, h: 232 };
  function reelPack(share) { return Math.sqrt(RL.hub * RL.hub + share * (RL.max * RL.max - RL.hub * RL.hub)); }
  var TAPE_REEL = TAU * 1.0 * RL.hub; // a hub-size pack turns ~1 rev/s (7½ ips on a small hub)
  // The crossed tangent from the pack (left of the tape) to the roller (right
  // of the tape): the tape leaves the pack's right side and meets the roller's
  // left side. Returns [p1x, p1y, p2x, p2y].
  function supplyTangent(r1) {
    var c1x = RL.lx, c1y = RL.cy, c2x = RL.rlx, c2y = RL.ry, r2 = RL.roll;
    var dx = c2x - c1x, dy = c2y - c1y, L = Math.sqrt(dx * dx + dy * dy), phi = Math.atan2(dy, dx);
    var best = null, score = -Infinity;
    [1, -1].forEach(function (s1) {
      var q = clamp((-s1 * r2 - s1 * r1) / L, -1, 1);
      [1, -1].forEach(function (sg) {
        var b = phi + sg * Math.acos(q), nx = Math.cos(b), ny = Math.sin(b);
        var p = [c1x - s1 * r1 * nx, c1y - s1 * r1 * ny, c2x + s1 * r2 * nx, c2y + s1 * r2 * ny];
        var sc = (p[0] - c1x) + (c2x - p[2]);
        if (sc > score) { score = sc; best = p; }
      });
    });
    return best;
  }
  function engrave(c, text, x, y) {
    c.fillStyle = "rgba(255,255,255,0.55)"; c.fillText(text, x, y + 1.5);
    c.fillStyle = "rgba(36,38,42,0.85)"; c.fillText(text, x, y);
  }
  function knob(c, x, y, r, a) {
    disc(c, x, y + 3, r, "rgba(0,0,0,0.25)");
    disc(c, x, y, r, "#2a2b2e");
    circle(c, x, y, r * 0.78); c.strokeStyle = "rgba(255,255,255,0.12)"; c.lineWidth = 2; c.stroke();
    c.strokeStyle = "#f0f0ec"; c.lineWidth = r * 0.14; c.lineCap = "round";
    c.beginPath(); c.moveTo(x + Math.cos(a) * r * 0.25, y + Math.sin(a) * r * 0.25); c.lineTo(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85); c.stroke();
    c.lineCap = "butt";
  }
  var CTR = { x: 112, y: 662, cw: 56, ch: 70, gap: 6, n: 4 };

  IMPL.reel = {
    bg: "#141517",
    stat: function (c, T) {
      c.fillStyle = "#141517"; c.fillRect(0, 0, W, H);
      rr(c, 30, 20, 1540, 860, 28); brushed(c, 30, 20, 1540, 860, "#d7d9dc", "#b3b6ba", 3);
      rr(c, 30, 20, 1540, 860, 28); c.strokeStyle = "rgba(0,0,0,0.5)"; c.lineWidth = 3; c.stroke();
      [[62, 52], [1538, 52], [62, 848], [1538, 848], [800, 52]].forEach(function (p) { screw(c, p[0], p[1], 9); });
      // Recesses under the reels and the spindles.
      [RL.lx, RL.rx].forEach(function (x) { disc(c, x, RL.cy + 6, RL.F + 8, "rgba(0,0,0,0.16)"); disc(c, x, RL.cy, RL.F + 2, "rgba(60,62,66,0.35)"); });
      // Head block: cover, three heads (erase, record, playback).
      rr(c, 650, 476, 300, 60, 10); c.fillStyle = "#26272a"; c.fill();
      [700, 790, 880].forEach(function (hx) { rr(c, hx - 20, 522, 40, 36, 5); c.fillStyle = "#c9ccd0"; c.fill(); c.fillStyle = "#6b6e73"; c.fillRect(hx - 2, 522, 4, 36); });
      // Guide rollers.
      [RL.rlx, W - RL.rlx].forEach(function (x) { disc(c, x, RL.ry, RL.roll + 4, "#5d6065"); disc(c, x, RL.ry, RL.roll - 6, "#cfd2d6"); disc(c, x, RL.ry, 4, "#3a3c40"); });
      c.textBaseline = "alphabetic";
      font(c, 600, 16, SANS); c.textAlign = "center";
      engrave(c, "SUPPLY", RL.lx, 530); engrave(c, "TAKE-UP", RL.rx, 530);
      // Modulometer: two needles, white = L, red = R.
      vuFace(c, MOD.x, MOD.y, MOD.w, MOD.h, SKIN.modulo, "");
      font(c, 600, MOD.h * 0.07, MONO); c.textAlign = "center";
      var ly = MOD.y + MOD.h * 0.84;
      c.fillStyle = SKIN.modulo.needle; c.fillText("L", MOD.x + MOD.w / 2 - 34, ly);
      c.fillStyle = "#ff4a36"; c.fillText("R", MOD.x + MOD.w / 2 + 34, ly);
      c.fillStyle = "rgba(240,240,236,0.5)"; c.fillRect(MOD.x + MOD.w / 2 - 22, ly - 12, 12, 2);
      c.fillStyle = "rgba(255,74,54,0.8)"; c.fillRect(MOD.x + MOD.w / 2 + 10, ly - 12, 12, 2);
      font(c, 600, 18, MONO); c.textAlign = "left"; engrave(c, "L  R", MOD.x + MOD.w + 18, MOD.y + MOD.h - 8);
      font(c, 600, 15, SANS); c.textAlign = "center"; engrave(c, "MODULATION", MOD.x + MOD.w / 2, MOD.y - 10); c.textAlign = "left";
      // Tape counter: four white wheels in a black window.
      rr(c, CTR.x - 12, CTR.y - 10, CTR.n * (CTR.cw + CTR.gap) - CTR.gap + 24, CTR.ch + 20, 8); c.fillStyle = "#101012"; c.fill();
      c.fillStyle = "#efeee8";
      for (var i = 0; i < CTR.n; i++) c.fillRect(CTR.x + i * (CTR.cw + CTR.gap), CTR.y, CTR.cw, CTR.ch);
      font(c, 600, 16, SANS); engrave(c, "COUNTER", CTR.x - 10, CTR.y - 22);
      // Input selector at LINE; speed selector at 7½ ips.
      knob(c, 440, 700, 34, -Math.PI / 4);
      font(c, 600, 16, SANS); c.textAlign = "center";
      engrave(c, "MIC", 392, 648); engrave(c, "LINE", 478, 648);
      knob(c, 1120, 818, 22, -Math.PI / 4);
      c.textAlign = "left"; font(c, 600, 20, SANS); engrave(c, "7½ ips", 1154, 826);
      font(c, 600, 14, SANS); engrave(c, "SPEED", 1100, 790);
      // Label strip: the track engraved on black anodised aluminium.
      rr(c, 1090, 618, 440, 146, 8); c.fillStyle = "#161719"; c.fill();
      c.strokeStyle = "rgba(255,255,255,0.18)"; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = "#ecebe6"; c.fillText(fit(c, 800, 46, DISPLAY, T.title.toUpperCase(), 400, 0.55), 1110, 668);
      c.fillStyle = "#b3b4b0"; c.fillText(fit(c, 500, 24, SANS, join([T.artist, T.album], " · "), 400, 0.7), 1110, 706);
      c.fillStyle = "#8e908c"; c.fillText(fit(c, 500, 20, MONO, T.fmt, 400, 0.7), 1110, 742);
    },
    dyn: function (c, S, T, v, R) {
      var rL = reelPack(1 - S.progress), rR = reelPack(S.progress), cy = RL.cy;
      // Packs, then the tape, then the flanges over both.
      c.beginPath(); c.arc(RL.lx, cy, rL, 0, TAU); c.moveTo(RL.rx + rR, cy); c.arc(RL.rx, cy, rR, 0, TAU);
      c.fillStyle = "#2b1e15"; c.fill();
      c.beginPath();
      [[RL.lx, rL], [RL.rx, rR]].forEach(function (p) { for (var k = p[1] - 7; k > RL.hub + 2; k -= 7) { c.moveTo(p[0] + k, cy); c.arc(p[0], cy, k, 0, TAU); } });
      c.strokeStyle = "rgba(255,255,255,0.05)"; c.lineWidth = 1; c.stroke();
      var a = supplyTangent(rL), b = supplyTangent(rR);
      var ta = Math.atan2(a[3] - RL.ry, a[2] - RL.rlx); if (ta < Math.PI / 2) ta += TAU;
      var tb = Math.atan2(b[3] - RL.ry, b[2] - RL.rlx); if (tb < Math.PI / 2) tb += TAU;
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(a[2], a[3]);
      c.arc(RL.rlx, RL.ry, RL.roll, ta, Math.PI / 2, true);
      c.lineTo(W - RL.rlx, RL.ry + RL.roll);
      c.arc(W - RL.rlx, RL.ry, RL.roll, Math.PI / 2, Math.PI - tb, true);
      c.lineTo(W - b[0], b[1]);
      c.strokeStyle = "#35251a"; c.lineWidth = 5; c.lineJoin = "round"; c.stroke();
      // Capstan above the tape, pinch roller below it.
      disc(c, 960, RL.ry + RL.roll + 20, 18, "#1b1b1d"); disc(c, 960, RL.ry + RL.roll + 20, 6, "#55585d");
      disc(c, 960, RL.ry + RL.roll - 7, 7, "#d9dbde");
      [[RL.lx, S.rrL], [RL.rx, S.rrR]].forEach(function (p) {
        var x = p[0], rot = p[1];
        c.beginPath(); c.arc(x, cy, RL.F, 0, TAU);
        for (var k = 0; k < 3; k++) {
          var a0 = rot + k * TAU / 3 - 0.55, a1 = a0 + 1.1;
          c.moveTo(x + Math.cos(a0) * 205, cy + Math.sin(a0) * 205);
          c.arc(x, cy, 205, a0, a1); c.arc(x, cy, 88, a1, a0, true); c.closePath();
        }
        c.fillStyle = R._grad("flange" + x, function () {
          var g = c.createRadialGradient(x - 40, cy - 60, 20, x, cy, RL.F);
          g.addColorStop(0, "#eef0f2"); g.addColorStop(1, "#a4a8ae");
          return g;
        });
        c.fill("evenodd");
        c.strokeStyle = "rgba(40,42,46,0.45)"; c.lineWidth = 1.5; c.stroke();
        disc(c, x, cy, 58, "#1f2023");
        disc(c, x, cy, 20, "#c7c9cc");
        c.beginPath();
        for (k = 0; k < 3; k++) {
          var t = rot + k * TAU / 3, co = Math.cos(t), si = Math.sin(t), pts = [[-5, -36], [5, -36], [5, -20], [-5, -20]];
          for (var j = 0; j < 4; j++) {
            var px = x + pts[j][0] * co - pts[j][1] * si, py = cy + pts[j][0] * si + pts[j][1] * co;
            if (j) c.lineTo(px, py); else c.moveTo(px, py);
          }
          c.closePath();
        }
        c.fillStyle = "#c7c9cc"; c.fill();
      });
      // Modulometer needles: red (R) under white (L).
      var lamp = S.lamp[0] || S.lamp[1];
      vuNeedle(c, R, MOD.x, MOD.y, MOD.w, MOD.h, S.vu[1].x, SKIN.modulo, lamp, "#ff4a36");
      vuNeedle(c, R, MOD.x, MOD.y, MOD.w, MOD.h, S.vu[0].x, SKIN.modulo, false);
      // Counter wheels: the units wheel rolls continuously; higher wheels turn
      // over only while every wheel below them shows 9, like the real thing.
      var val = Math.max(0, S.pos * 2.72) % 10000, frac = val - Math.floor(val), carry = true;
      c.save(); c.beginPath();
      for (var i = 0; i < CTR.n; i++) c.rect(CTR.x + i * (CTR.cw + CTR.gap), CTR.y, CTR.cw, CTR.ch);
      c.clip();
      font(c, 500, 50, MONO); c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "#151515";
      for (i = 0; i < CTR.n; i++) {
        var place = Math.pow(10, i), d = Math.floor(val / place) % 10, off = carry ? frac : 0;
        var wx = CTR.x + (CTR.n - 1 - i) * (CTR.cw + CTR.gap) + CTR.cw / 2, wy = CTR.y + CTR.ch / 2 - off * CTR.ch;
        c.fillText(String(d), wx, wy); c.fillText(String((d + 1) % 10), wx, wy + CTR.ch);
        carry = carry && d === 9;
      }
      c.restore();
      c.fillStyle = R._grad("ctr", function () {
        var g = c.createLinearGradient(0, CTR.y, 0, CTR.y + CTR.ch);
        g.addColorStop(0, "rgba(0,0,0,0.45)"); g.addColorStop(0.3, "rgba(0,0,0,0)"); g.addColorStop(0.7, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.45)");
        return g;
      });
      c.fillRect(CTR.x, CTR.y, CTR.n * (CTR.cw + CTR.gap) - CTR.gap, CTR.ch);
      c.textBaseline = "alphabetic"; c.textAlign = "left";
      font(c, 500, 24, MONO); c.fillStyle = "rgba(36,38,42,0.85)"; c.fillText(timeText(S), CTR.x - 10, 796);
    },
  };

  VIEWS[1].variants = METER_VARIANTS.map(function (m) { return { id: m[0], name: m[1] }; });

  function trackInfo(t) {
    t = t || {};
    return {
      title: str(t.title), artist: str(t.artist), album: str(t.album), year: str(t.year),
      fmt: formatText(t.codec, t.bitDepth, t.sampleRate),
      out: formatText(t.outCodec, t.outBitDepth, t.outSampleRate),
      rate: khz(t.outSampleRate) || khz(t.sampleRate),
      bits: bits(t.outBitDepth) || bits(t.bitDepth),
      codec: str(t.codec).toUpperCase(),
      pathText: str(t.pathText), dr: str(t.dr),
    };
  }

  // ---------------------------------------------------------------------------
  // The renderer instance.
  function now() { var p = root.performance; return p && typeof p.now === "function" ? p.now() : Date.now(); }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }

  function Display(canvas, opts) {
    opts = opts || {};
    var self = this;
    this._tick = function () { self._frame(); };
    this.canvas = canvas;
    this.maxFps = num(opts.maxFps, 60) > 0 ? num(opts.maxFps, 60) : 60;
    this.pxCap = num(opts.pixelRatioCap, 2) > 0 ? num(opts.pixelRatioCap, 2) : 2;
    this.ctx = null;
    try { this.ctx = canvas.getContext("2d", { alpha: false }) || canvas.getContext("2d"); } catch (e) { this.ctx = null; }
    this.T = trackInfo(null); this.trackKey = JSON.stringify(this.T);
    this.levels = null;
    this.anchor = { pos: 0, playing: false, t: now() };
    this.S = {
      pos: 0, dur: 0, progress: 0, playing: false, init: false,
      vu: [{ x: -0.02, v: 0 }, { x: -0.02, v: 0 }],
      ppm: [{ lvl: -60, hold: -60, holdT: 0 }, { lvl: -60, hold: -60, holdT: 0 }],
      lamp: [false, false], reelL: 0, reelR: 0, rrL: 0, rrR: 0, platter: 0,
    };
    this.grads = {}; this.layer = null; this.layerKey = ""; this.label = null; this.labelKey = "";
    this.fontGen = 0; this.art = null; this.artUrl = ""; this.artImg = null;
    this.raf = 0; this.timer = 0; this.lastT = 0; this.lastFrame = 0; this.dead = false; this.needSize = true;
    this.box = { bw: 0, bh: 0, lw: 0, lh: 0, ox: 0, oy: 0 };
    this.setView(opts.view, opts.variant);

    if (canvas.style && !canvas.style.width) { canvas.style.width = "100%"; canvas.style.height = "100%"; canvas.style.display = "block"; }
    this._onResize = function () { self.needSize = true; self._wake(); };
    this._onVis = function () { self._wake(); };
    this._onFonts = function () { self.fontGen++; self._wake(); };
    var target = canvas.parentElement || canvas;
    if (typeof root.ResizeObserver === "function") {
      this.ro = new root.ResizeObserver(this._onResize);
      this.ro.observe(target);
    } else if (typeof root.addEventListener === "function") root.addEventListener("resize", this._onResize);
    var doc = root.document;
    if (doc && typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", this._onVis);
    if (doc && doc.fonts) {
      if (doc.fonts.ready && typeof doc.fonts.ready.then === "function") doc.fonts.ready.then(this._onFonts, function () {});
      if (typeof doc.fonts.addEventListener === "function") doc.fonts.addEventListener("loadingdone", this._onFonts);
    }
    this._wake();
  }

  var P = Display.prototype;

  P.setTrack = function (t) {
    this.T = trackInfo(t);
    this.trackKey = JSON.stringify(this.T);
    var url = str(t && t.artworkUrl);
    if (url !== this.artUrl) this._loadArt(url);
    this._wake();
  };
  // Per-track VU calibration. A fixed studio alignment (0 VU = -14 dBFS)
  // pinned modern masters in the red, because they average near -8 dBFS; an
  // engineer pads the meter for such material and hi-fi displays scale to the
  // programme. So 0 VU sits at this track's 95th-percentile loudness (clamped
  // to -20..-6 dBFS): only the loudest passages reach the red.
  function vuReference(lv) {
    var all = [], i;
    for (i = 0; i < lv.rmsL.length; i++) if (lv.rmsL[i] > 0) all.push(lv.rmsL[i]);
    for (i = 0; i < lv.rmsR.length; i++) if (lv.rmsR[i] > 0) all.push(lv.rmsR[i]);
    if (all.length < 8) return VU_REF_DEFAULT;
    all.sort(function (a, b) { return a - b; });
    return clamp(dbfs(all[Math.floor(all.length * 0.95)]), -20, -6);
  }
  P.setLevels = function (lv) {
    this.levels = lv && lv.rmsL && lv.bucketSeconds > 0 ? lv : null;
    this.vuRef = this.levels ? vuReference(this.levels) : VU_REF_DEFAULT;
    this._wake();
  };
  P.setPosition = function (seconds, playing, duration) {
    var d = num(duration, 0);
    this.S.dur = d > 0 ? d : 0;
    this.anchor = { pos: Math.max(0, num(seconds, 0)), playing: !!playing, t: now() };
    this._wake();
  };
  P.setView = function (view, variant) {
    this.view = IMPL[view] ? view : "cassette";
    var def = VIEWS.filter(function (v) { return v.id === this.view; }, this)[0];
    var vs = def && def.variants ? def.variants.map(function (x) { return x.id; }) : [];
    this.variant = vs.length ? (vs.indexOf(variant) >= 0 ? variant : vs[0]) : "";
    this._wake();
  };
  P.destroy = function () {
    this.dead = true;
    if (this.raf && typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(this.raf);
    if (this.timer) root.clearTimeout(this.timer);
    this.raf = 0; this.timer = 0;
    if (this.ro) this.ro.disconnect();
    else if (typeof root.removeEventListener === "function") root.removeEventListener("resize", this._onResize);
    var doc = root.document;
    if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", this._onVis);
    if (doc && doc.fonts && typeof doc.fonts.removeEventListener === "function") doc.fonts.removeEventListener("loadingdone", this._onFonts);
    if (this.artImg) { this.artImg.onload = this.artImg.onerror = null; }
    this.layer = this.label = this.art = this.artImg = null; this.grads = {};
  };

  P._loadArt = function (url) {
    var self = this;
    if (this.artImg) this.artImg.onload = this.artImg.onerror = null;
    this.artUrl = url; this.art = null; this.artImg = null;
    if (!url || typeof root.Image !== "function") return;
    var img = new root.Image(); // no crossOrigin: pixels are never read back
    img.onload = function () {
      if (self.artImg !== img) return;
      if ((img.naturalWidth || img.width) > 0) self.art = img;
      self._wake();
    };
    img.onerror = function () { if (self.artImg === img) { self.art = null; self._wake(); } };
    this.artImg = img;
    img.src = url;
  };
  P._artReady = function () { return this.art; };

  P._grad = function (key, make) {
    var g = this.grads[key];
    if (!g) g = this.grads[key] = make();
    return g;
  };

  P._wake = function () {
    if (this.dead) return;
    var doc = root.document;
    if (doc && doc.hidden) return; // visibilitychange wakes us again
    if (this.timer) { root.clearTimeout(this.timer); this.timer = 0; }
    if (this.raf) return;
    this.raf = typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(this._tick) : root.setTimeout(this._tick, 16);
  };

  P._schedule = function (delay) {
    if (this.dead) return;
    var self = this;
    if (delay > 0) { this.timer = root.setTimeout(function () { self.timer = 0; self._wake(); }, delay); return; }
    this._wake();
  };

  P._frame = function () {
    this.raf = 0;
    if (this.dead) return;
    var doc = root.document;
    if (doc && doc.hidden) { this.lastT = 0; return; }
    var t = now();
    if (this.lastFrame && t - this.lastFrame < 1000 / this.maxFps - 2) { this._wake(); return; }
    this.lastFrame = t;
    var dt = this.lastT ? Math.min(0.25, Math.max(0, (t - this.lastT) / 1000)) : 0;
    this.lastT = t;
    if (this.needSize) this._measure();
    var dpos = this._advance(dt, t);
    var settled = this._physics(dt, dpos);
    this._draw();
    this._schedule(settled ? 250 : 0);
  };

  // Interpolate the position anchor. Small backward corrections (< 1.5 s) are
  // absorbed by slowing down, never by running backwards; larger differences
  // are real seeks and jump. Returns the position delta for the mechanics.
  P._advance = function (dt, t) {
    var S = this.S, A = this.anchor;
    var tp = A.pos + (A.playing ? Math.max(0, t - A.t) / 1000 : 0);
    if (S.dur > 0) tp = Math.min(tp, S.dur);
    // err is measured against where the local clock alone would put us.
    var prev = S.pos, err = tp - (S.pos + (A.playing ? dt : 0)), jumped = false;
    if (!S.init || Math.abs(err) >= 1.5) { S.pos = tp; jumped = true; S.init = true; }
    else if (A.playing) S.pos += Math.max(0, dt + err * Math.min(1, 3 * dt));
    else if (err > 0) S.pos += err * Math.min(1, 4 * dt);
    if (S.dur > 0) S.pos = Math.min(S.pos, S.dur);
    S.pos = Math.max(0, S.pos);
    S.playing = A.playing;
    S.progress = S.dur > 0 ? clamp(S.pos / S.dur, 0, 1) : 0;
    var dpos = jumped ? 0 : S.pos - prev;
    return Math.abs(dpos) > 60 ? 0 : dpos;
  };

  P._physics = function (dt, dpos) {
    var S = this.S, L = this.levels, playing = S.playing && !!L, settled = !S.playing && dpos === 0;
    var bucket = L ? L.bucketSeconds : 1;
    var rms = L ? [levelAt(L.rmsL, bucket, S.pos), levelAt(L.rmsR, bucket, S.pos)] : [0, 0];
    var pk = L ? [levelAt(L.peakL, bucket, S.pos), levelAt(L.peakR, bucket, S.pos)] : [0, 0];
    var steps = Math.max(1, Math.ceil(Math.min(dt, 0.1) / 0.0167)), h = Math.min(dt, 0.1) / steps;
    for (var c = 0; c < 2; c++) {
      var r = playing ? rms[c] : 0, p = playing ? pk[c] : 0;
      // VU: a lightly under-damped spring, ~300 ms to settle, a hair of overshoot.
      var vu = dbfs(r) - (this.vuRef == null ? VU_REF_DEFAULT : this.vuRef);
      var target = Math.max(-0.02, vuFrac(vu)), n = S.vu[c];
      for (var k = 0; k < steps; k++) {
        n.v += (150 * (target - n.x) - 21 * n.v) * h;
        n.x += n.v * h;
      }
      // Peak meter: instant attack, 20 dB per 0.65 s fall, 1 s peak hold. The
      // broadcast PPM fall (20 dB in 1.7 s) read as sluggish on a music display
      // (user, 2026-09-21); this is closer to hi-fi LED meters.
      var m = S.ppm[c], d = playing ? dbfs(p) : -60;
      m.lvl = d > m.lvl ? d : Math.max(d, m.lvl - (20 / 0.65) * dt);
      if (m.lvl >= m.hold) { m.hold = m.lvl; m.holdT = 1.0; }
      else if ((m.holdT -= dt) <= 0) m.hold = Math.max(m.lvl, m.hold - 16 * dt);
      // The lamp marks the needle driven well into the red, not every sample
      // peak: a brickwalled master peaks near 0 dBFS almost constantly.
      S.lamp[c] = playing && r > 0 && vu > 2;
      if (Math.abs(n.v) > 0.002 || Math.abs(n.x - target) > 0.001 || m.hold > PLO - 0.5) settled = false;
    }
    // Mechanics follow the position delta: a paused player is still.
    S.reelL = (S.reelL + (dpos * TAPE) / reelRadius(1 - S.progress)) % TAU;
    S.reelR = (S.reelR + (dpos * TAPE) / reelRadius(S.progress)) % TAU;
    S.rrL = (S.rrL + (dpos * TAPE_REEL) / reelPack(1 - S.progress)) % TAU;
    S.rrR = (S.rrR + (dpos * TAPE_REEL) / reelPack(S.progress)) % TAU;
    S.platter = (S.platter + dpos * PLATTER) % TAU;
    return settled;
  };

  P._measure = function () {
    this.needSize = false;
    var cv = this.canvas, el = cv.parentElement || cv;
    var cw = num(el.clientWidth, 0), ch = num(el.clientHeight, 0);
    var dpr = Math.min(this.pxCap, num(root.devicePixelRatio, 1) || 1);
    var bw = Math.max(0, Math.round(cw * dpr)), bh = Math.max(0, Math.round(ch * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    var s = Math.min(bw / W, bh / H), lw = Math.round(W * s), lh = Math.round(H * s);
    this.box = { bw: bw, bh: bh, lw: lw, lh: lh, ox: Math.floor((bw - lw) / 2), oy: Math.floor((bh - lh) / 2) };
  };

  P._staticLayer = function () {
    var b = this.box, key = [this.view, this.variant, b.lw, b.lh, this.trackKey, this.fontGen].join("|");
    if (key === this.layerKey) return this.layer;
    this.layerKey = key; this.layer = null;
    var cv = makeCanvas(b.lw, b.lh), c = null;
    try { c = cv && (cv.getContext("2d", { alpha: false }) || cv.getContext("2d")); } catch (e) { c = null; }
    if (!c) return null;
    c.setTransform(b.lw / W, 0, 0, b.lh / H, 0, 0);
    SHADOW_SCALE = b.lw / W;
    IMPL[this.view].stat(c, this.T, this.variant, this);
    SHADOW_SCALE = 1;
    this.layer = cv;
    return cv;
  };

  P._labelSprite = function () {
    var b = this.box, px = Math.max(1, Math.round(236 * b.lw / W));
    var key = [px, this.art ? this.artUrl : "", this.fontGen].join("|");
    if (key === this.labelKey) return this.label;
    this.labelKey = key; this.label = null;
    var cv = makeCanvas(px, px), c = null;
    try { c = cv && cv.getContext("2d"); } catch (e) { c = null; }
    if (!c) return null;
    c.setTransform(px / 236, 0, 0, px / 236, px / 2, px / 2);
    drawLabel(c, this.art);
    this.label = cv;
    return cv;
  };

  P._draw = function () {
    var c = this.ctx, b = this.box;
    if (!c || !(b.lw > 0) || !(b.lh > 0)) return;
    var V = IMPL[this.view];
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = V.bgFor ? V.bgFor(this.variant) : V.bg;
    if (b.ox > 0) { c.fillRect(0, 0, b.ox, b.bh); c.fillRect(b.ox + b.lw, 0, b.bw - b.ox - b.lw, b.bh); }
    if (b.oy > 0) { c.fillRect(0, 0, b.bw, b.oy); c.fillRect(0, b.oy + b.lh, b.bw, b.bh - b.oy - b.lh); }
    var layer = this._staticLayer();
    c.setTransform(b.lw / W, 0, 0, b.lh / H, b.ox, b.oy);
    c.textAlign = "left"; c.textBaseline = "alphabetic"; c.lineCap = "butt";
    if (layer) {
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(layer, b.ox, b.oy); c.restore();
    } else {
      c.save(); V.stat(c, this.T, this.variant, this); c.restore();
    }
    c.save();
    V.dyn(c, this.S, this.T, this.variant, this);
    c.restore();
  };

  return {
    VIEWS: VIEWS,
    decodeLevels: decodeLevels,
    formatText: formatText,
    create: function (canvas, opts) { return new Display(canvas, opts); },
  };
});
