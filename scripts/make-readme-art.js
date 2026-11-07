// Renders docs/banner.png and docs/screenshots.png for the README (requires Playwright).
// Usage: node scripts/make-readme-art.js   (expects docs/2-welcome.png, 5-sanction.png, 7-amber.png)
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');
const sigil = fs.readFileSync(path.join(root, 'public', 'icons', 'icon.svg'), 'utf8');
const dataUrl = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(docs, f)).toString('base64');
const fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;800&family=Share+Tech+Mono&family=VT323&display=swap">';

const banner = `<!doctype html><html><head>${fonts}<style>
  body{margin:0;width:1280px;height:400px;background:#030504;font-family:'Share Tech Mono',monospace}
  .frame{position:absolute;inset:14px;border-radius:10px;
    background:linear-gradient(90deg,#5c4423,#b4925a 18%,#e3c58b 50%,#b4925a 82%,#5c4423);padding:14px;
    box-shadow:inset 0 2px 0 rgba(255,255,255,.35),0 8px 30px #000}
  .rivet{position:absolute;width:12px;height:12px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#f5deaa,#6b5129 70%)}
  .screen{position:relative;height:100%;border-radius:18px/22px;overflow:hidden;
    background:radial-gradient(ellipse at 50% 45%,#0d2a19 0%,#04100a 60%,#000 100%);
    box-shadow:inset 0 0 60px #000,0 0 0 4px #15130f,0 0 0 6px #000;display:flex;align-items:center;gap:34px;padding:0 54px;box-sizing:border-box}
  .screen::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(180deg,transparent 0 2px,rgba(0,0,0,.33) 2px 3px)}
  .sig{width:210px;height:210px;flex:none;filter:drop-shadow(0 0 18px rgba(93,255,143,.35))}
  .sig svg{width:100%;height:100%}
  .txt{color:#5dff8f;text-shadow:0 0 10px rgba(93,255,143,.55)}
  .pre{font-family:'VT323';font-size:26px;letter-spacing:.2em;color:#2a9b55}
  h1{margin:4px 0 6px;font-family:Cinzel;font-weight:800;font-size:44px;letter-spacing:.07em;white-space:nowrap;line-height:1}
  .sub{font-size:23px;letter-spacing:.06em;color:#9dffbf}
  .meta{margin-top:16px;font-family:'VT323';font-size:24px;letter-spacing:.12em;color:#2a9b55}
  .meta b{color:#5dff8f;font-weight:normal}
</style></head><body>
<div class="frame">
  <div class="rivet" style="left:4px;top:4px"></div><div class="rivet" style="right:4px;top:4px"></div>
  <div class="rivet" style="left:4px;bottom:4px"></div><div class="rivet" style="right:4px;bottom:4px"></div>
  <div class="screen">
    <div class="sig">${sigil}</div>
    <div class="txt">
      <div class="pre">+++ MACHINE SPIRIT ACCESS POINT // ROM VERIFIED +++</div>
      <h1>LOCAL COGITATOR INTERFACE</h1>
      <div class="sub">A self-hosted chat UI for local agents</div>
    </div>
  </div>
</div></body></html>`;

const strip = `<!doctype html><html><head>${fonts}<style>
  body{margin:0;width:1280px;background:#030504;font-family:'VT323',monospace;color:#2a9b55}
  .row{display:flex;gap:28px;justify-content:center;padding:28px 28px 10px}
  figure{margin:0;text-align:center;font-size:24px;letter-spacing:.14em}
  img{width:370px;border-radius:26px;border:3px solid #5c4423;box-shadow:0 0 0 6px #15130f,0 10px 30px #000;display:block;margin-bottom:14px}
  figcaption{color:#5dff8f;text-shadow:0 0 8px rgba(93,255,143,.4)}
  figcaption.amber{color:#ffb53d;text-shadow:0 0 8px rgba(255,181,61,.4)}
  .foot{text-align:center;font-size:20px;letter-spacing:.3em;padding:6px 0 22px}
</style></head><body>
<div class="row">
  <figure><img src="${dataUrl('2-welcome.png')}"><figcaption>I. THE AWAKENING</figcaption></figure>
  <figure><img src="${dataUrl('5-sanction.png')}"><figcaption>II. A SANCTION SOUGHT</figcaption></figure>
  <figure><img src="${dataUrl('7-amber.png')}"><figcaption class="amber">III. THE SPIRIT ANSWERS</figcaption></figure>
</div>
<div class="foot">+++ PICT-CAPTURES RECOVERED FROM A FIELD COGITATOR +++</div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1280, height: 400 } });
  await page.setContent(banner, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(docs, 'banner.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(strip, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(docs, 'screenshots.png'), fullPage: true, type: 'png' });
  await browser.close();
  console.log('wrote docs/banner.png, docs/screenshots.png');
})();
