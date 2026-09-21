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
    { id: "meters", name: "VU meters", description: "Two large analogue meters with the needles following the track's loudness at VU speed. The peak lamp lights on loud transients. Title and format sit quietly underneath." },
    { id: "peak", name: "Peak meter", description: "Studio-style LED bars for left and right with a held peak, and the title set large above them. The bars rise instantly and fall at broadcast speed, 20 dB in 1.7 seconds." },
    { id: "spectrum", name: "Spectrum analyser", description: "Sixteen frequency bands from 40 Hz to 10 kHz with falling peak caps, scaled to this track's loudness so a loud master does not pin the top." },
    { id: "signal", name: "Signal readout", description: "A hi-fi information screen: large readouts of rate, bit depth and codec, the path from source to player, and slim level bars." },
    { id: "lyrics", name: "Lyrics", description: "The words, in time with the music: the current line large, the lines around it smaller, scrolling as the track plays." },
    { id: "reel", name: "Reel-to-reel", description: "A portable reel-to-reel recorder. Tape runs from the supply reel past the heads to the take-up reel as the track plays, so the packs show how far in you are, and the smaller pack spins faster. A single modulation meter shows left and right as a white and a red needle." },
    { id: "clock", name: "Clock", description: "A standby screen: the time and date, with the track small at the bottom while something plays. It drifts slightly and dims when idle to spare the TV." },
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
  var VU_LAMP = vuFrac(1);
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
  // Is the condensed display face really there? Chromecast has none of the
  // web fonts, and its platform sans is far wider, so titles set in DISPLAY
  // may shrink further there before they are ellipsised. Measured, not
  // document.fonts.check(), which answers true for fonts it has never heard of.
  var FONT_GEN = 0, displayGen = -1, displayOk = true;
  function displayFace() {
    if (displayGen === FONT_GEN) return displayOk;
    displayGen = FONT_GEN; displayOk = true;
    try {
      var cv = makeCanvas(4, 4), x = cv && cv.getContext("2d");
      if (x) {
        x.font = "800 64px monospace"; var a = x.measureText("HAMBURGEFONTIV").width;
        x.font = '800 64px "Big Shoulders Display", monospace'; var b = x.measureText("HAMBURGEFONTIV").width;
        displayOk = Math.abs(a - b) > 0.5;
      }
    } catch (e) { displayOk = true; }
    return displayOk;
  }
  function fit(c, weight, size, family, text, maxW, minScale) {
    text = str(text);
    if (family === DISPLAY && !displayFace()) minScale = (minScale || 0.6) * 0.75;
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
    modulo: { top: "#141312", bot: "#070606", glow: "rgba(255,190,120,0.16)", ink: "#f0f0ec", red: "#ff5a44", needle: "#f5f5f2", lampOff: "#3a1614", bezel: ["#9da1a6", "#4c4f54"], bw: 0.03, label: "rgba(240,240,236,0.6)" },
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

  // ---------------------------------------------------------------------------
  // Cassette decks. Every variant shares the cassette itself (drawn in the
  // classic view's coordinates and placed by a translate + scale), the packs
  // and reel speeds, the counter and the calibrated meters; each has its own
  // cached scene around it.
  function casShell(c, T, clear) {
    rr(c, 290, 92, 1020, 580, 24); c.fillStyle = clear ? "rgba(46,48,54,0.62)" : "#2c2d31"; c.fill();
    c.strokeStyle = clear ? "rgba(120,124,132,0.8)" : "#3b3c41"; c.lineWidth = 3; c.stroke();
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
    rr(c, 470, 372, 660, 218, 18); c.fillStyle = clear ? "rgba(10,10,12,0.7)" : "rgba(10,10,12,0.85)"; c.fill();
  }
  function casReels(c, S) {
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
  }
  function counterText(S) { var n = String(Math.floor(S.pos * 2.72) % 1000); return ("00" + n).slice(-3); }
  function counterBox(c, x, y, w, h, label, ink) {
    rr(c, x, y, w, h, 12); c.fillStyle = "#0b0b0c"; c.fill();
    c.strokeStyle = "rgba(255,255,255,0.14)"; c.lineWidth = 1.2; c.stroke();
    font(c, 500, 16, MONO); c.fillStyle = ink || "#8b8f88"; c.textAlign = "left"; c.fillText(label || "COUNTER", x + 20, y + 28);
  }
  // Soft-touch transport keys with drawn icons (no glyph fonts needed).
  function icon(c, kind, x, y, s, col) {
    c.fillStyle = col; c.beginPath();
    var tri = function (x0, dir) { c.moveTo(x0, y - s); c.lineTo(x0 + dir * s * 1.3, y); c.lineTo(x0, y + s); c.closePath(); };
    if (kind === "play") tri(x - s * 0.6, 1);
    else if (kind === "ff") { tri(x - s * 1.3, 1); tri(x, 1); }
    else if (kind === "rew") { tri(x + s * 1.3, -1); tri(x, -1); }
    else if (kind === "stop") c.rect(x - s, y - s, 2 * s, 2 * s);
    else if (kind === "pause") { c.rect(x - s, y - s, s * 0.7, 2 * s); c.rect(x + s * 0.3, y - s, s * 0.7, 2 * s); }
    else if (kind === "rec") c.arc(x, y, s, 0, TAU);
    else if (kind === "eject") { c.moveTo(x - s, y + s * 0.2); c.lineTo(x, y - s); c.lineTo(x + s, y + s * 0.2); c.closePath(); c.rect(x - s, y + s * 0.5, 2 * s, s * 0.45); }
    c.fill();
  }
  var KEYS = ["rew", "play", "ff", "stop", "pause", "rec"];
  function keyRow(c, x, y, w, h, gap, dark, down) {
    KEYS.forEach(function (k, i) {
      var kx = x + i * (w + gap), pressed = k === down;
      c.save(); c.shadowColor = "rgba(0,0,0,0.45)"; c.shadowBlur = (pressed ? 3 : 8) * SHADOW_SCALE; c.shadowOffsetY = (pressed ? 1 : 4) * SHADOW_SCALE;
      rr(c, kx, y + (pressed ? 3 : 0), w, h, 10);
      var g = c.createLinearGradient(0, y, 0, y + h);
      if (dark) { g.addColorStop(0, pressed ? "#1d1e21" : "#3a3c41"); g.addColorStop(1, "#141517"); }
      else { g.addColorStop(0, pressed ? "#c9ccd1" : "#f4f5f6"); g.addColorStop(1, "#b6bac0"); }
      c.fillStyle = g; c.fill(); c.restore();
      icon(c, k, kx + w / 2, y + h / 2 + (pressed ? 3 : 0), h * 0.16, k === "rec" ? "#c8321f" : dark ? "#d9dadd" : "#2b2d31");
      if (pressed) { disc(c, kx + w - 14, y + 14, 3.5, "#6dff8e"); }
    });
  }
  // Chrome piano-key levers, seen from above.
  function pianoKeys(c, x, y, w, h, gap, down) {
    KEYS.concat(["eject"]).forEach(function (k, i) {
      var kx = x + i * (w + gap), pressed = k === down, ky = y + (pressed ? 14 : 0);
      c.save(); c.shadowColor = "rgba(0,0,0,0.5)"; c.shadowBlur = 10 * SHADOW_SCALE; c.shadowOffsetY = (pressed ? 2 : 7) * SHADOW_SCALE;
      rr(c, kx, ky, w, h, 8);
      var g = c.createLinearGradient(kx, 0, kx + w, 0);
      g.addColorStop(0, "#7c8087"); g.addColorStop(0.3, "#f6f7f8"); g.addColorStop(0.55, "#b9bdc3"); g.addColorStop(1, "#6d7178");
      c.fillStyle = g; c.fill(); c.restore();
      c.fillStyle = "rgba(0,0,0,0.12)"; c.fillRect(kx + 4, ky + h * 0.62, w - 8, 2);
      icon(c, k, kx + w / 2, ky + h * 0.8, 10, k === "rec" ? "#c8321f" : "#2b2d31");
    });
  }
  function smokedDoor(c, x, y, w, h, well) {
    c.save(); c.shadowColor = "rgba(0,0,0,0.5)"; c.shadowBlur = 16 * SHADOW_SCALE; c.shadowOffsetY = 6 * SHADOW_SCALE;
    rr(c, x, y, w, h, 16);
    var g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#35373c"); g.addColorStop(0.5, "#1a1b1e"); g.addColorStop(1, "#0d0e10");
    c.fillStyle = g; c.fill(); c.restore();
    rr(c, x + 1, y + 1, w - 2, h - 2, 15); c.strokeStyle = "rgba(255,255,255,0.18)"; c.lineWidth = 1; c.stroke();
    rr(c, x + 30, y + 28, w - 60, h - 56, 10); c.fillStyle = well; c.fill();
  }
  function glassOver(c, R, key, x, y, w, h, tint) {
    rr(c, x, y, w, h, 10);
    c.fillStyle = tint; c.fill();
    c.fillStyle = R._grad(key, function () {
      var g = c.createLinearGradient(x, y, x + w * 0.6, y + h);
      g.addColorStop(0, "rgba(255,255,255,0.14)"); g.addColorStop(0.4, "rgba(255,255,255,0.03)"); g.addColorStop(0.41, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(255,255,255,0)");
      return g;
    });
    c.fill();
  }
  function trackBlock(c, T, x, y, w, dark, big) {
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    c.fillStyle = dark ? "#1f2124" : "#eceae5"; c.fillText(fit(c, 800, big || 52, DISPLAY, T.title.toUpperCase(), w, 0.55), x, y);
    c.fillStyle = dark ? "#44474c" : "#b4b2ac"; c.fillText(fit(c, 500, 26, SANS, join([T.artist, T.album], " · "), w, 0.7), x, y + 40);
    c.fillStyle = dark ? "#5b5e63" : "#8d8b86"; c.fillText(fit(c, 500, 20, MONO, T.fmt, w, 0.7), x, y + 74);
  }
  function jack(c, x, y, label) {
    metal(c, x, y, 16, "#f2f3f5", "#6d7178"); disc(c, x, y, 7, "#070708");
    font(c, 600, 14, SANS); c.textAlign = "center"; c.fillStyle = "#a9abae"; c.fillText(label, x, y + 38); c.textAlign = "left";
  }
  // VFD (fluorescent display) peak bars, on the peak view's calibrated scale.
  var VFD = { x: 960, w: 540, n: 24, h: 22, ys: [300, 346] };
  var VFD_CYAN = "#5ff2ff", VFD_RED = "#ff6a5a";
  function vfdSegs(c, y, test, cyan, red) {
    var sw = VFD.w / VFD.n;
    [0, 1].forEach(function (z) {
      c.beginPath();
      var any = false;
      for (var s = 0; s < VFD.n; s++) {
        var lower = PLO + s * ((PHI - PLO) / VFD.n);
        if ((lower >= -1e-9 ? 1 : 0) === z && test(s)) { c.rect(VFD.x + s * sw + 2, y, sw - 4, VFD.h); any = true; }
      }
      if (any) { c.fillStyle = z ? red : cyan; c.fill(); }
    });
  }
  function vfdOf(db) { return Math.round(((clamp(isFinite(db) ? db : PLO, PLO, PHI) - PLO) / (PHI - PLO)) * VFD.n); }

  var CAS = {
    classic: {
      bg: "#141517", tf: [0, 0, 1], meters: [[880, 730, 220, 130, "L"], [1130, 730, 220, 130, "R"]], skin: "cream",
      counter: [276, 830, 56, "#f2a93b"], time: [850, 812, 34, "#cfcac0"],
      stat: function (c, T) {
        var bg = c.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, "#232427"); bg.addColorStop(1, "#141517"); c.fillStyle = bg; c.fillRect(0, 0, W, H);
        c.strokeStyle = "rgba(255,255,255,0.025)"; c.lineWidth = 1; c.beginPath();
        for (var yy = 0; yy < H; yy += 4) { c.moveTo(0, yy); c.lineTo(W, yy); }
        c.stroke();
        rr(c, 250, 60, 1100, 640, 26); c.fillStyle = "#0b0b0c"; c.fill();
        casShell(c, T, false);
        counterBox(c, 250, 740, 300, 110);
      },
    },
    silver: {
      bg: "#121314", tf: [-29.8, 60.96, 0.62], meters: [[880, 90, 310, 200, "LEFT"], [1220, 90, 310, 200, "RIGHT"]], skin: "cream",
      counter: [906, 402, 48, "#f2a93b"], time: [1530, 400, 30, "#2c2e33"],
      over: function (c, R) { glassOver(c, R, "door", 140, 108, 660, 424, "rgba(38,30,22,0.22)"); },
      stat: function (c, T) {
        c.fillStyle = "#121314"; c.fillRect(0, 0, W, H);
        rr(c, 40, 40, 1520, 820, 18); brushed(c, 40, 40, 1520, 820, "#dcdee1", "#aeb2b7", 3);
        rr(c, 40, 40, 1520, 820, 18); c.strokeStyle = "rgba(0,0,0,0.5)"; c.lineWidth = 2; c.stroke();
        smokedDoor(c, 110, 80, 720, 480, "#0b0b0c");
        c.save(); c.translate(-29.8, 60.96); c.scale(0.62, 0.62); casShell(c, T, false); c.restore();
        keyRow(c, 110, 600, 110, 64, 12, false, "play");
        counterBox(c, 880, 330, 230, 92);
        font(c, 600, 14, SANS); c.fillStyle = "#4b4e53"; c.fillText("STEREO CASSETTE DECK", 880, 470);
        trackBlock(c, T, 880, 530, 650, true);
        knob(c, 1300, 760, 34, -0.6); knob(c, 1400, 760, 34, -0.9);
        font(c, 600, 13, SANS); c.textAlign = "center"; c.fillStyle = "#4b4e53";
        c.fillText("REC LEVEL L", 1300, 818); c.fillText("REC LEVEL R", 1400, 818);
        jack(c, 1490, 760, "PHONES");
        c.textAlign = "left";
      },
    },
    black: {
      bg: "#09090a", tf: [-29.8, 60.96, 0.62], meters: null, vfd: true,
      over: function (c, R) { glassOver(c, R, "doorB", 140, 108, 660, 424, "rgba(8,8,10,0.16)"); },
      stat: function (c, T) {
        c.fillStyle = "#09090a"; c.fillRect(0, 0, W, H);
        rr(c, 40, 40, 1520, 820, 14); brushed(c, 40, 40, 1520, 820, "#2b2c30", "#151619", 3);
        rr(c, 40, 40, 1520, 820, 14); c.strokeStyle = "rgba(255,255,255,0.12)"; c.lineWidth = 1.2; c.stroke();
        // The well is lit from inside; the shell is smoked clear.
        var wl = c.createRadialGradient(470, 330, 30, 470, 330, 420);
        wl.addColorStop(0, "#8c7e68"); wl.addColorStop(0.6, "#3a342c"); wl.addColorStop(1, "#121110");
        smokedDoor(c, 110, 80, 720, 480, wl);
        c.save(); c.translate(-29.8, 60.96); c.scale(0.62, 0.62); casShell(c, T, true); c.restore();
        keyRow(c, 110, 600, 110, 64, 12, true, "play");
        // VFD panel.
        rr(c, 880, 90, 650, 330, 12); c.fillStyle = "#040607"; c.fill();
        c.strokeStyle = "rgba(255,255,255,0.1)"; c.lineWidth = 1; c.stroke();
        c.save(); c.shadowColor = "rgba(95,242,255,0.8)"; c.shadowBlur = 8 * SHADOW_SCALE;
        font(c, 600, 18, MONO); c.fillStyle = VFD_CYAN; c.textAlign = "left";
        c.fillText("NR B/C", 910, 130); c.fillText("TAPE: METAL", 1030, 130); c.fillText("3 HEAD", 1210, 130); c.fillText("MONITOR: TAPE", 1330, 130);
        font(c, 500, 22, MONO); c.fillText("L", 930, VFD.ys[0] + 19); c.fillText("R", 930, VFD.ys[1] + 19);
        font(c, 500, 14, MONO); c.textAlign = "center";
        [-30, -20, -10, -6, -3, 0, 3, 6].forEach(function (db) {
          c.fillStyle = db >= 0 ? VFD_RED : VFD_CYAN;
          c.fillText(db > 0 ? "+" + db : String(db), VFD.x + ((db - PLO) / (PHI - PLO)) * VFD.w, 396);
        });
        c.restore();
        VFD.ys.forEach(function (y) { vfdSegs(c, y, function () { return true; }, "rgba(95,242,255,0.08)", "rgba(255,106,90,0.08)"); });
        c.textAlign = "left";
        trackBlock(c, T, 880, 530, 650, false);
        knob(c, 1300, 760, 34, -0.6); knob(c, 1400, 760, 34, -0.9);
        font(c, 600, 13, SANS); c.textAlign = "center"; c.fillStyle = "#8a8c90";
        c.fillText("REC LEVEL", 1300, 818); c.fillText("BALANCE", 1400, 818);
        jack(c, 1490, 760, "PHONES");
        c.textAlign = "left";
      },
    },
    topload: {
      bg: "#0d0a08", tf: [5.8, 55.4, 0.68], meters: [[975, 80, 460, 270, "LEFT"], [975, 380, 460, 270, "RIGHT"]], skin: "cream",
      counter: [1000, 752, 44, "#f2a93b"], time: [1435, 740, 28, "#2c2e33"],
      stat: function (c, T) {
        c.fillStyle = "#0d0a08"; c.fillRect(0, 0, W, H);
        woodPanel(c, 20, 40, 120, 820); woodPanel(c, 1460, 40, 120, 820);
        rr(c, 140, 40, 1320, 820, 8); brushed(c, 140, 40, 1320, 820, "#d2d4d7", "#a8acb1", 3);
        rr(c, 140, 40, 1320, 820, 8); c.strokeStyle = "rgba(0,0,0,0.45)"; c.lineWidth = 2; c.stroke();
        rr(c, 180, 80, 740, 470, 14);
        var wg = c.createLinearGradient(0, 80, 0, 550);
        wg.addColorStop(0, "#050505"); wg.addColorStop(1, "#18181a");
        c.fillStyle = wg; c.fill();
        c.strokeStyle = "rgba(255,255,255,0.5)"; c.lineWidth = 1.2; c.stroke();
        c.save(); c.translate(5.8, 55.4); c.scale(0.68, 0.68); casShell(c, T, false); c.restore();
        pianoKeys(c, 190, 590, 92, 220, 12, "play");
        counterBox(c, 975, 690, 210, 84);
        trackBlock(c, T, 975, 808, 470, true, 34);
      },
    },
    portable: {
      bg: "#0e0f10", tf: [-7.9, 117.3, 0.66], meters: [[960, 520, 280, 170, ""]], skin: "modulo", twoNeedles: true,
      counter: [1290, 690, 36, "#f2a93b"], time: [1450, 745, 22, "#b9bbbe"],
      over: function (c, R) { glassOver(c, R, "lid", 170, 150, 700, 440, "rgba(20,22,26,0.2)"); },
      stat: function (c, T) {
        var rnd = prng(5), i;
        c.fillStyle = "#0e0f10"; c.fillRect(0, 0, W, H);
        c.save(); c.shadowColor = "rgba(0,0,0,0.7)"; c.shadowBlur = 40 * SHADOW_SCALE; c.shadowOffsetY = 18 * SHADOW_SCALE;
        rr(c, 80, 60, 1440, 780, 60);
        var bg = c.createLinearGradient(0, 60, 0, 840);
        bg.addColorStop(0, "#35373b"); bg.addColorStop(1, "#1c1d20");
        c.fillStyle = bg; c.fill(); c.restore();
        // Rubberised texture: a fine speckle.
        c.save(); rr(c, 80, 60, 1440, 780, 60); c.clip();
        c.beginPath();
        for (i = 0; i < 2400; i++) { var px = 80 + rnd() * 1440, py = 60 + rnd() * 780; c.rect(px, py, 1.2, 1.2); }
        c.fillStyle = "rgba(255,255,255,0.05)"; c.fill(); c.restore();
        rr(c, 82, 62, 1436, 776, 58); c.strokeStyle = "rgba(255,255,255,0.14)"; c.lineWidth = 2; c.stroke();
        smokedDoor(c, 140, 122, 760, 496, "#0b0b0c");
        c.save(); c.translate(-7.9, 117.3); c.scale(0.66, 0.66); casShell(c, T, false); c.restore();
        keyRow(c, 140, 660, 116, 56, 12, true, "play");
        // Speaker grille.
        metal(c, 1210, 290, 196, "#2a2c30", "#131416");
        c.beginPath();
        for (var gy = -180; gy <= 180; gy += 14) for (var gx = -180; gx <= 180; gx += 14) {
          var ox = gx + ((gy / 14) % 2 ? 7 : 0);
          if (ox * ox + gy * gy < 176 * 176) { c.moveTo(1210 + ox + 3.2, 290 + gy); c.arc(1210 + ox, 290 + gy, 3.2, 0, TAU); }
        }
        c.fillStyle = "#070708"; c.fill();
        circle(c, 1210, 290, 196); c.strokeStyle = "rgba(255,255,255,0.16)"; c.lineWidth = 2; c.stroke();
        font(c, 600, 14, SANS); c.fillStyle = "#a9abae"; c.textAlign = "center"; c.fillText("LEVEL", 1100, 712); c.textAlign = "left";
        counterBox(c, 1270, 630, 180, 80, "COUNTER");
        jack(c, 1300, 555, "PHONES"); jack(c, 1400, 555, "MIC");
        trackBlock(c, T, 960, 752, 470, false, 32);
      },
    },
  };
  var CAS_VARIANTS = [["classic", "Classic"], ["silver", "Silver deck"], ["black", "Black three-head"], ["topload", "Top loader"], ["portable", "Portable"]];

  IMPL.cassette = {
    bg: "#141517",
    bgFor: function (v) { return (CAS[v] || CAS.classic).bg; },
    stat: function (c, T, v) {
      var V = CAS[v] || CAS.classic, sk = SKIN[V.skin] || SKIN.cream;
      V.stat(c, T);
      (V.meters || []).forEach(function (m) { vuFace(c, m[0], m[1], m[2], m[3], sk, m[4]); });
      if (V.twoNeedles) {
        var m = V.meters[0], ly = m[1] + m[3] * 0.84;
        font(c, 600, m[3] * 0.07, MONO); c.textAlign = "center";
        c.fillStyle = sk.needle; c.fillText("L", m[0] + m[2] / 2 - 24, ly);
        c.fillStyle = "#ff4a36"; c.fillText("R", m[0] + m[2] / 2 + 24, ly); c.textAlign = "left";
      }
    },
    dyn: function (c, S, T, v, R) {
      var V = CAS[v] || CAS.classic, sk = SKIN[V.skin] || SKIN.cream;
      c.save(); c.translate(V.tf[0], V.tf[1]); c.scale(V.tf[2], V.tf[2]); casReels(c, S); c.restore();
      if (V.over) V.over(c, R);
      if (V.meters && V.twoNeedles) {
        var m = V.meters[0];
        vuNeedle(c, R, m[0], m[1], m[2], m[3], S.vu[1].x, sk, S.lamp[0] || S.lamp[1], "#ff4a36");
        vuNeedle(c, R, m[0], m[1], m[2], m[3], S.vu[0].x, sk, false);
      } else if (V.meters) V.meters.forEach(function (m, i) { vuNeedle(c, R, m[0], m[1], m[2], m[3], S.vu[i].x, sk, S.lamp[i]); });
      if (V.vfd) {
        c.save(); c.shadowColor = "rgba(95,242,255,0.7)"; c.shadowBlur = 0;
        for (var i = 0; i < 2; i++) {
          var lit = vfdOf(S.ppm[i].lvl), hold = vfdOf(S.ppm[i].hold);
          vfdSegs(c, VFD.ys[i], function (s) { return s < lit || s === hold - 1; }, VFD_CYAN, VFD_RED);
        }
        c.restore();
        font(c, 500, 64, MONO); c.textAlign = "left"; c.fillStyle = "rgba(95,242,255,0.18)"; c.fillText(counterText(S), 909, 232);
        c.fillStyle = VFD_CYAN; c.fillText(counterText(S), 910, 230);
        font(c, 500, 30, MONO); c.textAlign = "right"; c.fillText(timeText(S), 1500, 228); c.textAlign = "left";
        return;
      }
      var ct = V.counter, tm = V.time;
      font(c, 500, ct[2], MONO); c.fillStyle = ct[3]; c.textAlign = "left"; c.fillText(counterText(S), ct[0], ct[1]);
      font(c, 500, tm[2], MONO); c.fillStyle = tm[3]; c.textAlign = "right"; c.fillText(timeText(S), tm[0], tm[1]); c.textAlign = "left";
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

  // ---------------------------------------------------------------------------
  // Turntable: a high-end deck on a graphite plinth. Everything that is round
  // and centred (platter rim, turning marks, grooves, sheen, strobe dots) looks
  // the same at any rotation, so it lives in the cached layer; per frame only
  // the label, the clamp, the arm and the time are drawn.
  //
  // Geometry: spindle C, arm pivot P, pivot-to-stylus L. The stylus sits where
  // the circle of radius L round P meets the groove circle round C, so the arm
  // really tracks the groove from lead-in (304) to run-out (140).
  var TT = { cx: 520, cy: 450, px: 905, py: 235, L: 470, rIn: 304, rOut: 140, park: 440, rec: 320, plat: 345, lab: 108 };
  var TT_POD = { x: 175, y: 150, r: 46, pul: 15 };
  // 108 dots: 33⅓ rpm turns exactly one pitch per 1/60 s and two per 1/30 s.
  var STROBE_N = 108, STROBE_PITCH = TAU / STROBE_N;
  function armTip(rg) {
    var dx = TT.px - TT.cx, dy = TT.py - TT.cy, d = Math.sqrt(dx * dx + dy * dy);
    var a = (rg * rg - TT.L * TT.L + d * d) / (2 * d), h = Math.sqrt(Math.max(0, rg * rg - a * a));
    var mx = TT.cx + (a * dx) / d, my = TT.cy + (a * dy) / d;
    return [mx - (h * dy) / d, my + (h * dx) / d];
  }
  function grooveRadius(S) { return S.dur > 0 ? TT.rIn - (TT.rIn - TT.rOut) * S.progress : TT.park; }

  function sheen(c, cx, cy, r) {
    if (typeof c.createConicGradient === "function") {
      var sh = c.createConicGradient(-0.6, cx, cy);
      [[0, 0], [0.08, 0.09], [0.16, 0], [0.5, 0], [0.58, 0.07], [0.66, 0], [1, 0]].forEach(function (s) {
        sh.addColorStop(s[0], "rgba(255,255,255," + s[1] + ")");
      });
      circle(c, cx, cy, r); c.fillStyle = sh; c.fill();
      return;
    }
    // Older receivers: the same two light lobes as thin wedges.
    [[0.08, 0.09], [0.58, 0.07]].forEach(function (lobe) {
      for (var i = -8; i < 8; i++) {
        var t0 = lobe[0] + i * 0.01, a = lobe[1] * (1 - Math.abs(t0 + 0.005 - lobe[0]) / 0.08);
        c.fillStyle = "rgba(255,255,255," + Math.max(0, a).toFixed(4) + ")";
        c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, r, -0.6 + t0 * TAU, -0.6 + (t0 + 0.01) * TAU); c.closePath(); c.fill();
      }
    });
  }
  // Rings from r0 down to r1, alternating two strokes (one path each).
  function rings(c, cx, cy, r0, r1, step, a, b) {
    [a, b].forEach(function (col, k) {
      if (!col) return;
      c.beginPath();
      for (var r = r0 - k * step; r > r1; r -= 2 * step) { c.moveTo(cx + r, cy); c.arc(cx, cy, r, 0, TAU); }
      c.strokeStyle = col; c.lineWidth = step * 0.55; c.stroke();
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
      circle(c, 0, 0, 96); c.stroke(); circle(c, 0, 0, 58); c.stroke();
    }
    font(c, 600, 15, SANS); c.fillStyle = "#efe6cf"; c.textAlign = "center"; c.textBaseline = "alphabetic";
    c.fillText("SIDE A · 33⅓", 0, 100);
    c.restore();
  }

  // Up to `max` lines of `text` in the current font within maxW; the last line
  // is ellipsised if it still does not fit.
  function wrapLines(c, text, maxW, max) {
    var words = str(text).split(/\s+/).filter(Boolean), lines = [], cur = "";
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + " " + words[i] : words[i];
      if (!cur || measure(c, t) <= maxW) { cur = t; continue; }
      lines.push(cur); cur = words[i];
      if (lines.length === max - 1) { cur = words.slice(i).join(" "); break; }
    }
    if (cur) lines.push(cur);
    var last = lines.length - 1;
    if (last >= 0 && measure(c, lines[last]) > maxW) {
      var s = lines[last];
      while (s.length > 1 && measure(c, s + "…") > maxW) s = s.slice(0, -1);
      lines[last] = s.replace(/\s+$/, "") + "…";
    }
    return lines;
  }

  // The tonearm is one rigid body (as on a real arm: the headshell offset is
  // fixed), drawn once into a sprite in its own frame (pivot at 0,0, stylus at
  // (L,0)) and rotated per frame. That lets it carry real gradients and fine
  // detail at no per-frame cost. A blurred silhouette sprite is its shadow.
  var ARM = { x0: -200, y0: -90, w: 700, h: 150, off: 0.39 };
  function cyl(c, x0, x1, r, stops) {
    // A horizontal cylinder from x0 to x1 of radius r, lit from above.
    var g = c.createLinearGradient(0, -r, 0, r);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    c.fillStyle = g; c.fillRect(Math.min(x0, x1), -r, Math.abs(x1 - x0), 2 * r);
  }
  var STEEL = [[0, "#2a2c30"], [0.25, "#aeb3ba"], [0.38, "#f4f6f8"], [0.55, "#8d9299"], [1, "#1c1d20"]];
  var ALLOY = [[0, "#55595f"], [0.22, "#c9ccd1"], [0.34, "#ffffff"], [0.5, "#b7bbc1"], [0.85, "#6d7178"], [1, "#3e4146"]];
  var BLACK = [[0, "#0b0b0c"], [0.3, "#4a4c51"], [0.42, "#6c6f75"], [0.6, "#232427"], [1, "#08080a"]];
  function drawArm(c, flat, style) {
    var L = TT.L, ca = Math.cos(ARM.off), sa = Math.sin(ARM.off);
    var HS = 1.5, nx = L - ca * 64 * HS, ny = -sa * 64 * HS, tl = Math.sqrt(nx * nx + ny * ny), ta = Math.atan2(ny, nx);
    var F = function (fn) { if (flat) { c.fillStyle = "#000"; fn(true); } else fn(false); };
    // Rear stub, decoupling ring and stepped counterweight.
    F(function (f) {
      if (f) { c.fillRect(-176, -4.5, 160, 9); rr(c, -150, -28, 90, 56, 6); c.fill(); return; }
      cyl(c, -176, -18, 4.5, STEEL);
      cyl(c, -68, -58, 15, BLACK);
      cyl(c, -80, -68, 22, STEEL);
      cyl(c, -138, -80, 28, STEEL);
      cyl(c, -150, -138, 21, STEEL);
      // Knurling on the main mass, and machined step lines.
      c.beginPath();
      for (var k = -136; k < -82; k += 2.4) { c.moveTo(k, -28); c.lineTo(k, 28); }
      c.strokeStyle = "rgba(0,0,0,0.22)"; c.lineWidth = 0.9; c.stroke();
      c.beginPath(); [-138, -80, -68].forEach(function (k) { c.moveTo(k, -28); c.lineTo(k, 28); });
      c.strokeStyle = "rgba(0,0,0,0.55)"; c.lineWidth = 1.2; c.stroke();
      c.fillStyle = "rgba(255,255,255,0.18)"; c.fillRect(-150, -2, 0.8, 4);
    });
    // Tapered tube with its collars, in the tube's own frame. The wood deck
    // has an S-shaped tube ending in a detachable headshell's collar.
    c.save(); c.rotate(ta);
    if (style === "wood") F(function (f) {
      var sCurve = function () { c.beginPath(); c.moveTo(20, 0); c.bezierCurveTo(tl * 0.3, 42, tl * 0.6, -38, tl - 14, 0); };
      c.lineCap = "round";
      sCurve(); c.strokeStyle = f ? "#000" : "#50545b"; c.lineWidth = 13; c.stroke();
      if (!f) {
        sCurve(); c.strokeStyle = "#c9ccd2"; c.lineWidth = 9.5; c.stroke();
        c.save(); c.translate(0, -2.4); sCurve(); c.strokeStyle = "rgba(255,255,255,0.92)"; c.lineWidth = 2.2; c.stroke(); c.restore();
      }
      c.lineCap = "butt";
      if (f) { c.fillRect(tl - 18, -8, 22, 16); return; }
      cyl(c, 18, 40, 9.5, STEEL);
      c.save(); c.translate(tl - 8, 0); cyl(c, -12, -2, 8, BLACK); cyl(c, -2, 8, 7, STEEL); c.fillStyle = "rgba(0,0,0,0.4)"; c.fillRect(-2.5, -7, 1, 14); c.restore();
    });
    else F(function (f) {
      c.beginPath(); c.moveTo(20, -7.5); c.lineTo(tl, -4.5); c.lineTo(tl, 4.5); c.lineTo(20, 7.5); c.closePath();
      if (f) { c.fill(); return; }
      var g = c.createLinearGradient(0, -7.5, 0, 7.5);
      ALLOY.forEach(function (s) { g.addColorStop(s[0], s[1]); });
      c.fillStyle = g; c.fill();
      // Specular streak along the length, narrowing with the taper.
      c.beginPath(); c.moveTo(22, -3.6); c.lineTo(tl - 2, -2.2); c.lineTo(tl - 2, -1.4); c.lineTo(22, -2.2); c.closePath();
      c.fillStyle = "rgba(255,255,255,0.9)"; c.fill();
      cyl(c, 18, 40, 9.5, STEEL);
      c.save(); c.translate(tl - 8, 0); cyl(c, -6, 8, 6.2, STEEL); c.restore();
    });
    c.restore();
    // Gimbal yoke with its bearings (the housing base is in the static layer).
    F(function (f) {
      rr(c, -26, -32, 52, 64, 14);
      if (f) { c.fill(); return; }
      var g = c.createLinearGradient(-26, -32, 26, 32);
      g.addColorStop(0, "#5a5e65"); g.addColorStop(0.45, "#1d1e22"); g.addColorStop(1, "#0f1012");
      c.fillStyle = g; c.fill();
      c.strokeStyle = "rgba(255,255,255,0.28)"; c.lineWidth = 1; c.stroke();
      [-24, 24].forEach(function (by) {
        disc(c, 0, by, 8, "#c9ccd1"); circle(c, 0, by, 5.5); c.strokeStyle = "rgba(0,0,0,0.45)"; c.stroke();
        disc(c, 0, by, 2.4, "#2a2b2e");
      });
      var cap = c.createRadialGradient(-5, -5, 1, 0, 0, 15);
      cap.addColorStop(0, "#ffffff"); cap.addColorStop(0.4, "#c3c7cc"); cap.addColorStop(1, "#5d6167");
      disc(c, 0, 0, 15, cap);
      c.beginPath(); [11, 7].forEach(function (r) { c.moveTo(r, 0); c.arc(0, 0, r, 0, TAU); });
      c.strokeStyle = "rgba(0,0,0,0.25)"; c.lineWidth = 0.8; c.stroke();
      [[-16, -26], [16, -26], [-16, 26], [16, 26]].forEach(function (p) { disc(c, p[0], p[1], 2.2, "#9ea2a8"); });
    });
    // Headshell, cartridge and finger lift, in the cartridge's frame (stylus at 0,0).
    c.save(); c.translate(L, 0); c.rotate(ARM.off); c.scale(HS, HS);
    F(function (f) {
      if (f) {
        rr(c, -64, -8, 52, 16, 4); c.fill(); rr(c, -46, -11, 42, 22, 4); c.fill();
        c.fillRect(-26, -40, 4, 32);
        return;
      }
      // Leads from the pins back to the tube.
      [["#d8352a", -6], ["#2fa24a", -2], ["#2f6fd8", 2], ["#e9e9e9", 6]].forEach(function (w) {
        c.strokeStyle = w[0]; c.lineWidth = 1.1;
        c.beginPath(); c.moveTo(-47, w[1]); c.bezierCurveTo(-54, w[1], -56, w[1] * 0.4, -63, w[1] * 0.25); c.stroke();
        c.fillStyle = "#e0c070"; c.fillRect(-50, w[1] - 0.8, 4, 1.6);
      });
      // Cartridge body: chamfered, dark, with a machined top plate.
      c.beginPath();
      c.moveTo(-46, -8); c.lineTo(-43, -11); c.lineTo(-9, -11); c.lineTo(-4, -6); c.lineTo(-4, 6); c.lineTo(-9, 11); c.lineTo(-43, 11); c.lineTo(-46, 8); c.closePath();
      var bg = c.createLinearGradient(0, -11, 0, 11);
      bg.addColorStop(0, "#3b3d42"); bg.addColorStop(0.3, "#16171a"); bg.addColorStop(1, "#070708");
      c.fillStyle = bg; c.fill();
      c.strokeStyle = "rgba(255,255,255,0.22)"; c.lineWidth = 0.8; c.stroke();
      c.fillStyle = "#c9a45c"; c.fillRect(-12, -9, 3, 18);
      // Cantilever and stylus, touching the groove at 0,0.
      c.strokeStyle = "#d7c28a"; c.lineWidth = 1.4; c.lineCap = "round";
      c.beginPath(); c.moveTo(-6, 0); c.lineTo(-0.6, 0); c.stroke(); c.lineCap = "butt";
      disc(c, 0, 0, 1.5, "#ffffff");
      // Slim headshell plate over the body, with slots and two hex screws.
      rr(c, -64, -8, 52, 16, 4);
      var hg = c.createLinearGradient(0, -8, 0, 8);
      ALLOY.forEach(function (s) { hg.addColorStop(s[0], s[1]); });
      c.fillStyle = hg; c.fill();
      c.strokeStyle = "rgba(0,0,0,0.35)"; c.lineWidth = 0.8; c.stroke();
      [-40, -22].forEach(function (sx) {
        rr(c, sx - 5, -2, 10, 4, 2); c.fillStyle = "rgba(0,0,0,0.5)"; c.fill();
        c.beginPath();
        for (var k = 0; k < 6; k++) { var a = k * Math.PI / 3; c[k ? "lineTo" : "moveTo"](sx + Math.cos(a) * 3, Math.sin(a) * 3); }
        c.closePath(); c.fillStyle = "#e6e8eb"; c.fill();
      });
      // Finger lift on the outer side.
      c.strokeStyle = "#b9bdc3"; c.lineWidth = 3; c.lineCap = "round";
      c.beginPath(); c.moveTo(-24, -8); c.lineTo(-24, -30); c.quadraticCurveTo(-24, -40, -16, -40); c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.8)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(-25, -10); c.lineTo(-25, -30); c.stroke(); c.lineCap = "butt";
    });
    c.restore();
  }

  // Polished metal: an anisotropic conic sweep, or a diagonal linear sweep
  // where conic gradients are missing (Chromecast's Chrome 92).
  function metalSweep(c, cx, cy, r) {
    var stops = [[0, "#8d9197"], [0.1, "#eef0f2"], [0.22, "#8a8e94"], [0.5, "#6f7379"], [0.6, "#d6d9dd"], [0.72, "#7c8086"], [1, "#8d9197"]];
    var g = typeof c.createConicGradient === "function" ? c.createConicGradient(-2.2, cx, cy) : c.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    return g;
  }
  // The belt's two straight runs, pulley to platter: [[px, py, qx, qy] x2].
  function beltPts() {
    var pd = TT_POD, dx = TT.cx - pd.x, dy = TT.cy - pd.y, Ld = Math.sqrt(dx * dx + dy * dy), phi = Math.atan2(dy, dx);
    var bq = Math.acos((TT.plat + 1 - pd.pul) / Ld);
    return [1, -1].map(function (sg) {
      var b = phi + Math.PI + sg * bq, nx = Math.cos(b), ny = Math.sin(b);
      return [pd.x + nx * pd.pul, pd.y + ny * pd.pul, TT.cx + nx * (TT.plat + 1), TT.cy + ny * (TT.plat + 1)];
    });
  }
  var TT_VARIANTS = [["modern", "Modern"], ["wood", "Wood classic"]];

  IMPL.turntable = {
    bg: "#0a0a0b",
    bgFor: function (v) { return v === "wood" ? "#0c0806" : "#0a0a0b"; },
    stat: function (c, T, v, R) {
      var C = [TT.cx, TT.cy], i, wood = v === "wood";
      c.fillStyle = wood ? "#0c0806" : "#0a0a0b"; c.fillRect(0, 0, W, H);
      var lg = c.createRadialGradient(560, 360, 60, 560, 420, 980);
      lg.addColorStop(0, wood ? "rgba(120,96,74,0.3)" : "rgba(92,96,104,0.34)"); lg.addColorStop(0.55, "rgba(40,36,32,0.16)"); lg.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = lg; c.fillRect(0, 0, W, H);
      if (wood) {
      // Wood classic: a walnut plinth with real grain under a satin lacquer.
      c.save();
      c.shadowColor = "rgba(0,0,0,0.8)"; c.shadowBlur = 70 * SHADOW_SCALE; c.shadowOffsetY = 36 * SHADOW_SCALE;
      rr(c, 90, 80, 1000, 752, 18); c.fillStyle = "#1c0f07"; c.fill();
      c.restore();
      rr(c, 90, 62, 1000, 752, 18);
      var wg = c.createLinearGradient(90, 62, 1090, 814);
      wg.addColorStop(0, "#6a3d20"); wg.addColorStop(0.45, "#4e2b15"); wg.addColorStop(1, "#331b0c");
      c.fillStyle = wg; c.fill();
      c.save(); rr(c, 90, 62, 1000, 752, 18); c.clip();
      var rnd = prng(29);
      for (i = 0; i < 150; i++) {
        var gy = 40 + i * 5.4 + rnd() * 3, amp = 6 + rnd() * 14, ph = rnd() * 6;
        c.beginPath(); c.moveTo(90, gy);
        c.bezierCurveTo(350, gy + amp * Math.sin(ph), 700, gy - amp * Math.cos(ph * 1.3), 1090, gy + amp * 0.6 * Math.sin(ph * 0.7));
        c.strokeStyle = i % 5 === 0 ? "rgba(255,200,150,0.07)" : i % 3 ? "rgba(25,10,3,0.22)" : "rgba(20,8,2,0.1)";
        c.lineWidth = 0.8 + rnd() * 1.8; c.stroke();
      }
      // A few figure knots in the grain.
      [[260, 700], [980, 180], [1010, 720]].forEach(function (k) {
        c.beginPath();
        for (var e = 0; e < 5; e++) { c.moveTo(k[0] + 26 + e * 9, k[1]); c.ellipse(k[0], k[1], 26 + e * 9, 8 + e * 3, 0.1, 0, TAU); }
        c.strokeStyle = "rgba(25,10,3,0.18)"; c.lineWidth = 1.2; c.stroke();
      });
      // Satin lacquer: a broad soft highlight, stronger near the top edge.
      var lq = c.createLinearGradient(90, 62, 700, 814);
      lq.addColorStop(0, "rgba(255,230,200,0.16)"); lq.addColorStop(0.35, "rgba(255,230,200,0.04)"); lq.addColorStop(1, "rgba(0,0,0,0.12)");
      c.fillStyle = lq; c.fillRect(90, 62, 1000, 752);
      c.restore();
      rr(c, 92, 64, 996, 748, 17); c.strokeStyle = "rgba(255,225,190,0.28)"; c.lineWidth = 1.5; c.stroke();
      // Chrome trim along the front edge.
      var tr = c.createLinearGradient(0, 796, 0, 812);
      tr.addColorStop(0, "#f4f5f7"); tr.addColorStop(0.5, "#8d9198"); tr.addColorStop(1, "#d9dce0");
      c.fillStyle = tr; c.fillRect(110, 798, 960, 10);
      // Dust-cover hinges at the back.
      [300, 880].forEach(function (hx) {
        c.save(); c.shadowColor = "rgba(0,0,0,0.55)"; c.shadowBlur = 8 * SHADOW_SCALE; c.shadowOffsetY = 4 * SHADOW_SCALE;
        rr(c, hx - 42, 58, 84, 24, 5);
        var hg = c.createLinearGradient(0, 58, 0, 82);
        hg.addColorStop(0, "#f2f3f5"); hg.addColorStop(0.5, "#8a8e95"); hg.addColorStop(1, "#c7cad0");
        c.fillStyle = hg; c.fill(); c.restore();
        c.fillStyle = "rgba(0,0,0,0.35)"; c.fillRect(hx - 1, 60, 2, 20);
        [hx - 28, hx + 28].forEach(function (sx) { metal(c, sx, 70, 3.5, "#ffffff", "#6d7178"); });
      });
      } else {
      // Plinth: a thick graphite slab seen slightly from above (front face below the top).
      c.save();
      c.shadowColor = "rgba(0,0,0,0.75)"; c.shadowBlur = 70 * SHADOW_SCALE; c.shadowOffsetY = 36 * SHADOW_SCALE;
      rr(c, 90, 80, 1000, 752, 26); c.fillStyle = "#0e0f11"; c.fill();
      c.restore();
      rr(c, 90, 62, 1000, 752, 26);
      var top = c.createLinearGradient(90, 62, 1090, 814);
      top.addColorStop(0, "#2a2c30"); top.addColorStop(0.6, "#1b1c1f"); top.addColorStop(1, "#141517");
      c.fillStyle = top; c.fill();
      rr(c, 93, 65, 994, 746, 24);
      var bev = c.createLinearGradient(90, 62, 520, 814);
      bev.addColorStop(0, "rgba(255,255,255,0.3)"); bev.addColorStop(1, "rgba(255,255,255,0.03)");
      c.strokeStyle = bev; c.lineWidth = 2; c.stroke();
      // Motor pod and belt (the belt runs round the platter's edge, under it).
      var pd = TT_POD, dx = C[0] - pd.x, dy = C[1] - pd.y, Ld = Math.sqrt(dx * dx + dy * dy), phi = Math.atan2(dy, dx);
      var bq = Math.acos((TT.plat + 1 - pd.pul) / Ld), pts = [];
      [1, -1].forEach(function (sg) {
        var b = phi + Math.PI + sg * bq, nx = Math.cos(b), ny = Math.sin(b);
        pts.push([pd.x + nx * pd.pul, pd.y + ny * pd.pul, C[0] + nx * (TT.plat + 1), C[1] + ny * (TT.plat + 1)]);
      });
      disc(c, pd.x + 6, pd.y + 12, pd.r, "rgba(0,0,0,0.45)");
      disc(c, pd.x, pd.y, pd.r, "#1d1e21");
      circle(c, pd.x, pd.y, pd.r - 2); c.strokeStyle = "rgba(255,255,255,0.22)"; c.lineWidth = 2; c.stroke();
      rings(c, pd.x, pd.y, pd.r - 8, pd.pul + 4, 2, "rgba(255,255,255,0.05)", null);
      c.strokeStyle = "rgba(190,192,198,0.6)"; c.lineWidth = 3; c.beginPath();
      pts.forEach(function (p) { c.moveTo(p[0], p[1]); c.lineTo(p[2], p[3]); });
      c.stroke();
      c.beginPath(); c.arc(pd.x, pd.y, pd.pul, phi + Math.PI - bq, phi + Math.PI + bq); c.stroke();
      disc(c, pd.x, pd.y, pd.pul - 1, "#c9ccd1"); disc(c, pd.x, pd.y, 5, "#2a2b2e");
      }
      if (wood) {
      // Heavy platter: a deep side band, a polished chrome rim, a ribbed rubber mat.
      disc(c, C[0] + 3, C[1] + 18, TT.plat + 3, "rgba(0,0,0,0.55)");
      disc(c, C[0], C[1] + 14, TT.plat, "#2c2e33");
      circle(c, C[0], C[1], TT.plat); c.fillStyle = metalSweep(c, C[0], C[1], TT.plat); c.fill();
      circle(c, C[0], C[1], TT.plat); c.strokeStyle = "rgba(255,255,255,0.45)"; c.lineWidth = 1.2; c.stroke();
      disc(c, C[0], C[1], TT.plat - 9, "#151516");
      rings(c, C[0], C[1], TT.plat - 11, TT.rec + 1, 3, "rgba(255,255,255,0.05)", "rgba(0,0,0,0.25)");
      } else {
      // Platter: side band visible below, polished rim with turning marks,
      // a fixed specular highlight, and a strobe ring.
      disc(c, C[0] + 3, C[1] + 16, TT.plat + 2, "rgba(0,0,0,0.5)");
      disc(c, C[0], C[1] + 12, TT.plat, "#3b3e43");
      circle(c, C[0], C[1], TT.plat);
      if (typeof c.createConicGradient === "function") {
        var pg = c.createConicGradient(-2.2, C[0], C[1]);
        [[0, "#8d9197"], [0.1, "#eef0f2"], [0.22, "#8a8e94"], [0.5, "#6f7379"], [0.6, "#d6d9dd"], [0.72, "#7c8086"], [1, "#8d9197"]].forEach(function (s) { pg.addColorStop(s[0], s[1]); });
        c.fillStyle = pg;
      } else c.fillStyle = metalSweep(c, C[0], C[1], TT.plat);
      c.fill();
      rings(c, C[0], C[1], TT.plat - 1, TT.rec + 1, 1.4, "rgba(255,255,255,0.10)", "rgba(0,0,0,0.10)");
      circle(c, C[0], C[1], TT.plat); c.strokeStyle = "rgba(255,255,255,0.35)"; c.lineWidth = 1.2; c.stroke();
      }
      // Record: lead-in band, fine grooves, glossy run-out, fixed sheen.
      disc(c, C[0], C[1], TT.rec, "#0b0b0c");
      disc(c, C[0], C[1], TT.rec - 1, "#121214");
      disc(c, C[0], C[1], TT.rIn + 2, "#0a0a0b");
      // Groove texture as fine radial tone bands (hairline rings alias into moire at TV sizes).
      var gv = c.createRadialGradient(C[0], C[1], TT.rOut, C[0], C[1], TT.rIn);
      for (i = 0; i <= 60; i++) gv.addColorStop(i / 60, i % 2 ? "rgba(255,255,255,0.028)" : "rgba(255,255,255,0.006)");
      circle(c, C[0], C[1], TT.rIn); c.fillStyle = gv; c.fill();
      disc(c, C[0], C[1], TT.rOut - 1, "#0a0a0b");
      disc(c, C[0], C[1], TT.rOut - 2, "#131315");
      rings(c, C[0], C[1], TT.rOut - 6, TT.lab + 4, 7, "rgba(255,255,255,0.04)", null);
      circle(c, C[0], C[1], TT.rec - 0.5); c.strokeStyle = "rgba(255,255,255,0.16)"; c.lineWidth = 1; c.stroke();
      circle(c, C[0], C[1], TT.rIn + 3); c.strokeStyle = "rgba(255,255,255,0.07)"; c.stroke();
      sheen(c, C[0], C[1], TT.rec);
      if (wood) {
      // Brushed-aluminium armboard (clear of the platter) with a chrome pivot,
      // anti-skate knob and cueing lever.
      var P = [TT.px, TT.py], bx = P[0] - 45, by = P[1] - 110, bw2 = 140, bh2 = 260;
      c.save(); c.shadowColor = "rgba(0,0,0,0.55)"; c.shadowBlur = 16 * SHADOW_SCALE; c.shadowOffsetY = 7 * SHADOW_SCALE;
      rr(c, bx, by, bw2, bh2, 22); c.fillStyle = "#9da1a7"; c.fill(); c.restore();
      rr(c, bx, by, bw2, bh2, 22); brushed(c, bx, by, bw2, bh2, "#e4e6e9", "#a9adb3", 2.5);
      rr(c, bx, by, bw2, bh2, 22); c.strokeStyle = "rgba(0,0,0,0.35)"; c.lineWidth = 1.2; c.stroke();
      [[bx + 16, by + 16], [bx + bw2 - 16, by + 16], [bx + 16, by + bh2 - 16], [bx + bw2 - 16, by + bh2 - 16]].forEach(function (p) { screw(c, p[0], p[1], 5); });
      metal(c, P[0], P[1], 40, "#ffffff", "#6f737a");
      rings(c, P[0], P[1], 38, 20, 2.5, "rgba(0,0,0,0.08)", null);
      var ax = P[0] + 58, ay = P[1] - 62;
      metal(c, ax, ay, 14, "#ffffff", "#6d7178");
      c.beginPath();
      for (i = 0; i < 20; i++) { var ka2 = i * TAU / 20; c.moveTo(ax + Math.cos(ka2) * 14, ay + Math.sin(ka2) * 14); c.lineTo(ax + Math.cos(ka2) * 11, ay + Math.sin(ka2) * 11); }
      c.strokeStyle = "rgba(0,0,0,0.3)"; c.lineWidth = 1; c.stroke();
      var cx1 = P[0] + 62, cy1 = P[1] + 70;
      c.save(); c.shadowColor = "rgba(0,0,0,0.5)"; c.shadowBlur = 8 * SHADOW_SCALE; c.shadowOffsetY = 4 * SHADOW_SCALE;
      metal(c, cx1, cy1, 11, "#ffffff", "#6f737a"); c.restore();
      c.strokeStyle = "#d9dce0"; c.lineWidth = 5; c.lineCap = "round";
      c.beginPath(); c.moveTo(cx1, cy1); c.lineTo(cx1 + 4, cy1 + 36); c.stroke(); c.lineCap = "butt";
      disc(c, cx1 + 4, cy1 + 38, 6, "#161618");
      // Chrome arm rest with a rubber cradle.
      var park2 = armTip(TT.park), rx2 = P[0] + (park2[0] - P[0]) * 0.55, ry2 = P[1] + (park2[1] - P[1]) * 0.55;
      c.save(); c.shadowColor = "rgba(0,0,0,0.6)"; c.shadowBlur = 10 * SHADOW_SCALE; c.shadowOffsetY = 5 * SHADOW_SCALE;
      metal(c, rx2, ry2, 13, "#ffffff", "#6d7178"); c.restore();
      rr(c, rx2 - 9, ry2 - 4, 18, 8, 4); c.fillStyle = "#141416"; c.fill();
      // Speed selector: a chrome knob between 33 and 45, and a warm pilot lamp.
      font(c, 600, 16, SANS); c.textAlign = "center"; c.textBaseline = "alphabetic";
      c.fillStyle = "rgba(255,230,200,0.75)"; c.fillText("33", 140, 752); c.fillStyle = "rgba(255,230,200,0.4)"; c.fillText("45", 210, 752);
      knob(c, 175, 766, 20, -2.4);
      c.save(); c.shadowColor = "rgba(255,160,60,0.95)"; c.shadowBlur = 16 * SHADOW_SCALE;
      metal(c, 250, 766, 7, "#ffe0a0", "#e07818"); c.restore();
      disc(c, 248, 764, 2, "rgba(255,255,255,0.8)");
      c.fillStyle = "rgba(255,230,200,0.45)"; font(c, 600, 12, SANS); c.fillText("POWER", 250, 794);
      c.textAlign = "left";
      } else {
      // Armboard: a machined disc with a bevel, the bearing housing, the
      // height tower, the anti-skate dial, the cueing lift and the arm rest.
      var P = [TT.px, TT.py];
      var metalDisc = function (x, y, r, light, dark) {
        var g = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
        g.addColorStop(0, light); g.addColorStop(1, dark);
        disc(c, x, y, r, g);
      };
      c.save(); c.shadowColor = "rgba(0,0,0,0.6)"; c.shadowBlur = 18 * SHADOW_SCALE; c.shadowOffsetY = 8 * SHADOW_SCALE;
      disc(c, P[0], P[1], 84, "#151619"); c.restore();
      metalDisc(P[0], P[1], 84, "#34373c", "#131417");
      circle(c, P[0], P[1], 82); c.strokeStyle = "rgba(255,255,255,0.2)"; c.lineWidth = 1.5; c.stroke();
      rings(c, P[0], P[1], 76, 40, 3, "rgba(255,255,255,0.025)", null);
      // Bearing housing under the gimbal: stepped rings and three screws.
      metalDisc(P[0], P[1], 40, "#5b5f66", "#1a1b1e");
      circle(c, P[0], P[1], 34); c.strokeStyle = "rgba(255,255,255,0.18)"; c.lineWidth = 1; c.stroke();
      for (i = 0; i < 3; i++) {
        var sa3 = -0.3 + i * TAU / 3;
        metalDisc(P[0] + Math.cos(sa3) * 37, P[1] + Math.sin(sa3) * 37, 3.2, "#e4e6e9", "#6a6e74");
      }
      // Height tower: a knurled column with a locking wheel.
      c.save(); c.shadowColor = "rgba(0,0,0,0.55)"; c.shadowBlur = 10 * SHADOW_SCALE; c.shadowOffsetY = 5 * SHADOW_SCALE;
      rr(c, P[0] + 40, P[1] + 2, 24, 50, 10);
      var tg = c.createLinearGradient(P[0] + 40, 0, P[0] + 64, 0);
      tg.addColorStop(0, "#1b1c1f"); tg.addColorStop(0.35, "#7b8087"); tg.addColorStop(0.55, "#d6d9dd"); tg.addColorStop(1, "#2a2c30");
      c.fillStyle = tg; c.fill(); c.restore();
      c.beginPath();
      for (i = 0; i < 12; i++) { c.moveTo(P[0] + 41, P[1] + 8 + i * 3.4); c.lineTo(P[0] + 63, P[1] + 8 + i * 3.4); }
      c.strokeStyle = "rgba(0,0,0,0.25)"; c.lineWidth = 0.8; c.stroke();
      metalDisc(P[0] + 52, P[1] + 27, 8, "#f1f2f4", "#6f737a"); disc(c, P[0] + 52, P[1] + 27, 2.5, "#26282c");
      // Anti-skate dial with its scale.
      var dx0 = P[0] - 46, dy0 = P[1] - 44;
      metalDisc(dx0, dy0, 19, "#3a3d42", "#111214");
      metalDisc(dx0, dy0, 12, "#f3f4f6", "#7b8087");
      c.beginPath();
      for (i = 0; i < 24; i++) { var ka = i * TAU / 24; c.moveTo(dx0 + Math.cos(ka) * 12, dy0 + Math.sin(ka) * 12); c.lineTo(dx0 + Math.cos(ka) * 10, dy0 + Math.sin(ka) * 10); }
      c.strokeStyle = "rgba(0,0,0,0.35)"; c.lineWidth = 0.8; c.stroke();
      c.beginPath();
      for (i = 0; i < 9; i++) { var ta = -3.9 + i * 0.3, len = i % 4 === 0 ? 7 : 4; c.moveTo(dx0 + Math.cos(ta) * 21, dy0 + Math.sin(ta) * 21); c.lineTo(dx0 + Math.cos(ta) * (21 + len), dy0 + Math.sin(ta) * (21 + len)); }
      c.strokeStyle = "rgba(255,255,255,0.45)"; c.lineWidth = 1; c.stroke();
      c.strokeStyle = "#1a1b1e"; c.lineWidth = 2; c.beginPath(); c.moveTo(dx0, dy0); c.lineTo(dx0 + Math.cos(-3.0) * 10, dy0 + Math.sin(-3.0) * 10); c.stroke();
      // Cueing lift: a small column with its lever, and the lift bar.
      var cx0 = P[0] - 62, cy0 = P[1] + 26;
      c.save(); c.shadowColor = "rgba(0,0,0,0.55)"; c.shadowBlur = 8 * SHADOW_SCALE; c.shadowOffsetY = 4 * SHADOW_SCALE;
      metalDisc(cx0, cy0, 12, "#e9ebee", "#5d6167"); c.restore();
      c.strokeStyle = "#b9bdc3"; c.lineWidth = 4; c.lineCap = "round";
      c.beginPath(); c.moveTo(cx0, cy0); c.lineTo(cx0 - 26, cy0 + 14); c.stroke();
      disc(c, cx0 - 27, cy0 + 15, 5, "#1c1d20"); c.lineCap = "butt";
      disc(c, cx0, cy0, 4, "#2a2b2e");
      // Arm rest.
      var park = armTip(TT.park), rx = P[0] + (park[0] - P[0]) * 0.55, ry = P[1] + (park[1] - P[1]) * 0.55;
      c.save(); c.shadowColor = "rgba(0,0,0,0.6)"; c.shadowBlur = 10 * SHADOW_SCALE; c.shadowOffsetY = 5 * SHADOW_SCALE;
      metalDisc(rx, ry, 13, "#5a5e65", "#141517"); c.restore();
      metalDisc(rx, ry, 7, "#2c2e33", "#0c0c0e");
      // Speed selector: 33 lit.
      rr(c, 128, 758, 150, 40, 20); c.fillStyle = "#121315"; c.fill();
      c.strokeStyle = "rgba(255,255,255,0.12)"; c.lineWidth = 1; c.stroke();
      font(c, 500, 16, MONO); c.textAlign = "left"; c.textBaseline = "middle";
      c.fillStyle = "#e9e6de"; c.fillText("33", 162, 779); c.fillStyle = "#5c5d60"; c.fillText("45", 226, 779);
      c.save(); c.shadowColor = "rgba(255,170,60,0.9)"; c.shadowBlur = 10 * SHADOW_SCALE;
      disc(c, 150, 778, 4, "#ffb347"); c.restore();
      disc(c, 214, 778, 4, "#2a2b2e");
      c.textBaseline = "alphabetic";
      }
      // Type block.
      var x = 1160, y = 380;
      font(c, 500, 15, MONO); c.fillStyle = "#77756f"; c.fillText("33⅓ RPM", x, y);
      font(c, 600, 46, SANS); c.fillStyle = "#f2f0ea";
      var lines = wrapLines(c, T.title, 380, 2);
      lines.forEach(function (l, k) { c.fillText(l, x, y + 58 + k * 52); });
      y += 58 + Math.max(1, lines.length) * 52 - 8;
      c.fillStyle = "#c4c1ba"; c.fillText(fit(c, 400, 28, SANS, T.artist, 380, 0.7), x, y + 4);
      c.fillStyle = "#8d8a84"; c.fillText(fit(c, 400, 22, SANS, join([T.album, T.year], " · "), 380, 0.7), x, y + 40);
      c.fillStyle = "#4a4845"; c.fillRect(x, y + 68, 56, 1.5);
      c.fillStyle = "#a19e97"; c.fillText(fit(c, 500, 18, MONO, T.fmt, 380, 0.7), x, y + 104);
      R.ttTimeY = y + 136;
    },
    dyn: function (c, S, T, v, R) {
      var C = [TT.cx, TT.cy], lr = TT.lab, wob = Math.sin(S.platter);
      // Belt: a sheen travelling at the platter rim's speed (modern only).
      if (v !== "wood" && typeof c.setLineDash === "function") {
        var bp = beltPts();
        c.beginPath(); c.moveTo(bp[0][0], bp[0][1]); c.lineTo(bp[0][2], bp[0][3]); c.moveTo(bp[1][2], bp[1][3]); c.lineTo(bp[1][0], bp[1][1]);
        c.setLineDash([10, 36]); c.lineDashOffset = -S.beltPos;
        c.strokeStyle = "rgba(255,255,255,0.4)"; c.lineWidth = 2; c.stroke();
        c.setLineDash([]); c.lineDashOffset = 0;
      }
      // Strobe ring: 108 dots. At 33⅓ they hold still (see _physics).
      c.beginPath();
      for (var i = 0; i < STROBE_N; i++) {
        var sa = S.strobe + i * STROBE_PITCH, co = Math.cos(sa), si = Math.sin(sa);
        c.moveTo(C[0] + co * 336 - si * 1.6, C[1] + si * 336 + co * 1.6);
        c.lineTo(C[0] + co * 343 - si * 1.6, C[1] + si * 343 + co * 1.6);
        c.lineTo(C[0] + co * 343 + si * 1.6, C[1] + si * 343 - co * 1.6);
        c.lineTo(C[0] + co * 336 + si * 1.6, C[1] + si * 336 - co * 1.6); c.closePath();
      }
      c.fillStyle = v === "wood" ? "rgba(10,10,12,0.55)" : "rgba(18,20,24,0.6)"; c.fill();
      // Dust and hairline scratches, turning with the record.
      var dust = R._dust();
      c.beginPath();
      dust.specks.forEach(function (d) { var a = d[1] + S.platter; c.rect(C[0] + Math.cos(a) * d[0], C[1] + Math.sin(a) * d[0], d[2], d[2]); });
      c.fillStyle = "rgba(225,225,220,0.4)"; c.fill();
      c.beginPath();
      dust.scratches.forEach(function (d) { var a = d[1] + S.platter; c.moveTo(C[0] + Math.cos(a) * d[0], C[1] + Math.sin(a) * d[0]); c.arc(C[0], C[1], d[0], a, a + d[2]); });
      c.strokeStyle = "rgba(255,255,255,0.1)"; c.lineWidth = 0.8; c.stroke();
      // A slight warp: the surface highlight breathes once per revolution.
      c.save(); c.globalAlpha = 0.5 + 0.5 * wob;
      c.fillStyle = R._grad("warp", function () {
        var g = c.createLinearGradient(C[0] - 260, C[1] - 260, C[0] + 120, C[1] + 120);
        g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.45, "rgba(255,255,255,0.05)"); g.addColorStop(0.6, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(255,255,255,0)");
        return g;
      });
      circle(c, C[0], C[1], TT.rec - 2); c.fill(); c.restore();
      // Label (wobbling ~1 px with the warp).
      c.save(); c.translate(C[0], C[1] + 0.8 * wob); c.rotate(S.platter);
      var sprite = R._labelSprite();
      if (sprite) c.drawImage(sprite, -lr, -lr, lr * 2, lr * 2); else { c.scale(lr / 118, lr / 118); drawLabel(c, R._artReady()); }
      c.restore();
      // Record clamp: a machined puck (round, so it needs no rotation).
      disc(c, C[0] + 4, C[1] + 7, 44, "rgba(0,0,0,0.4)");
      disc(c, C[0], C[1], 42, v === "wood" ? "#c9ccd1" : "#a7abb1");
      rings(c, C[0], C[1], 41, 17, 1.5, "rgba(255,255,255,0.14)", "rgba(0,0,0,0.12)");
      c.fillStyle = R._grad("puck", function () {
        var g = c.createRadialGradient(C[0] - 16, C[1] - 18, 2, C[0] - 10, C[1] - 12, 40);
        g.addColorStop(0, "rgba(255,255,255,0.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
        return g;
      });
      circle(c, C[0], C[1], 42); c.fill();
      disc(c, C[0], C[1], 16, "#1d1e21"); disc(c, C[0], C[1], 5, "#cfd2d6");
      // Tonearm: its shadow (further off while lifted), a contact shadow when
      // the stylus is down, then the arm.
      var sp = R._armSprites(), ang = Math.atan2(S.tip[1] - TT.py, S.tip[0] - TT.px), lf = S.lift;
      if (sp) {
        c.save(); c.globalAlpha = 1 - 0.35 * lf; c.translate(TT.px + 9 + 10 * lf, TT.py + 13 + 14 * lf); c.rotate(ang);
        c.drawImage(sp[1], ARM.x0, ARM.y0, ARM.w, ARM.h); c.restore();
      }
      if (lf < 0.5) {
        c.save(); c.globalAlpha = 1 - 2 * lf; c.translate(S.tip[0] + 2, S.tip[1] + 3);
        c.fillStyle = R._grad("contact", function () {
          var g = c.createRadialGradient(0, 0, 0, 0, 0, 9);
          g.addColorStop(0, "rgba(0,0,0,0.6)"); g.addColorStop(1, "rgba(0,0,0,0)");
          return g;
        });
        circle(c, 0, 0, 9); c.fill(); c.restore();
      }
      c.save(); c.translate(TT.px, TT.py); c.rotate(ang);
      if (sp) c.drawImage(sp[0], ARM.x0, ARM.y0, ARM.w, ARM.h); else drawArm(c, false, v);
      c.restore();
      font(c, 500, 18, MONO); c.fillStyle = v === "wood" ? "#b8a58a" : "#a19e97"; c.textAlign = "left";
      c.fillText(timeText(S), 1160, R.ttTimeY || 640);
    },
  };

  // The LED bars read in the same per-track VU units as the needles (0 = this
  // track's reference loudness), from -30 to +6, 0.75 dB a segment. The zones
  // follow the VU face: green below -6, amber -6..0, red from 0 (the start of
  // the VU's red arc). Raw sample peak in dBFS pinned brickwalled masters in
  // the red and disagreed with the calibrated VU (user, 2026-09-21).
  var SEG = 48, PX0 = 200, PX1 = 1440, PLO = -30, PHI = 6, SEGW = (PX1 - PX0) / SEG;
  var SEG_RGB = ["120,214,140", "242,169,59", "255,74,54"], SEG_COL = [];
  for (var si = 0; si < SEG; si++) {
    var sdb = PLO + si * ((PHI - PLO) / SEG); // the segment's lower edge
    SEG_COL.push(sdb >= -1e-9 ? 2 : sdb >= -6 - 1e-9 ? 1 : 0);
  }
  function segX(db) { return PX0 + ((db - PLO) / (PHI - PLO)) * (PX1 - PX0); }
  function segOf(db) { return Math.round(((clamp(isFinite(db) ? db : PLO, PLO, PHI) - PLO) / (PHI - PLO)) * SEG); }
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
      [-30, -20, -10, -6, -3, 0, 3, 6].forEach(function (db) {
        c.fillStyle = db >= 0 ? "#c9493a" : "#5d635d";
        c.fillText(db > 0 ? "+" + db : String(db), segX(db), 780);
      });
      // The 0 mark: where red starts, as on the VU.
      c.fillStyle = "#c9493a"; c.fillRect(segX(0) - 1, 508, 2, 244);
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
  // a roller on a sprung tension arm, past the heads and capstan, round a
  // second arm roller to the take-up pack. Tape speed is constant, so the
  // smaller pack turns faster. The arms swing a little with pack size.
  var RL = { lx: 380, rx: 1220, cy: 275, F: 225, hub: 60, max: 210, roll: 20, apx: 530, apy: 470, alen: 99 };
  var MOD = { x: 560, y: 626, w: 480, h: 232 };
  function reelPack(share) { return Math.sqrt(RL.hub * RL.hub + share * (RL.max * RL.max - RL.hub * RL.hub)); }
  var TAPE_REEL = TAU * 1.0 * RL.hub; // a hub-size pack turns ~1 rev/s (7½ ips on a small hub)
  // Left-side roller position on its tension arm for a pack of radius r (the
  // right side is the mirror image).
  function armRoller(r) {
    var a = Math.PI / 4 + ((r - 135) / 150) * 0.1;
    return [RL.apx + Math.cos(a) * RL.alen, RL.apy + Math.sin(a) * RL.alen];
  }
  // The crossed tangent from the pack (left of the tape) to the roller (right
  // of the tape): the tape leaves the pack's right side and meets the roller's
  // left side. Returns [p1x, p1y, p2x, p2y].
  function supplyTangent(r1, c2x, c2y) {
    var c1x = RL.lx, c1y = RL.cy, r2 = RL.roll;
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
  // Engraved: a dark inner shadow on top, the fill, and a light lower lip.
  function engrave(c, text, x, y) {
    c.fillStyle = "rgba(255,255,255,0.6)"; c.fillText(text, x, y + 1.3);
    c.fillStyle = "rgba(0,0,0,0.35)"; c.fillText(text, x, y - 0.8);
    c.fillStyle = "rgba(44,46,50,0.9)"; c.fillText(text, x, y);
  }
  function metal(c, x, y, r, light, dark) {
    var g = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
    g.addColorStop(0, light); g.addColorStop(1, dark);
    disc(c, x, y, r, g);
  }
  // A knurled knob: shadow, knurled skirt, machined cap, pointer.
  function knob(c, x, y, r, a) {
    disc(c, x + 2, y + 5, r + 1, "rgba(0,0,0,0.3)");
    metal(c, x, y, r, "#4a4d53", "#141517");
    c.beginPath();
    for (var i = 0; i < 40; i++) { var t = i * TAU / 40; c.moveTo(x + Math.cos(t) * r, y + Math.sin(t) * r); c.lineTo(x + Math.cos(t) * (r - 4), y + Math.sin(t) * (r - 4)); }
    c.strokeStyle = "rgba(255,255,255,0.18)"; c.lineWidth = 1; c.stroke();
    metal(c, x, y, r * 0.7, "#f2f3f5", "#7d8188");
    rings(c, x, y, r * 0.66, 2, 2.2, "rgba(0,0,0,0.06)", null);
    c.strokeStyle = "#1c1d20"; c.lineWidth = r * 0.1; c.lineCap = "round";
    c.beginPath(); c.moveTo(x + Math.cos(a) * r * 0.15, y + Math.sin(a) * r * 0.15); c.lineTo(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62); c.stroke();
    c.lineCap = "butt";
  }
  // A chunky chrome toggle: hex nut, then a bat lever up (on) or down.
  function toggle(c, x, y, up) {
    disc(c, x + 2, y + 4, 17, "rgba(0,0,0,0.3)");
    c.beginPath();
    for (var i = 0; i < 6; i++) { var t = i * Math.PI / 3 + Math.PI / 6; c[i ? "lineTo" : "moveTo"](x + Math.cos(t) * 17, y + Math.sin(t) * 17); }
    c.closePath();
    var g = c.createLinearGradient(x - 17, y - 17, x + 17, y + 17);
    g.addColorStop(0, "#f4f5f7"); g.addColorStop(0.5, "#9da1a8"); g.addColorStop(1, "#4b4e54");
    c.fillStyle = g; c.fill();
    metal(c, x, y, 9, "#ffffff", "#6f737a");
    var ty = up ? y - 30 : y + 30;
    c.strokeStyle = "rgba(0,0,0,0.3)"; c.lineWidth = 9; c.lineCap = "round";
    c.beginPath(); c.moveTo(x + 3, y + 4); c.lineTo(x + 3, ty + 6); c.stroke();
    var lg = c.createLinearGradient(x - 5, 0, x + 5, 0);
    lg.addColorStop(0, "#7d8188"); lg.addColorStop(0.4, "#ffffff"); lg.addColorStop(1, "#6a6e75");
    c.strokeStyle = lg; c.lineWidth = 8;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, ty); c.stroke(); c.lineCap = "butt";
    metal(c, x, ty, 7, "#ffffff", "#80848b");
  }
  function lamp(c, x, y, on, rgb) {
    disc(c, x, y, 13, "#1a1b1d");
    if (on) {
      c.save(); c.shadowColor = "rgba(" + rgb + ",0.9)"; c.shadowBlur = 18 * SHADOW_SCALE;
      metal(c, x, y, 8, "rgba(" + rgb + ",1)", "rgba(" + rgb + ",0.55)"); c.restore();
      disc(c, x - 2.5, y - 2.5, 2.5, "rgba(255,255,255,0.8)");
    } else {
      metal(c, x, y, 8, "rgba(" + rgb + ",0.45)", "rgba(40,8,6,0.9)");
      disc(c, x - 2.5, y - 2.5, 2, "rgba(255,255,255,0.35)");
    }
  }
  // Deterministic pseudo-random for the plate's grain and scuffs.
  function prng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
  var CTR = { x: 112, y: 662, cw: 56, ch: 70, gap: 6, n: 4 };

  IMPL.reel = {
    bg: "#141517",
    stat: function (c, T) {
      var i, rnd = prng(11);
      c.fillStyle = "#141517"; c.fillRect(0, 0, W, H);
      rr(c, 30, 20, 1540, 860, 28); brushed(c, 30, 20, 1540, 860, "#d9dbde", "#b1b4b9", 3);
      // Fine grain: short streaks of varying length and tone.
      c.save(); rr(c, 30, 20, 1540, 860, 28); c.clip();
      [["rgba(255,255,255,0.16)", 900], ["rgba(0,0,0,0.07)", 900]].forEach(function (g) {
        c.beginPath();
        for (var k = 0; k < g[1]; k++) { var gx = 30 + rnd() * 1540, gy = 20 + rnd() * 860; c.moveTo(gx, gy); c.lineTo(gx + 40 + rnd() * 220, gy); }
        c.strokeStyle = g[0]; c.lineWidth = 0.7; c.stroke();
      });
      // Faint scuffs near the controls, where hands go.
      c.beginPath();
      [[440, 700], [1120, 818], [230, 700], [1360, 800]].forEach(function (p) {
        for (var k = 0; k < 7; k++) { var r0 = 42 + rnd() * 30, a0 = rnd() * TAU; c.moveTo(p[0] + Math.cos(a0) * r0, p[1] + Math.sin(a0) * r0); c.arc(p[0], p[1], r0, a0, a0 + 0.3 + rnd() * 0.5); }
      });
      c.strokeStyle = "rgba(60,60,64,0.12)"; c.lineWidth = 1; c.stroke();
      c.restore();
      rr(c, 30, 20, 1540, 860, 28); c.strokeStyle = "rgba(0,0,0,0.5)"; c.lineWidth = 3; c.stroke();
      rr(c, 33, 23, 1534, 854, 26); c.strokeStyle = "rgba(255,255,255,0.5)"; c.lineWidth = 1.2; c.stroke();
      [[62, 52], [1538, 52], [62, 848], [1538, 848], [800, 52]].forEach(function (p) { screw(c, p[0], p[1], 9); });
      // Recesses under the reels.
      [RL.lx, RL.rx].forEach(function (x) { disc(c, x, RL.cy + 8, RL.F + 10, "rgba(0,0,0,0.18)"); disc(c, x, RL.cy, RL.F + 3, "rgba(70,72,78,0.4)"); });
      // Tension-arm spring posts.
      [RL.apx - 58, W - RL.apx + 58].forEach(function (x) { metal(c, x, RL.apy + 40, 7, "#ffffff", "#6d7178"); });
      // Head block: a hinged cover, a little worn at the edges, and three heads.
      c.save(); c.shadowColor = "rgba(0,0,0,0.45)"; c.shadowBlur = 12 * SHADOW_SCALE; c.shadowOffsetY = 5 * SHADOW_SCALE;
      rr(c, 650, 470, 300, 66, 10);
      var hc = c.createLinearGradient(0, 470, 0, 536);
      hc.addColorStop(0, "#44464b"); hc.addColorStop(0.5, "#2a2b2f"); hc.addColorStop(1, "#1c1d20");
      c.fillStyle = hc; c.fill(); c.restore();
      rr(c, 651, 471, 298, 64, 9); c.strokeStyle = "rgba(255,255,255,0.2)"; c.lineWidth = 1; c.stroke();
      var hg = c.createLinearGradient(0, 468, 0, 478);
      hg.addColorStop(0, "#f0f1f3"); hg.addColorStop(1, "#6d7178");
      c.fillStyle = hg; c.fillRect(662, 468, 276, 7);
      c.fillStyle = "rgba(0,0,0,0.35)"; [700, 800, 900].forEach(function (k) { c.fillRect(k, 468, 1.5, 7); });
      c.beginPath();
      for (i = 0; i < 14; i++) { var sx = 656 + rnd() * 288, sy = 480 + rnd() * 50; c.moveTo(sx, sy); c.lineTo(sx + 6 + rnd() * 18, sy + (rnd() - 0.5) * 3); }
      c.strokeStyle = "rgba(255,255,255,0.07)"; c.lineWidth = 1; c.stroke();
      [[664, 486], [936, 486], [664, 522], [936, 522]].forEach(function (p) { screw(c, p[0], p[1], 5); });
      [700, 790, 880].forEach(function (hx) {
        rr(c, hx - 20, 520, 40, 38, 6);
        var mg = c.createLinearGradient(hx - 20, 0, hx + 20, 0);
        mg.addColorStop(0, "#7e838a"); mg.addColorStop(0.35, "#f5f6f8"); mg.addColorStop(1, "#8a8e95");
        c.fillStyle = mg; c.fill();
        c.fillStyle = "#3a3c40"; c.fillRect(hx - 1.5, 521, 3, 37);
      });
      c.textBaseline = "alphabetic";
      font(c, 600, 16, SANS); c.textAlign = "center";
      engrave(c, "SUPPLY", RL.lx, 530); engrave(c, "TAKE-UP", RL.rx, 530);
      // Modulometer: two needles, white = L, red = R; warm backlight.
      c.save(); c.shadowColor = "rgba(0,0,0,0.5)"; c.shadowBlur = 16 * SHADOW_SCALE; c.shadowOffsetY = 6 * SHADOW_SCALE;
      rr(c, MOD.x - 6, MOD.y - 6, MOD.w + 12, MOD.h + 12, 18); c.fillStyle = "#2b2d31"; c.fill(); c.restore();
      vuFace(c, MOD.x, MOD.y, MOD.w, MOD.h, SKIN.modulo, "");
      font(c, 600, MOD.h * 0.07, MONO); c.textAlign = "center";
      var ly = MOD.y + MOD.h * 0.84;
      c.fillStyle = SKIN.modulo.needle; c.fillText("L", MOD.x + MOD.w / 2 - 34, ly);
      c.fillStyle = "#ff4a36"; c.fillText("R", MOD.x + MOD.w / 2 + 34, ly);
      c.fillStyle = "rgba(240,240,236,0.5)"; c.fillRect(MOD.x + MOD.w / 2 - 22, ly - 12, 12, 2);
      c.fillStyle = "rgba(255,74,54,0.8)"; c.fillRect(MOD.x + MOD.w / 2 + 10, ly - 12, 12, 2);
      font(c, 600, 18, MONO); c.textAlign = "left"; engrave(c, "L  R", MOD.x + MOD.w + 18, MOD.y + MOD.h - 8);
      font(c, 600, 15, SANS); c.textAlign = "center"; engrave(c, "MODULATION", MOD.x + MOD.w / 2, MOD.y - 12); c.textAlign = "left";
      // Tape counter: four white wheels in a bevelled black window.
      rr(c, CTR.x - 12, CTR.y - 10, CTR.n * (CTR.cw + CTR.gap) - CTR.gap + 24, CTR.ch + 20, 8); c.fillStyle = "#101012"; c.fill();
      c.strokeStyle = "rgba(255,255,255,0.55)"; c.lineWidth = 1.2; c.stroke();
      c.fillStyle = "#efeee8";
      for (i = 0; i < CTR.n; i++) c.fillRect(CTR.x + i * (CTR.cw + CTR.gap), CTR.y, CTR.cw, CTR.ch);
      font(c, 600, 16, SANS); engrave(c, "COUNTER", CTR.x - 10, CTR.y - 22);
      // Input selector at LINE; speed selector at 7½ ips.
      knob(c, 440, 700, 34, -Math.PI / 4);
      font(c, 600, 16, SANS); c.textAlign = "center";
      engrave(c, "MIC", 392, 648); engrave(c, "LINE", 478, 648);
      knob(c, 1120, 818, 22, -Math.PI / 4);
      c.textAlign = "left"; font(c, 600, 20, SANS); engrave(c, "7½ ips", 1152, 826);
      font(c, 600, 14, SANS); engrave(c, "SPEED", 1098, 787);
      // Toggles and lamps: monitor on TAPE, power on (green), REC off (red).
      toggle(c, 1310, 818, true); toggle(c, 1392, 818, true);
      font(c, 600, 13, SANS); c.textAlign = "center";
      engrave(c, "TAPE", 1310, 780); engrave(c, "POWER", 1392, 780);
      lamp(c, 1456, 818, true, "80,230,120"); lamp(c, 1500, 818, false, "255,60,40");
      engrave(c, "ON", 1456, 800); engrave(c, "REC", 1500, 800);
      c.textAlign = "left";
      // Label strip: the track engraved on black anodised aluminium.
      rr(c, 1090, 612, 440, 146, 8);
      var ls = c.createLinearGradient(0, 612, 0, 758);
      ls.addColorStop(0, "#202124"); ls.addColorStop(1, "#111214");
      c.fillStyle = ls; c.fill();
      c.strokeStyle = "rgba(255,255,255,0.22)"; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = "#ecebe6"; c.fillText(fit(c, 800, 46, DISPLAY, T.title.toUpperCase(), 400, 0.55), 1110, 662);
      c.fillStyle = "#b3b4b0"; c.fillText(fit(c, 500, 24, SANS, join([T.artist, T.album], " · "), 400, 0.7), 1110, 700);
      c.fillStyle = "#8e908c"; c.fillText(fit(c, 500, 20, MONO, T.fmt, 400, 0.7), 1110, 736);
    },
    dyn: function (c, S, T, v, R) {
      var rL = reelPack(1 - S.progress), rR = reelPack(S.progress), cy = RL.cy;
      var sheenG = function (x) {
        return R._grad("pack" + x, function () {
          if (typeof c.createConicGradient !== "function") return "rgba(255,220,180,0.03)";
          var g = c.createConicGradient(-0.9, x, cy);
          [[0, 0], [0.1, 0.12], [0.2, 0], [0.5, 0], [0.6, 0.08], [0.7, 0], [1, 0]].forEach(function (s) { g.addColorStop(s[0], "rgba(255,225,190," + s[1] + ")"); });
          return g;
        });
      };
      // Packs: oxide brown, a fixed sheen, fine winding lines, a glossier edge.
      c.beginPath(); c.arc(RL.lx, cy, rL, 0, TAU); c.moveTo(RL.rx + rR, cy); c.arc(RL.rx, cy, rR, 0, TAU);
      c.fillStyle = "#3a2416"; c.fill();
      [[RL.lx, rL], [RL.rx, rR]].forEach(function (p) { circle(c, p[0], cy, p[1]); c.fillStyle = sheenG(p[0]); c.fill(); });
      c.beginPath();
      [[RL.lx, rL], [RL.rx, rR]].forEach(function (p) { for (var k = p[1] - 7; k > RL.hub + 2; k -= 7) { c.moveTo(p[0] + k, cy); c.arc(p[0], cy, k, 0, TAU); } });
      c.strokeStyle = "rgba(0,0,0,0.12)"; c.lineWidth = 1; c.stroke();
      c.beginPath(); c.arc(RL.lx, cy, rL - 1.5, 0, TAU); c.moveTo(RL.rx + rR - 1.5, cy); c.arc(RL.rx, cy, rR - 1.5, 0, TAU);
      c.strokeStyle = "rgba(255,214,170,0.28)"; c.lineWidth = 2; c.stroke();
      // Tension arms and their rollers, then the tape path.
      var qa = armRoller(rL), qb = armRoller(rR);
      var a = supplyTangent(rL, qa[0], qa[1]), b = supplyTangent(rR, qb[0], qb[1]);
      var ta = Math.atan2(a[3] - qa[1], a[2] - qa[0]); if (ta < Math.PI / 2) ta += TAU;
      var tb = Math.atan2(b[3] - qb[1], b[2] - qb[0]); if (tb < Math.PI / 2) tb += TAU;
      [[RL.apx, qa, 1], [W - RL.apx, [W - qb[0], qb[1]], -1]].forEach(function (arm) {
        var px = arm[0], q = arm[1], sg = arm[2];
        // Spring from the post to the arm's middle.
        var sx = px - sg * 58, sy = RL.apy + 40, mx = (px + q[0]) / 2, my = (RL.apy + q[1]) / 2;
        var dx = mx - sx, dy = my - sy, l = Math.sqrt(dx * dx + dy * dy) || 1, nx = -dy / l, ny = dx / l;
        c.beginPath(); c.moveTo(sx, sy);
        for (var k = 1; k < 14; k++) { var f = k / 14, w = k % 2 ? 5 : -5; c.lineTo(sx + dx * f + nx * w, sy + dy * f + ny * w); }
        c.lineTo(mx, my); c.strokeStyle = "#8e9298"; c.lineWidth = 1.6; c.stroke();
        c.strokeStyle = "rgba(0,0,0,0.25)"; c.lineWidth = 9; c.lineCap = "round";
        c.beginPath(); c.moveTo(px + 2, RL.apy + 5); c.lineTo(q[0] + 2, q[1] + 5); c.stroke();
        c.strokeStyle = "#c9ccd1"; c.lineWidth = 7;
        c.beginPath(); c.moveTo(px, RL.apy); c.lineTo(q[0], q[1]); c.stroke();
        c.strokeStyle = "rgba(255,255,255,0.85)"; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(px - 1, RL.apy - 2); c.lineTo(q[0] - 1, q[1] - 2); c.stroke(); c.lineCap = "butt";
        disc(c, px, RL.apy, 11, "#6d7178"); disc(c, px, RL.apy, 5, "#e6e8eb");
        disc(c, q[0], q[1], RL.roll + 4, "#55595f"); disc(c, q[0], q[1], RL.roll - 4, "#d6d9dd"); disc(c, q[0], q[1], 5, "#3a3c40");
      });
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(a[2], a[3]);
      c.arc(qa[0], qa[1], RL.roll, ta, Math.PI / 2, true);
      c.lineTo(W - qb[0], qb[1] + RL.roll);
      c.arc(W - qb[0], qb[1], RL.roll, Math.PI / 2, Math.PI - tb, true);
      c.lineTo(W - b[0], b[1]);
      c.strokeStyle = "#4a2d19"; c.lineWidth = 5; c.lineJoin = "round"; c.stroke();
      // A thin highlight where the tape wraps each roller.
      c.beginPath(); c.arc(qa[0], qa[1], RL.roll + 1.5, ta, Math.PI / 2, true);
      c.moveTo(W - qb[0], qb[1] + RL.roll + 1.5); c.arc(W - qb[0], qb[1], RL.roll + 1.5, Math.PI / 2, Math.PI - tb, true);
      c.strokeStyle = "rgba(255,210,170,0.5)"; c.lineWidth = 1.2; c.stroke();
      // Capstan (polished) above the tape, pinch roller (black rubber) below.
      var ty = (qa[1] + qb[1]) / 2 + RL.roll;
      disc(c, 962, ty + 23, 20, "rgba(0,0,0,0.3)");
      disc(c, 960, ty + 20, 18, "#141416");
      c.beginPath(); c.arc(960, ty + 20, 14, -2.6, -1.2); c.strokeStyle = "rgba(255,255,255,0.28)"; c.lineWidth = 3; c.stroke();
      disc(c, 960, ty + 20, 6, "#55585d");
      c.fillStyle = R._grad("capstan", function () {
        var g = c.createRadialGradient(957, 550, 0.5, 960, 553, 8);
        g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#8a8e95");
        return g;
      });
      circle(c, 960, ty - 7, 7); c.fill();
      [[RL.lx, S.rrL], [RL.rx, S.rrR]].forEach(function (p) {
        var x = p[0], rot = p[1], k, j;
        // Flange with three windows. The fill gradients are anchored to the
        // plate, so the machined highlight stays put while the reel turns.
        c.beginPath(); c.arc(x, cy, RL.F, 0, TAU);
        for (k = 0; k < 3; k++) {
          var a0 = rot + k * TAU / 3 - 0.55, a1 = a0 + 1.1;
          c.moveTo(x + Math.cos(a0) * 205, cy + Math.sin(a0) * 205);
          c.arc(x, cy, 205, a0, a1); c.arc(x, cy, 88, a1, a0, true); c.closePath();
        }
        c.fillStyle = R._grad("flange" + x, function () {
          var g = c.createRadialGradient(x - 40, cy - 60, 20, x, cy, RL.F);
          g.addColorStop(0, "#f3f4f6"); g.addColorStop(1, "#9ea3a9");
          return g;
        });
        c.fill("evenodd");
        c.fillStyle = R._grad("flangeC" + x, function () {
          if (typeof c.createConicGradient !== "function") return "rgba(255,255,255,0)";
          var g = c.createConicGradient(-2.3, x, cy);
          [[0, 0], [0.08, 0.35], [0.16, 0], [0.5, 0], [0.58, 0.28], [0.66, 0], [1, 0]].forEach(function (s) { g.addColorStop(s[0], "rgba(255,255,255," + s[1] + ")"); });
          return g;
        });
        c.fill("evenodd");
        // Bevelled window edges: a light lip and a dark lip.
        c.save(); c.translate(-1, -1.2); c.strokeStyle = "rgba(255,255,255,0.7)"; c.lineWidth = 1.4; c.stroke(); c.restore();
        c.save(); c.translate(1, 1.2); c.strokeStyle = "rgba(20,22,26,0.55)"; c.lineWidth = 1.4; c.stroke(); c.restore();
        // NAB hub: an aluminium insert, a keyed centre hole, three screws.
        c.fillStyle = R._grad("hub" + x, function () {
          var g = c.createRadialGradient(x - 18, cy - 22, 2, x, cy, 60);
          g.addColorStop(0, "#fbfbfc"); g.addColorStop(1, "#80858c");
          return g;
        });
        circle(c, x, cy, 60); c.fill();
        circle(c, x, cy, 60); c.strokeStyle = "rgba(0,0,0,0.4)"; c.lineWidth = 1.2; c.stroke();
        disc(c, x, cy, 36, "#1a1b1e");
        c.beginPath();
        for (k = 0; k < 3; k++) {
          var t = rot + k * TAU / 3, co = Math.cos(t), si = Math.sin(t), pts = [[-6, -37], [6, -37], [6, -27], [-6, -27]];
          for (j = 0; j < 4; j++) {
            var px = x + pts[j][0] * co - pts[j][1] * si, py = cy + pts[j][0] * si + pts[j][1] * co;
            if (j) c.lineTo(px, py); else c.moveTo(px, py);
          }
          c.closePath();
          c.moveTo(x + Math.cos(t + 1.05) * 48 + 3, cy + Math.sin(t + 1.05) * 48);
          c.arc(x + Math.cos(t + 1.05) * 48, cy + Math.sin(t + 1.05) * 48, 3, 0, TAU);
        }
        c.fillStyle = "#b8bcc2"; c.fill();
        disc(c, x, cy, 13, "#d9dbde"); disc(c, x - 3, cy - 3, 4, "#ffffff");
      });
      // Modulometer needles: red (R) under white (L), then the glass.
      var lampOn = S.lamp[0] || S.lamp[1];
      vuNeedle(c, R, MOD.x, MOD.y, MOD.w, MOD.h, S.vu[1].x, SKIN.modulo, lampOn, "#ff4a36");
      vuNeedle(c, R, MOD.x, MOD.y, MOD.w, MOD.h, S.vu[0].x, SKIN.modulo, false);
      c.fillStyle = R._grad("glass", function () {
        var g = c.createLinearGradient(MOD.x, MOD.y, MOD.x + MOD.w * 0.5, MOD.y + MOD.h);
        g.addColorStop(0, "rgba(255,255,255,0.16)"); g.addColorStop(0.45, "rgba(255,255,255,0.03)"); g.addColorStop(1, "rgba(255,255,255,0)");
        return g;
      });
      c.beginPath(); c.moveTo(MOD.x + 8, MOD.y + 8); c.lineTo(MOD.x + MOD.w * 0.62, MOD.y + 8); c.lineTo(MOD.x + MOD.w * 0.3, MOD.y + MOD.h - 8); c.lineTo(MOD.x + 8, MOD.y + MOD.h - 8); c.closePath(); c.fill();
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


  // ---------------------------------------------------------------------------
  // Spectrum analyser: 16 bands, calibrated per track like the VU (top of the
  // scale = the track's 95th-percentile band level + 6 dB, 36 dB range), fast
  // attack, 24 dB/s fall, peak caps holding 0.6 s. No data: bars at the floor.
  var SPX = { x0: 160, x1: 1440, top: 150, bot: 690, segs: 24, mid: 420, half: 250 };
  var SPEC_VARIANTS = [["led", "LED"], ["vfd", "Fluorescent"], ["analog", "Analogue glow"], ["mirror", "Mirror"]];
  function specCol(i, n) { var w = (SPX.x1 - SPX.x0) / n; return [SPX.x0 + i * w + w * 0.12, w * 0.76]; }
  function specLabels(c, bandHz, n, y, col) {
    if (!bandHz || bandHz.length < 2) return;
    var f0 = bandHz[0], fN = bandHz[bandHz.length - 1], a = specCol(0, n), b = specCol(n - 1, n);
    var xa = a[0] + a[1] / 2, xb = b[0] + b[1] / 2;
    font(c, 500, 18, MONO); c.fillStyle = col; c.textAlign = "center";
    [[40, "40"], [100, "100"], [250, "250"], [1000, "1k"], [2500, "2.5k"], [6000, "6k"], [10000, "10k"]].forEach(function (l) {
      if (l[0] < f0 * 0.97 || l[0] > fN * 1.03) return;
      c.fillText(l[1], xa + (Math.log(l[0] / f0) / Math.log(fN / f0)) * (xb - xa), y);
    });
    c.textAlign = "left";
  }
  // Lit test for segmented bars: the bar, plus one cap segment.
  function specLit(S) {
    var n = S.sp.length, lit = [], cap = [];
    for (var i = 0; i < n; i++) {
      lit.push(Math.round(S.sp[i] * SPX.segs));
      cap.push(S.spPk[i] > 0 ? Math.max(0, Math.round(S.spPk[i] * SPX.segs) - 1) : -1);
    }
    return function (i, s) { return s < lit[i] || s === cap[i]; };
  }
  var SEG_SPEC = ["#58d27a", "#f2a93b", "#ff4a36"];
  function specSegCol(s) { var f = (s + 1) / SPX.segs; return f > 30 / 36 ? 2 : f > 0.6 ? 1 : 0; }
  function specSegs(c, n, test, cols, grow) {
    var sh = (SPX.bot - SPX.top) / SPX.segs;
    for (var k = 0; k < 3; k++) {
      c.beginPath(); var any = false;
      for (var i = 0; i < n; i++) {
        var cx = specCol(i, n);
        for (var s = 0; s < SPX.segs; s++) if (specSegCol(s) === k && test(i, s)) {
          c.rect(cx[0] - grow, SPX.bot - (s + 1) * sh + 2 - grow, cx[1] + 2 * grow, sh - 4 + 2 * grow); any = true;
        }
      }
      if (any) { c.fillStyle = cols[k]; c.fill(); }
    }
  }
  function specLine(c, T, dark) {
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    c.fillStyle = dark ? "#1f2124" : "#eceae5";
    c.fillText(fit(c, 600, 34, SANS, join([T.title, T.artist], "  —  "), 900, 0.6), 160, 800);
  }
  function specTime(c, S, T, col) {
    font(c, 500, 22, MONO); c.fillStyle = col; c.textAlign = "right";
    c.fillText(join([T.fmt, timeText(S)], "   "), 1440, 798); c.textAlign = "left";
  }
  var SPEC_IMPL = {
    led: {
      bg: "#070808",
      stat: function (c, T, R) {
        c.fillStyle = "#070808"; c.fillRect(0, 0, W, H);
        rr(c, 120, 110, 1360, 620, 16); c.fillStyle = "#0c0d0e"; c.fill();
        c.strokeStyle = "rgba(255,255,255,0.08)"; c.lineWidth = 1.5; c.stroke();
        specSegs(c, R._specBands(), function () { return true; }, ["rgba(88,210,122,0.08)", "rgba(242,169,59,0.08)", "rgba(255,74,54,0.08)"], 0);
        specLabels(c, R._specHz(), R._specBands(), 718, "#6f756f");
        specLine(c, T, false);
      },
      dyn: function (c, S) {
        var n = S.sp.length;
        specSegs(c, n, specLit(S), SEG_SPEC, 0);
        specTime(c, S, S.T, "#6f756f");
      },
    },
    vfd: {
      bg: "#030506",
      stat: function (c, T, R) {
        c.fillStyle = "#030506"; c.fillRect(0, 0, W, H);
        rr(c, 120, 110, 1360, 620, 12); c.fillStyle = "#040708"; c.fill();
        var gl = c.createLinearGradient(0, 110, 0, 730);
        gl.addColorStop(0, "rgba(120,200,255,0.06)"); gl.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = gl; c.fill();
        specSegs(c, R._specBands(), function () { return true; }, ["rgba(95,242,255,0.07)", "rgba(95,242,255,0.07)", "rgba(255,106,90,0.08)"], 0);
        c.save(); c.shadowColor = "rgba(95,242,255,0.8)"; c.shadowBlur = 8 * SHADOW_SCALE;
        specLabels(c, R._specHz(), R._specBands(), 718, "#5ff2ff"); c.restore();
        specLine(c, T, false);
      },
      dyn: function (c, S) {
        var n = S.sp.length, t = specLit(S);
        // Glow: the lit segments once more, a little larger and faint.
        specSegs(c, n, t, ["rgba(95,242,255,0.18)", "rgba(95,242,255,0.18)", "rgba(255,106,90,0.2)"], 4);
        specSegs(c, n, t, ["#5ff2ff", "#5ff2ff", "#ff6a5a"], 0);
        specTime(c, S, S.T, "#5ff2ff");
      },
    },
    analog: {
      bg: "#0b0806",
      stat: function (c, T, R) {
        c.fillStyle = "#0b0806"; c.fillRect(0, 0, W, H);
        rr(c, 100, 90, 1400, 660, 22); brushed(c, 100, 90, 1400, 660, "#2c2926", "#161412", 3);
        rr(c, 140, 120, 1320, 590, 12); c.fillStyle = "#0a0605"; c.fill();
        var n = R._specBands();
        c.beginPath();
        for (var i = 0; i < n; i++) { var cx = specCol(i, n); c.rect(cx[0], SPX.top, cx[1], SPX.bot - SPX.top); }
        c.fillStyle = "rgba(255,140,40,0.05)"; c.fill();
        specLabels(c, R._specHz(), n, 740, "#c98a4a");
        specLine(c, T, false);
      },
      dyn: function (c, S, R) {
        var n = S.sp.length, h = SPX.bot - SPX.top;
        var bar = R._grad("specA", function () {
          var g = c.createLinearGradient(0, SPX.bot, 0, SPX.top);
          g.addColorStop(0, "#7a2a08"); g.addColorStop(0.5, "#ff8a2a"); g.addColorStop(1, "#ffe0a0");
          return g;
        });
        [[10, "rgba(255,130,40,0.16)"], [0, bar]].forEach(function (p) {
          c.beginPath();
          for (var i = 0; i < n; i++) { var cx = specCol(i, n), bh = S.sp[i] * h; if (bh > 0.5) c.rect(cx[0] - p[0], SPX.bot - bh - p[0], cx[1] + 2 * p[0], bh + p[0]); }
          c.fillStyle = p[1]; c.fill();
        });
        c.beginPath();
        for (var i = 0; i < n; i++) { var cx = specCol(i, n); if (S.spPk[i] > 0) c.rect(cx[0], SPX.bot - S.spPk[i] * h - 3, cx[1], 3); }
        c.fillStyle = "#ffe6b8"; c.fill();
        // Smoked glass with a reflection.
        glassOver(c, R, "specGlass", 140, 120, 1320, 590, "rgba(30,16,8,0.28)");
        specTime(c, S, S.T, "#c98a4a");
      },
    },
    mirror: {
      bg: "#0b0c10",
      stat: function (c, T, R) {
        c.fillStyle = "#0b0c10"; c.fillRect(0, 0, W, H);
        var g = c.createRadialGradient(W / 2, SPX.mid, 40, W / 2, SPX.mid, 900);
        g.addColorStop(0, "rgba(90,110,200,0.18)"); g.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        c.fillStyle = "rgba(255,255,255,0.12)"; c.fillRect(SPX.x0, SPX.mid - 0.75, SPX.x1 - SPX.x0, 1.5);
        // Album art, small, in the corner.
        var art = R._artReady();
        c.save(); rr(c, 60, 50, 110, 110, 10); c.clip();
        var ok = false;
        if (art) {
          try { var iw = art.naturalWidth || art.width, ih = art.naturalHeight || art.height, s = Math.min(iw, ih); if (s > 0) { c.drawImage(art, (iw - s) / 2, (ih - s) / 2, s, s, 60, 50, 110, 110); ok = true; } } catch (e) { ok = false; }
        }
        if (!ok) { c.fillStyle = "#1c1e24"; c.fillRect(60, 50, 110, 110); }
        c.restore();
        specLabels(c, R._specHz(), R._specBands(), 718, "#7f86a0");
        specLine(c, T, false);
      },
      dyn: function (c, S, R) {
        var n = S.sp.length;
        c.fillStyle = R._grad("specM", function () {
          var g = c.createLinearGradient(0, SPX.mid - SPX.half, 0, SPX.mid + SPX.half);
          g.addColorStop(0, "#ff6fb1"); g.addColorStop(0.5, "#7aa2ff"); g.addColorStop(1, "#ff6fb1");
          return g;
        });
        c.beginPath();
        for (var i = 0; i < n; i++) { var cx = specCol(i, n), bh = Math.max(1.5, S.sp[i] * SPX.half); addRR(c, cx[0] + cx[1] * 0.15, SPX.mid - bh, cx[1] * 0.7, bh * 2, Math.min(cx[1] * 0.35, bh)); }
        c.fill();
        c.beginPath();
        for (i = 0; i < n; i++) {
          if (!(S.spPk[i] > 0)) continue;
          var cc = specCol(i, n), px = cc[0] + cc[1] / 2, ph = S.spPk[i] * SPX.half + 8;
          c.moveTo(px + 4, SPX.mid - ph); c.arc(px, SPX.mid - ph, 4, 0, TAU);
          c.moveTo(px + 4, SPX.mid + ph); c.arc(px, SPX.mid + ph, 4, 0, TAU);
        }
        c.fillStyle = "rgba(255,255,255,0.85)"; c.fill();
        specTime(c, S, S.T, "#7f86a0");
      },
    },
  };
  IMPL.spectrum = {
    bg: "#070808",
    bgFor: function (v) { return (SPEC_IMPL[v] || SPEC_IMPL.led).bg; },
    stat: function (c, T, v, R) { (SPEC_IMPL[v] || SPEC_IMPL.led).stat(c, T, R); },
    dyn: function (c, S, T, v, R) { S.T = T; (SPEC_IMPL[v] || SPEC_IMPL.led).dyn(c, S, R); },
  };

  function decodeSpectrum(p) {
    if (!p || typeof p.data !== "string" || (p.encoding && p.encoding !== "u8-db-third-80")) return null;
    var bands = Math.round(+p.bands) > 0 ? Math.round(+p.bands) : 16;
    var bytes;
    try { bytes = b64bytes(p.data); } catch (e) { return null; }
    var n = Math.floor(bytes.length / bands);
    if (!n) return null;
    var db = new Float32Array(n * bands);
    for (var i = 0; i < n * bands; i++) db[i] = bytes[i] / 3 - 80;
    var bucket = +p.bucketSeconds > 0 ? +p.bucketSeconds : 0.05;
    var hz = Array.isArray(p.bandHz) && p.bandHz.length === bands ? p.bandHz.map(Number) : null;
    if (!hz) { hz = []; for (i = 0; i < bands; i++) hz.push(40 * Math.pow(250, i / Math.max(1, bands - 1))); }
    return { bucketSeconds: bucket, duration: +p.duration > 0 ? +p.duration : n * bucket, bands: bands, bandHz: hz, db: db };
  }
  function specReference(sp) {
    var v = [];
    for (var i = 0; i < sp.db.length; i++) if (sp.db[i] > -79.5) v.push(sp.db[i]);
    if (v.length < sp.bands) return -20;
    v.sort(function (a, b) { return a - b; });
    return v[Math.floor(v.length * 0.95)];
  }

  // ---------------------------------------------------------------------------
  // Lyrics. Synced (LRC) lyrics scroll with the interpolated position; plain
  // lyrics auto-scroll with progress; otherwise "Instrumental" or "No lyrics".
  function parseLrc(text) {
    var out = [], offset = 0;
    str(text).split(/\r?\n/).forEach(function (line) {
      var m, stamps = [], rest = line.trim(), re = /^\[([^\]]*)\]/;
      while ((m = re.exec(rest))) {
        var tag = m[1].trim(), ts = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(tag);
        if (ts) stamps.push(+ts[1] * 60 + +ts[2] + (ts[3] ? +ts[3] / Math.pow(10, ts[3].length) : 0));
        else {
          var off = /^offset:\s*([+-]?\d+)$/i.exec(tag);
          if (off) offset = +off[1] / 1000;
        }
        rest = rest.slice(m[0].length).trim();
      }
      stamps.forEach(function (t) { out.push({ t: t, text: rest }); });
    });
    // A positive offset makes the lyrics come sooner.
    out.forEach(function (l) { l.t = Math.max(0, l.t - offset); });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }
  var LYR_VARIANTS = [["artwork", "Artwork"], ["black", "Black"]];
  // Wrap to at most two lines, shrinking first; cached per text and size.
  function lyrWrap(R, c, text, size, weight, maxW) {
    var key = size + "|" + weight + "|" + text, hit = R.lyrCache[key];
    if (hit) return hit;
    var s = size, lines;
    for (var k = 0; k < 4; k++) {
      font(c, weight, s, SANS);
      lines = wrapLines(c, text, maxW, 2);
      if (lines.length < 2 || s <= size * 0.75) break;
      s *= 0.92;
    }
    hit = R.lyrCache[key] = { s: s, lines: lines };
    return hit;
  }
  IMPL.lyrics = {
    bg: "#000000",
    bgFor: function () { return "#000000"; },
    stat: function (c, T, v, R) {
      c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
      if (v !== "black") {
        // A cheap blur: the art drawn tiny, then scaled up with smoothing.
        var art = R._artReady(), small = art ? makeCanvas(24, 14) : null, sc = null;
        try { sc = small && small.getContext("2d"); } catch (e) { sc = null; }
        if (sc) {
          try {
            var iw = art.naturalWidth || art.width, ih = art.naturalHeight || art.height, s = Math.min(iw, ih * 16 / 9);
            sc.drawImage(art, (iw - s) / 2, (ih - s * 9 / 16) / 2, s, s * 9 / 16, 0, 0, 24, 14);
            c.save(); c.imageSmoothingEnabled = true; c.drawImage(small, -60, -40, W + 120, H + 80); c.restore();
          } catch (e) { /* art not drawable: fall through to the wash */ }
        }
        c.fillStyle = "rgba(0,0,0,0.58)"; c.fillRect(0, 0, W, H);
        var g = c.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "rgba(60,40,110,0.35)"); g.addColorStop(1, "rgba(10,60,80,0.3)");
        c.fillStyle = g; c.fillRect(0, 0, W, H);
      }
      c.textAlign = "center"; c.textBaseline = "alphabetic";
      c.fillStyle = "rgba(255,255,255,0.6)";
      c.fillText(fit(c, 500, 24, SANS, join([T.title, T.artist], "  ·  "), 1200, 0.7), W / 2, 70);
      var L = R.lyr;
      if (L.mode === "plain") { font(c, 500, 16, MONO); c.fillStyle = "rgba(255,255,255,0.4)"; c.textAlign = "right"; c.fillText("UNSYNCED", 1520, 70); }
      if (L.mode === "instrumental" || L.mode === "none") {
        c.textAlign = "center";
        if (L.mode === "instrumental") { c.fillStyle = "#fff"; c.fillText(fit(c, 300, 110, SANS, "Instrumental", 1300, 0.6), W / 2, 480); }
        else {
          c.fillStyle = "#fff"; c.fillText(fit(c, 600, 64, SANS, T.title || "Nothing playing", 1300, 0.6), W / 2, 420);
          c.fillStyle = "rgba(255,255,255,0.65)"; c.fillText(fit(c, 400, 34, SANS, T.artist, 1300, 0.7), W / 2, 478);
          c.fillStyle = "rgba(255,255,255,0.4)"; c.fillText(fit(c, 500, 22, MONO, "NO LYRICS", 600, 0.7), W / 2, 560);
        }
      }
      c.textAlign = "left";
    },
    dyn: function (c, S, T, v, R) {
      var L = R.lyr, cy = 450;
      c.textAlign = "center"; c.textBaseline = "middle";
      if (L.mode === "synced") {
        var ls = L.lines, cur = -1;
        for (var i = 0; i < ls.length && ls[i].t <= S.pos + 0.05; i++) cur = i;
        var next = ls[cur + 1], gap = (next ? next.t : S.dur || S.pos + 99) - S.pos;
        var gapping = (cur < 0 || !ls[cur].text) && gap > 6;
        for (var k = -3; k <= 4; k++) {
          var idx = cur + k;
          if (idx < 0 || idx >= ls.length || !ls[idx].text) continue;
          var d = idx - S.lyScroll, y = cy + d * 96 + (d > 0 ? 30 : d < 0 ? -30 : 0);
          if (y < 110 || y > 800) continue;
          var isCur = idx === cur && !gapping, w = lyrWrap(R, c, ls[idx].text, isCur ? 64 : 38, isCur ? 600 : 500, 1300);
          font(c, isCur ? 600 : 500, w.s, SANS);
          c.fillStyle = isCur ? "#ffffff" : "rgba(255,255,255," + Math.max(0.12, 0.5 - Math.abs(d) * 0.1).toFixed(3) + ")";
          var lh = w.s * 1.15;
          w.lines.forEach(function (t, j) { c.fillText(t, W / 2, y + (j - (w.lines.length - 1) / 2) * lh); });
        }
        if (gapping) {
          var pulse = 0.35 + 0.35 * Math.sin((S.pos % 2) * Math.PI);
          font(c, 400, 72, SANS); c.fillStyle = "rgba(255,255,255," + pulse.toFixed(3) + ")"; c.fillText("♪", W / 2, cy);
        }
      } else if (L.mode === "plain") {
        var pl = L.lines, pos = S.progress * Math.max(0, pl.length - 1);
        for (var j2 = Math.floor(pos) - 4; j2 <= Math.floor(pos) + 5; j2++) {
          if (j2 < 0 || j2 >= pl.length || !pl[j2]) continue;
          var y2 = cy + (j2 - pos) * 70;
          if (y2 < 110 || y2 > 800) continue;
          var w2 = lyrWrap(R, c, pl[j2], 40, 500, 1300);
          font(c, 500, w2.s, SANS); c.fillStyle = "rgba(255,255,255," + Math.max(0.1, 0.55 - Math.abs(j2 - pos) * 0.09).toFixed(3) + ")";
          c.fillText(w2.lines.join(" "), W / 2, y2);
        }
      }
      c.textBaseline = "alphabetic";
      font(c, 500, 22, MONO); c.fillStyle = "rgba(255,255,255,0.5)"; c.fillText(timeText(S), W / 2, 860);
      c.textAlign = "left";
    },
  };

  // ---------------------------------------------------------------------------
  // Clock: a standby screen. Local time and date; the track small at the
  // bottom only while something plays. The block drifts a few pixels each
  // minute and the screen dims to 70% after 10 idle minutes (TV burn-in care).
  var CLOCK_VARIANTS = [["digital", "Digital"], ["flip", "Flip"], ["analog", "Analogue"]];
  function hour12(fmt) {
    if (fmt === "12") return true;
    if (fmt === "24") return false;
    try {
      var o = new root.Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
      if (o.hourCycle) return o.hourCycle === "h11" || o.hourCycle === "h12";
      return !!o.hour12;
    } catch (e) { return false; }
  }
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function dateText(d) {
    try { return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }); }
    catch (e) { return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; }
  }
  function clockParts(d, h12) {
    var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds(), ms = d.getMilliseconds();
    var hh = h12 ? ((h + 11) % 12) + 1 : h;
    return { h: h, m: m, s: s, ms: ms, hs: h12 ? String(hh) : (hh < 10 ? "0" : "") + hh, ms2: (m < 10 ? "0" : "") + m, ap: h12 ? (h < 12 ? "AM" : "PM") : "" };
  }
  function orbit(d) { var k = (d.getHours() * 60 + d.getMinutes()) % 8; return [Math.round(Math.cos(k * Math.PI / 4) * 8), Math.round(Math.sin(k * Math.PI / 4) * 8)]; }
  function clockNow(R) { return new root.Date(); }
  function flipTile(c, x, y, w, h, digit, top) {
    // One half (top or bottom) of a split-flap tile with its digit.
    c.save(); c.beginPath(); c.rect(x, top ? y : y + h / 2, w, h / 2); c.clip();
    rr(c, x, y, w, h, 18);
    c.fillStyle = top ? "#26272b" : "#1d1e21"; c.fill();
    font(c, 700, h * 0.78, SANS); c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = "#ecebe7"; c.fillText(digit, x + w / 2, y + h / 2 + h * 0.03);
    c.restore();
  }
  IMPL.clock = {
    bg: "#050506",
    bgFor: function () { return "#050506"; },
    keyExtra: function (R) {
      var d = clockNow(R), h12 = hour12(R.clockFmt), S = R.S;
      return [orbit(d).join(","), dateText(d), h12, S.playing && R.T.title ? 1 : 0].join("/");
    },
    cadence: function (R) {
      if (R.variant === "analog") return 100;
      if (R.variant === "flip" && R.flip && now() - R.flip.t0 < 700) return 33;
      return 250;
    },
    stat: function (c, T, v, R) {
      var d = clockNow(R), o = orbit(d), S = R.S;
      c.fillStyle = "#050506"; c.fillRect(0, 0, W, H);
      var g = c.createRadialGradient(W / 2, 400, 40, W / 2, 400, 900);
      g.addColorStop(0, "rgba(60,64,72,0.22)"); g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      c.save(); c.translate(o[0], o[1]);
      c.textAlign = "center"; c.textBaseline = "alphabetic";
      if (v === "analog") {
        var cx = W / 2, cy = 400, r = 300;
        c.save(); c.shadowColor = "rgba(0,0,0,0.8)"; c.shadowBlur = 40 * SHADOW_SCALE; c.shadowOffsetY = 14 * SHADOW_SCALE;
        metal(c, cx, cy, r + 14, "#6b6f76", "#1b1c1f"); c.restore();
        var fg = c.createRadialGradient(cx - 80, cy - 100, 20, cx, cy, r);
        fg.addColorStop(0, "#2a2c31"); fg.addColorStop(1, "#111215");
        disc(c, cx, cy, r, fg);
        c.beginPath();
        for (var i = 0; i < 60; i++) {
          var a = i * TAU / 60, big = i % 5 === 0, r0 = big ? r - 44 : r - 20;
          c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10));
        }
        c.strokeStyle = "rgba(236,235,231,0.7)"; c.lineWidth = 2; c.stroke();
        c.beginPath();
        for (i = 0; i < 12; i++) { var a2 = i * TAU / 12; c.moveTo(cx + Math.cos(a2) * (r - 46), cy + Math.sin(a2) * (r - 46)); c.lineTo(cx + Math.cos(a2) * (r - 12), cy + Math.sin(a2) * (r - 12)); }
        c.strokeStyle = "#ecebe7"; c.lineWidth = 7; c.stroke();
        font(c, 500, 26, SANS); c.fillStyle = "rgba(236,235,231,0.6)"; c.fillText(dateText(d), cx, 762);
      } else {
        font(c, 400, 40, SANS); c.fillStyle = "rgba(236,235,231,0.65)"; c.fillText(dateText(d), W / 2, v === "flip" ? 690 : 640);
      }
      if (S.playing && T.title) {
        c.fillStyle = "rgba(236,235,231,0.75)";
        c.fillText(fit(c, 500, 26, SANS, join([T.title, T.artist], "  ·  "), 1100, 0.7), W / 2, 800);
        c.fillStyle = "rgba(255,255,255,0.12)"; c.fillRect(500, 824, 600, 2);
      }
      c.restore();
    },
    dyn: function (c, S, T, v, R) {
      var d = clockNow(R), p = clockParts(d, hour12(R.clockFmt)), o = orbit(d);
      c.save(); c.translate(o[0], o[1]);
      c.textAlign = "center"; c.textBaseline = "alphabetic";
      if (v === "analog") {
        var cx = W / 2, cy = 400, sec = p.s + p.ms / 1000, min = p.m + sec / 60, hr = (p.h % 12) + min / 60;
        var hand = function (a, len, tail, w, col) {
          var co = Math.cos(a - Math.PI / 2), si = Math.sin(a - Math.PI / 2);
          c.strokeStyle = col; c.lineWidth = w; c.lineCap = "round";
          c.beginPath(); c.moveTo(cx - co * tail, cy - si * tail); c.lineTo(cx + co * len, cy + si * len); c.stroke();
        };
        c.save(); c.translate(6, 8); hand(hr * TAU / 12, 170, 0, 16, "rgba(0,0,0,0.35)"); hand(min * TAU / 60, 250, 0, 11, "rgba(0,0,0,0.35)"); c.restore();
        hand(hr * TAU / 12, 170, 24, 14, "#ecebe7");
        hand(min * TAU / 60, 250, 24, 9, "#ecebe7");
        hand(sec * TAU / 60, 270, 50, 3, "#e0563f");
        c.lineCap = "butt";
        disc(c, cx, cy, 11, "#e0563f"); disc(c, cx, cy, 4, "#111");
      } else if (v === "flip") {
        var digits = (p.hs.length < 2 ? " " + p.hs : p.hs) + p.ms2, tw = 230, th = 330, gap = 22, x0 = W / 2 - (4 * tw + 3 * gap + 60) / 2, y0 = 200;
        if (!R.flip || R.flip.d !== digits) R.flip = { d: digits, prev: R.flip ? R.flip.d : digits, t0: now() };
        var k = clamp((now() - R.flip.t0) / 600, 0, 1);
        for (var i = 0; i < 4; i++) {
          var x = x0 + i * (tw + gap) + (i > 1 ? 60 : 0), nd = digits[i], od = R.flip.prev[i];
          c.save(); c.shadowColor = "rgba(0,0,0,0.6)"; c.shadowBlur = 20 * SHADOW_SCALE; c.shadowOffsetY = 10 * SHADOW_SCALE;
          rr(c, x, y0, tw, th, 18); c.fillStyle = "#1d1e21"; c.fill(); c.restore();
          if (nd === od || k >= 1) { flipTile(c, x, y0, tw, th, nd, true); flipTile(c, x, y0, tw, th, nd, false); }
          else {
            // Behind: new top, old bottom. The flap: old top falling, then new bottom landing.
            flipTile(c, x, y0, tw, th, nd, true); flipTile(c, x, y0, tw, th, od, false);
            c.save(); c.translate(0, y0 + th / 2);
            if (k < 0.5) { c.scale(1, 1 - k * 2); c.translate(0, -(y0 + th / 2)); flipTile(c, x, y0, tw, th, od, true); }
            else { c.scale(1, (k - 0.5) * 2); c.translate(0, -(y0 + th / 2)); flipTile(c, x, y0, tw, th, nd, false); }
            c.restore();
          }
          c.fillStyle = "#050506"; c.fillRect(x, y0 + th / 2 - 1.5, tw, 3);
        }
        c.textAlign = "center"; c.textBaseline = "alphabetic";
        if (p.ap) { font(c, 600, 26, SANS); c.fillStyle = "rgba(236,235,231,0.6)"; c.fillText(p.ap, W / 2, 180); }
      } else {
        font(c, 200, 300, SANS);
        var colon = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos((p.ms / 1000) * TAU));
        var wh = measure(c, p.hs), wm = measure(c, p.ms2), wc = measure(c, ":"), x1 = W / 2 - (wh + wc + wm) / 2;
        c.textAlign = "left"; c.fillStyle = "#ecebe7";
        c.fillText(p.hs, x1, 520); c.fillText(p.ms2, x1 + wh + wc, 520);
        c.fillStyle = "rgba(236,235,231," + colon.toFixed(3) + ")"; c.fillText(":", x1 + wh, 505);
        font(c, 300, 44, SANS); c.fillStyle = "rgba(236,235,231,0.45)";
        c.fillText((p.s < 10 ? "0" : "") + p.s + (p.ap ? " " + p.ap : ""), x1 + wh + wc + wm + 18, 520);
      }
      if (S.playing && T.title) {
        c.fillStyle = "rgba(236,235,231,0.6)"; c.fillRect(500, 824, 600 * S.progress, 2);
      }
      c.restore();
      // Idle for 10 minutes: dim to 70%.
      if (R.idleT0 != null && now() - R.idleT0 > 600000) { c.fillStyle = "rgba(0,0,0,0.3)"; c.fillRect(0, 0, W, H); }
    },
  };

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
      lyScroll: null, sp: new Float32Array(16), spPk: new Float32Array(16), spT: new Float32Array(16),
      lamp: [false, false], lampT: [1, 1], reelL: 0, reelR: 0, rrL: 0, rrR: 0, platter: 0, platterW: 0, strobe: 0, armR: null, tip: [0, 0], lift: 0, retFrom: null, beltPos: 0, ttT: 0,
    };
    this.grads = {}; this.layer = null; this.layerKey = ""; this.label = null; this.labelKey = "";
    this.fontGen = 0; this.art = null; this.artUrl = ""; this.artImg = null;
    this.raf = 0; this.timer = 0; this.lastT = 0; this.lastFrame = 0; this.dead = false; this.needSize = true;
    this.box = { bw: 0, bh: 0, lw: 0, lh: 0, ox: 0, oy: 0 };
    this.lyr = { mode: "none", lines: [] }; this.lyrCache = {}; this.clockFmt = "auto"; this.idleT0 = now();
    this.setView(opts.view, opts.variant);

    if (canvas.style && !canvas.style.width) { canvas.style.width = "100%"; canvas.style.height = "100%"; canvas.style.display = "block"; }
    this._onResize = function () { self.needSize = true; self._wake(); };
    this._onVis = function () { self._wake(); };
    this._onFonts = function () { self.fontGen++; FONT_GEN++; self._wake(); };
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
  // The track's typical crest factor: median of peak dB - RMS dB per bucket.
  function crestOf(lv) {
    var d = [], i;
    [["rmsL", "peakL"], ["rmsR", "peakR"]].forEach(function (k) {
      var r = lv[k[0]], p = lv[k[1]];
      for (i = 0; i < r.length; i++) if (r[i] > 0 && p[i] > 0) d.push(dbfs(p[i]) - dbfs(r[i]));
    });
    if (!d.length) return 0;
    d.sort(function (a, b) { return a - b; });
    return Math.max(0, d[Math.floor(d.length / 2)]);
  }
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
    this.crest = this.levels ? crestOf(this.levels) : 0;
    this._wake();
  };
  // Lyrics as the Core's /api/lyrics returns them: { synced, plain, instrumental }.
  P.setLyrics = function (l) {
    var L = { mode: "none", lines: [] };
    if (l) {
      var ls = l.synced ? parseLrc(l.synced) : [];
      if (ls.some(function (x) { return x.text; })) L = { mode: "synced", lines: ls };
      else if (str(l.plain)) L = { mode: "plain", lines: str(l.plain).split(/\r?\n/).map(function (x) { return x.trim(); }) };
      else if (l.instrumental) L.mode = "instrumental";
    }
    this.lyr = L; this.lyrCache = {}; this.S.lyScroll = null;
    this._wake();
  };
  P.setClockFormat = function (f) { this.clockFmt = f === "12" || f === "24" ? f : "auto"; this._wake(); };
  P.setSpectrum = function (sp) {
    this.spec = sp && sp.db && sp.bands > 0 && sp.bucketSeconds > 0 ? sp : null;
    this.specTop = this.spec ? specReference(this.spec) + 6 : 0;
    var n = this.spec ? this.spec.bands : 16;
    if (this.S.sp.length !== n) { this.S.sp = new Float32Array(n); this.S.spPk = new Float32Array(n); this.S.spT = new Float32Array(n); }
    this._wake();
  };
  P._specBands = function () { return this.spec ? this.spec.bands : 16; };
  P._specHz = function () {
    if (this.spec) return this.spec.bandHz;
    var hz = [];
    for (var i = 0; i < 16; i++) hz.push(40 * Math.pow(250, i / 15));
    return hz;
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
    this.layer = this.label = this.arm = this.art = this.artImg = null; this.grads = {};
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
    if (this.S.playing && this.T.title) this.idleT0 = null; else if (this.idleT0 == null) this.idleT0 = t;
    this._draw();
    // The clock keeps ticking while paused, at its own gentle cadence.
    var cad = IMPL[this.view].cadence;
    this._schedule(cad ? cad(this) : settled ? 250 : 0);
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
      // Both in VU units: the bar is the VU value; the hold is the sample peak
      // less this track's typical crest, so it sits just above the bar.
      var m = S.ppm[c], d = playing ? vu : -60;
      var pkRel = playing && p > 0 ? dbfs(p) - (this.vuRef == null ? VU_REF_DEFAULT : this.vuRef) - (this.crest || 0) : -60;
      m.lvl = d > m.lvl ? d : Math.max(d, m.lvl - (20 / 0.65) * dt);
      var topv = Math.max(m.lvl, pkRel);
      if (topv >= m.hold) { m.hold = topv; m.holdT = 1.0; }
      else if ((m.holdT -= dt) <= 0) m.hold = Math.max(topv, m.hold - 16 * dt);
      // The lamp follows the NEEDLE into the red (past +1 VU), not the raw
      // level: a transient the needle never reaches must not light it. It
      // stays lit at least 150 ms while the needle is near the line, and once
      // out stays out 150 ms, so it cannot flicker at the boundary.
      S.lampT[c] += dt;
      if (S.lamp[c]) {
        if (!playing || n.x < VU_LAMP - 0.02 || (n.x < VU_LAMP && S.lampT[c] >= 0.15)) { S.lamp[c] = false; S.lampT[c] = 0; }
      } else if (playing && n.x >= VU_LAMP && S.lampT[c] >= 0.15) { S.lamp[c] = true; S.lampT[c] = 0; }
      if (Math.abs(n.v) > 0.002 || Math.abs(n.x - target) > 0.001 || m.hold > PLO - 0.5) settled = false;
    }
    // Mechanics follow the position delta: a paused player is still.
    S.reelL = (S.reelL + (dpos * TAPE) / reelRadius(1 - S.progress)) % TAU;
    S.reelR = (S.reelR + (dpos * TAPE) / reelRadius(S.progress)) % TAU;
    S.rrL = (S.rrL + (dpos * TAPE_REEL) / reelPack(1 - S.progress)) % TAU;
    S.rrR = (S.rrR + (dpos * TAPE_REEL) / reelPack(S.progress)) % TAU;
    // The platter is a flywheel on a belt: it turns by the wall clock at a
    // constant 33⅓ while playing, spins up and down over ~0.8 s, and ignores
    // the position corrections that the reels and the arm follow.
    var acc = (PLATTER / 0.8) * dt;
    S.platterW += clamp((S.playing ? PLATTER : 0) - S.platterW, -acc, acc);
    S.platter = (S.platter + S.platterW * dt) % TAU;
    // A strobe lit at the frame rate sees the dots hold still at exact speed.
    S.strobe = (S.strobe + S.platterW * dt) % TAU;
    if (S.platterW === PLATTER) S.strobe = Math.round(S.strobe / STROBE_PITCH) * STROBE_PITCH;
    if (S.platterW !== 0) settled = false;
    // Lyrics: ease the scroll to the current line (~350 ms); seeks jump.
    if (this.lyr.mode === "synced") {
      var lsx = this.lyr.lines, lcur = -1;
      for (var li = 0; li < lsx.length && lsx[li].t <= S.pos + 0.05; li++) lcur = li;
      if (S.lyScroll == null || Math.abs(lcur - S.lyScroll) > 3) S.lyScroll = lcur;
      else S.lyScroll += (lcur - S.lyScroll) * Math.min(1, dt * 9);
      if (Math.abs(lcur - S.lyScroll) < 0.002) S.lyScroll = lcur; else settled = false;
    }
    // Spectrum bars: sampled at bucket middles like the levels.
    var SP = this.spec, nb = S.sp.length, spPlay = S.playing && !!SP, fr = 0, fi = 0, nfr = 0;
    if (spPlay) {
      nfr = Math.floor(SP.db.length / SP.bands);
      var xs = S.pos / SP.bucketSeconds - 0.5;
      if (xs > nfr) spPlay = false;
      xs = clamp(xs, 0, Math.max(0, nfr - 1.001)); fi = Math.floor(xs); fr = xs - fi;
    }
    for (var bI = 0; bI < nb; bI++) {
      var tv = 0;
      if (spPlay) {
        var d0 = SP.db[fi * SP.bands + bI], d1 = fi + 1 < nfr ? SP.db[(fi + 1) * SP.bands + bI] : d0;
        tv = clamp((d0 * (1 - fr) + d1 * fr - (this.specTop - 36)) / 36, 0, 1);
      }
      S.sp[bI] = tv >= S.sp[bI] ? tv : Math.max(tv, S.sp[bI] - (24 / 36) * dt);
      if (S.sp[bI] >= S.spPk[bI]) { S.spPk[bI] = S.sp[bI]; S.spT[bI] = 0.6; }
      else if ((S.spT[bI] -= dt) <= 0) S.spPk[bI] = Math.max(S.sp[bI], S.spPk[bI] - (18 / 36) * dt);
      if (S.sp[bI] > 0 || S.spPk[bI] > 0) settled = false;
    }
    // Belt sheen runs at the platter rim's speed; the "play clock" drives jitter.
    S.beltPos = ((S.beltPos || 0) + S.platterW * (TT.plat + 1) * dt) % 46;
    S.ttT = (S.ttT || 0) + dt * (S.platterW / PLATTER);
    // Tonearm. On the groove for the position; parked when nothing is loaded.
    // Near the end of a playing track it lifts, swings back to the lead-in and
    // lowers so the stylus lands as the next track starts (the Core's position
    // reset). A skip or seek moves it at most ~0.4 s across the record, lifted.
    var g = grooveRadius(S), lt = 0;
    if (S.armR == null) S.armR = g;
    var rem = S.dur - S.pos;
    if (S.playing && S.dur > 1.4 && rem < 1.4) {
      var ph = 1 - rem / 1.4;
      if (S.retFrom == null) S.retFrom = S.armR;
      var q = clamp((ph - 0.12) / 0.63, 0, 1);
      S.armR = S.retFrom + (TT.rIn - S.retFrom) * q * q * (3 - 2 * q);
      S.lift = ph < 0.12 ? ph / 0.12 : ph < 0.75 ? 1 : Math.max(0, (1 - ph) / 0.25);
      settled = false;
    } else {
      S.retFrom = null;
      var am = 420 * dt;
      if (Math.abs(g - S.armR) > 8 && S.dur > 0) lt = 1;
      S.armR += clamp(g - S.armR, -am, am);
      S.lift = (S.lift || 0) + clamp(lt - (S.lift || 0), -dt / 0.2, dt / 0.2);
      if (Math.abs(S.armR - g) > 0.01 || S.lift > 0) settled = false;
    }
    // Micro-movement: record eccentricity (once per turn, ~0.6 px) and a
    // little tracking jitter while it plays; none while lifted.
    var down = 1 - S.lift, wob = 0.55 * Math.sin(S.platter + 1.3) * down;
    var jit = S.platterW > 0 ? (0.09 * Math.sin(S.ttT * 23.7) + 0.05 * Math.sin(S.ttT * 41.3 + 1)) * down : 0;
    S.tip = armTip(S.armR + wob + jit);
    return settled;
  };

  P._measure = function () {
    this.needSize = false;
    var cv = this.canvas, el = cv.parentElement || cv;
    var cw = num(el.clientWidth, 0), ch = num(el.clientHeight, 0);
    var dpr = Math.min(this.pxCap, num(root.devicePixelRatio, 1) || 1);
    var bw = Math.max(0, Math.round(cw * dpr)), bh = Math.max(0, Math.round(ch * dpr));
    // Pin the CSS size to what was measured, so the bitmap (CSS x dpr) is
    // never shown at its intrinsic size: on a dpr-2 TV that crops the right
    // and bottom halves off and reads as a scene shifted left.
    if (cv.parentElement && cv.style && cw > 0 && ch > 0) {
      if (cv.style.width !== cw + "px") cv.style.width = cw + "px";
      if (cv.style.height !== ch + "px") cv.style.height = ch + "px";
    }
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    var s = Math.min(bw / W, bh / H), lw = Math.round(W * s), lh = Math.round(H * s);
    this.box = { bw: bw, bh: bh, lw: lw, lh: lh, ox: Math.floor((bw - lw) / 2), oy: Math.floor((bh - lh) / 2) };
  };

  P._staticLayer = function () {
    var V = IMPL[this.view], b = this.box, key = [this.view, this.variant, b.lw, b.lh, this.trackKey, this.fontGen, this.art ? this.artUrl : "", V.keyExtra ? V.keyExtra(this) : "", this.view === "lyrics" ? this.lyr.mode : "", this.spec ? this.spec.bands + ":" + this.spec.bandHz.join(",") : ""].join("|");
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

  // Dust specks and hairline scratches for this record: [r, angle, size].
  P._dust = function () {
    if (this.dustKey === this.trackKey && this.dust) return this.dust;
    var h = 7;
    for (var i = 0; i < this.trackKey.length; i++) h = (h * 31 + this.trackKey.charCodeAt(i)) >>> 0;
    var rnd = prng(h), sp = [], sc = [];
    for (i = 0; i < 70; i++) sp.push([TT.lab + 10 + rnd() * (TT.rec - TT.lab - 16), rnd() * TAU, 0.6 + rnd() * 1.2]);
    for (i = 0; i < 6; i++) sc.push([TT.rOut + rnd() * (TT.rIn - TT.rOut), rnd() * TAU, 0.05 + rnd() * 0.25]);
    this.dustKey = this.trackKey;
    this.dust = { specks: sp, scratches: sc };
    return this.dust;
  };

  P._armSprites = function () {
    var b = this.box, key = [b.lw, this.fontGen, this.variant].join("|");
    if (key === this.armKey) return this.arm;
    this.armKey = key; this.arm = null;
    var sc = b.lw / W, w = Math.max(1, Math.round(ARM.w * sc)), h = Math.max(1, Math.round(ARM.h * sc));
    var a = makeCanvas(w, h), sh = makeCanvas(w, h), ca = null, cs = null;
    try { ca = a && a.getContext("2d"); cs = sh && sh.getContext("2d"); } catch (e) { ca = cs = null; }
    if (!ca || !cs) return null;
    var kx = w / ARM.w, ky = h / ARM.h;
    ca.setTransform(kx, 0, 0, ky, -ARM.x0 * kx, -ARM.y0 * ky);
    drawArm(ca, false, this.variant);
    // The shadow: the silhouette drawn off-canvas so only its blur lands here.
    cs.setTransform(kx, 0, 0, ky, (-ARM.x0 - 4000) * kx, -ARM.y0 * ky);
    cs.shadowColor = "rgba(0,0,0,0.5)"; cs.shadowBlur = 10 * kx; cs.shadowOffsetX = 4000 * kx;
    drawArm(cs, true, this.variant);
    this.arm = [a, sh];
    return this.arm;
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

  // Variant lists live beside their drawing code; copy them into VIEWS.
  [["turntable", TT_VARIANTS], ["cassette", CAS_VARIANTS], ["meters", METER_VARIANTS], ["spectrum", SPEC_VARIANTS], ["lyrics", LYR_VARIANTS], ["clock", CLOCK_VARIANTS]].forEach(function (e) {
    VIEWS.filter(function (v) { return v.id === e[0]; })[0].variants = e[1].map(function (m) { return { id: m[0], name: m[1] }; });
  });

  return {
    VIEWS: VIEWS,
    decodeLevels: decodeLevels,
    decodeSpectrum: decodeSpectrum,
    parseLrc: parseLrc,
    formatText: formatText,
    create: function (canvas, opts) { return new Display(canvas, opts); },
  };
});
