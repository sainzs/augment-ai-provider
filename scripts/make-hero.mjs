#!/usr/bin/env node
/**
 * Generate an animated terminal hero GIF for a repo, in the Random Access
 * palette (pure black #000000, mint #00ffb2) and Berkeley Mono Variable.
 *
 * Usage:
 *   node make-hero.mjs --config hero.config.mjs --out assets/hero.gif
 *
 * The config exports:
 *   export default {
 *     name: "repo-name",
 *     tag: "pi · opencode",
 *     sub: ["line 1", "line 2 (HTML <b> allowed)"],
 *     title: "window title",
 *     script: [
 *       { type: "cmd", text: "..." },
 *       { type: "out", text: "...", cls: "ok" },
 *       { type: "stream", lines: ["...", "..."] },
 *       { type: "gap" },
 *     ],
 *   }
 *
 * Requires: a Chrome with remote debugging on :9222 (browser-start.js) and ffmpeg.
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const configPath = flag("--config");
const outGif = resolve(flag("--out", "assets/hero.gif"));
const fps = Number(flag("--fps", 12));
if (!configPath) { console.error("missing --config"); process.exit(1); }
const cfg = (await import(pathToFileURL(resolve(configPath)).href)).default;

// --- HTML template ----------------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const scriptJson = JSON.stringify(cfg.script);
const subHtml = (cfg.sub || []).join("<br />");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:#000;--panel:#070707;--ink:#eee;--dim:#8a8a93;--faint:#55555e;--accent:#00ffb2;--green:#00ffb2;--border:#16181a}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg)}
body{font-family:"Berkeley Mono Variable","Berkeley Mono",ui-monospace,Menlo,monospace;color:var(--ink);padding:48px 56px;-webkit-font-smoothing:antialiased}
.wordmark{display:flex;align-items:baseline;gap:14px;margin-bottom:8px}
.wordmark .name{font-size:28px;font-weight:700;letter-spacing:-.5px}
.wordmark .tag{color:var(--accent);font-size:13px;font-weight:600}
.sub{color:var(--dim);font-size:14px;margin-bottom:28px;line-height:1.5}
.sub b{color:var(--ink);font-weight:600}
.term{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);width:880px}
.term-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#101013;border-bottom:1px solid var(--border)}
.dot{width:11px;height:11px;border-radius:50%}.dot.r{background:#ff5f57}.dot.y{background:#febc2e}.dot.g{background:#28c840}
.term-title{margin-left:10px;color:var(--faint);font-size:12px}
.term-body{padding:20px 22px 24px;font-size:13.5px;line-height:1.55;min-height:360px}
.p{color:var(--accent);font-weight:700}.cmd{color:var(--ink)}.out{color:var(--dim);white-space:pre-wrap}.ok{color:var(--green)}.hl{color:var(--ink)}
.line{display:block}.cursor{display:inline-block;width:8px;height:16px;background:var(--accent);vertical-align:-2px}
.cursor.blink{animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}.gap{height:14px}
</style></head><body>
<div class="wordmark"><span class="name">${esc(cfg.name)}</span><span class="tag">${esc(cfg.tag || "")}</span></div>
<div class="sub">${subHtml}</div>
<div class="term"><div class="term-bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="term-title">${esc(cfg.title || cfg.name)}</span></div>
<div class="term-body" id="body"></div></div>
<script>
const body=document.getElementById("body");
const SCRIPT=${scriptJson};
const TYPE_MS=34,LINE_MS=90,AFTER_CMD=260;
let cursor=null;
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const escH=(s)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;");
function newCursor(b=true){const c=document.createElement("span");c.className="cursor"+(b?" blink":"");return c;}
async function typeCommand(text){const line=document.createElement("div");line.innerHTML='<span class="p">$</span> <span class="cmd"></span>';const cs=line.querySelector(".cmd");body.appendChild(line);cursor=newCursor(false);line.appendChild(cursor);for(const ch of text){cs.textContent+=ch;line.appendChild(cursor);await wait(TYPE_MS);}await wait(AFTER_CMD);cursor.remove();}
async function showOut(t,cls){const line=document.createElement("div");line.innerHTML='<span class="out '+(cls||"")+'">'+escH(t)+"</span>";body.appendChild(line);}
async function streamLines(lines){const box=document.createElement("div");box.className="out";body.appendChild(box);for(const ln of lines){const s=document.createElement("span");s.className="line";s.textContent=ln;box.appendChild(s);await wait(LINE_MS);}}
function addGap(){const g=document.createElement("div");g.className="gap";body.appendChild(g);}
async function run(){for(const st of SCRIPT){if(st.type==="cmd")await typeCommand(st.text);else if(st.type==="out")await showOut(st.text,st.cls);else if(st.type==="stream")await streamLines(st.lines);else if(st.type==="gap")addGap();else if(st.type==="done"){const p=document.createElement("div");p.innerHTML='<span class="p">▊</span>';cursor=newCursor(true);p.appendChild(cursor);body.appendChild(p);}}window.__done=true;}
run();
</script></body></html>`;

// --- estimate duration ------------------------------------------------------
let ms = 1600; // end hold
for (const st of cfg.script) {
  if (st.type === "cmd") ms += st.text.length * 34 + 260;
  else if (st.type === "stream") ms += st.lines.length * 90;
  else if (st.type === "out") ms += 60;
}
ms += 800; // buffer

// --- record -----------------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), "hero-"));
const b = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await b.newPage();
await page.setViewport({ width: 1008, height: 640, deviceScaleFactor: 1 });
const htmlPath = join(dir, "hero.html");
await writeFile(htmlPath, html);
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);

const frames = Math.ceil((ms / 1000) * fps);
const interval = 1000 / fps;
process.stderr.write(`recording ${frames} frames over ~${Math.round(ms)}ms\n`);
for (let i = 0; i < frames; i++) {
  await writeFile(join(dir, `f${String(i).padStart(4, "0")}.png`), await page.screenshot({ type: "png" }));
  await new Promise((r) => setTimeout(r, interval));
}
const done = await page.evaluate(() => window.__done === true);
await b.disconnect();
process.stderr.write(`animation finished: ${done}\n`);

// --- assemble GIF -----------------------------------------------------------
const palette = join(dir, "palette.png");
let r = spawnSync("ffmpeg", ["-y", "-framerate", String(fps), "-i", join(dir, "f%04d.png"),
  "-vf", `fps=${fps},scale=880:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff`, palette], { stdio: "inherit" });
if (r.status !== 0) { console.error("palettegen failed"); process.exit(1); }
r = spawnSync("ffmpeg", ["-y", "-framerate", String(fps), "-i", join(dir, "f%04d.png"), "-i", palette,
  "-lavfi", `fps=${fps},scale=880:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4`, outGif], { stdio: "inherit" });
if (r.status !== 0) { console.error("paletteuse failed"); process.exit(1); }

await rm(dir, { recursive: true, force: true });
console.log(`wrote ${outGif}`);
