import puppeteer from 'puppeteer-core';
const [,, url, out, wait = '8000', w = '1600', h = '1000', dpr = '2', full = '0'] = process.argv;
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox',
  headless: true,
  extraPrefsFirefox: { 'webgl.force-enabled': true, 'layout.css.devPixelsPerPx': dpr },
});
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.error('goto', e.message));
await new Promise(r => setTimeout(r, +wait));
await page.screenshot({ path: out, fullPage: full === '1' });
await browser.close();
console.log('saved', out);
