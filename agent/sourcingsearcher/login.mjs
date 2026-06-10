// SourcingSearcher 최초 1회 로그인 헬퍼.
// headed 크롬을 영속 프로필로 띄워 사이트에 직접 로그인 → 쿠키가 profile/ 에 저장된다.
// 이후 cron 은 같은 프로필을 headless 로 재사용하므로 로그인 유지.
//
// 사용법 (WSLg 필요):
//   cd agent/sourcingsearcher && DISPLAY=:0 node login.mjs
//   → 열리는 탭들에서 직접 로그인한 뒤, 터미널에서 Enter 를 누르면 저장하고 종료.
import { chromium } from 'playwright';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';

const BASE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(BASE, 'profile');

// .env 의 SITES (Name|URL;Name|URL) 에서 로그인할 URL 들을 읽는다.
function loginUrls() {
  const envPath = join(BASE, '.env');
  if (!fs.existsSync(envPath)) return ['https://www.google.com'];
  const m = fs.readFileSync(envPath, 'utf8').match(/^SITES=(.*)$/m);
  if (!m) return ['https://www.google.com'];
  return m[1].split(';').map(s => s.split('|').pop().trim()).filter(Boolean);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
});
const urls = loginUrls();
console.log(`프로필: ${PROFILE}`);
console.log(`${urls.length}개 사이트를 엽니다. 각 탭에서 직접 로그인하세요.`);
for (let i = 0; i < urls.length; i++) {
  const page = i === 0 ? (ctx.pages()[0] || await ctx.newPage()) : await ctx.newPage();
  try { await page.goto(urls[i], { timeout: 30000, waitUntil: 'domcontentloaded' }); }
  catch (e) { console.log(`  (열기 실패 ${urls[i]}: ${e.message})`); }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise(res => rl.question('\n로그인을 모두 마쳤으면 Enter 를 누르세요… ', res));
rl.close();
await ctx.close();
console.log('로그인 세션 저장 완료. 이제 cron(headless)이 이 프로필을 재사용합니다.');
