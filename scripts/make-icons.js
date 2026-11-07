// Regenerates PNG icons from public/icons/icon.svg (requires Playwright).
// Usage: node scripts/make-icons.js
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

(async () => {
  const dir = path.join(__dirname, '..', 'public', 'icons');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const shots = [
    ['icon-192.png', 192, 1, 'transparent'],
    ['icon-512.png', 512, 1, 'transparent'],
    ['apple-touch-icon.png', 180, 1, '#15130f'],
    ['icon-maskable-512.png', 512, 0.78, '#15130f'],
  ];
  for (const [name, size, scale, bg] of shots) {
    await page.setViewportSize({ width: size, height: size });
    const inner = Math.round(size * scale);
    await page.setContent(
      `<html><body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px">` +
        `<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
    );
    await page.screenshot({ path: path.join(dir, name), omitBackground: bg === 'transparent' });
    console.log('wrote', name);
  }
  await browser.close();
})();
