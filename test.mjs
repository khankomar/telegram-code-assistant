// تست محلی جریان اتصال مدل شخصی — بدون وابستگی خارجی
import worker from './worker.js';

// ---------- محیط شبیه‌سازی‌شده ----------
const kv = new Map();
const STATS = {
  get: async (k) => kv.get(k) ?? null,
  put: async (k, v, o) => kv.set(k, v),
  delete: async (k) => kv.delete(k)
};
const FILES = { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [] }) };
const dbCalls = [];
const DB = {
  prepare: (sql) => {
    const statement = {
      sql, values: [],
      bind(...values) { this.values = values; return this; },
      run: async () => { dbCalls.push({ sql, values: statement.values, method: 'run' }); return { meta: { changes: 1 } }; },
      all: async () => { dbCalls.push({ sql, values: statement.values, method: 'all' }); return { results: [] }; },
      first: async () => { dbCalls.push({ sql, values: statement.values, method: 'first' }); return null; }
    };
    return statement;
  },
  batch: async (statements) => { for (const s of statements) dbCalls.push({ sql: s.sql, values: s.values, method: 'batch' }); return {}; }
};
const env = { TELEGRAM_BOT_TOKEN: 'TEST', STATS, FILES, DB };

// ثبت پیام‌های تلگرام و درخواست‌های AI
const sent = [];
let aiCalls = [];
const githubCalls = [];
const ghResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.telegram.org')) {
    const body = JSON.parse(opts.body);
    sent.push({ endpoint: u.split('/').pop(), body });
    if (u.includes('answerCallbackQuery')) return new Response('{}');
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/chat/completions')) {
    aiCalls.push({ url: u, auth: opts.headers?.Authorization, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'OK', role: 'assistant' } }]
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('api.github.com')) {
    const parsed = new URL(u);
    const path = parsed.pathname;
    const method = opts.method || 'GET';
    githubCalls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (method === 'GET' && path === '/repos/acme/app') return ghResponse({ full_name: 'acme/app', default_branch: 'main', permissions: { push: true } });
    if (method === 'GET' && path === '/repos/acme/app/git/trees/main') return ghResponse({ truncated: false, tree: [
      { type: 'blob', path: 'README.md', size: 12, sha: 'blob-readme' },
      { type: 'blob', path: 'alpha.js', size: 11, sha: 'blob-alpha' }
    ] });
    if (method === 'GET' && path === '/repos/acme/app/git/blobs/blob-readme') return ghResponse({ encoding: 'base64', content: btoa('remote readme') });
    if (method === 'GET' && path === '/repos/acme/app/git/blobs/blob-alpha') return ghResponse({ encoding: 'base64', content: btoa('remote code') });
    if (method === 'GET' && path === '/repos/acme/app/git/ref/heads/main') return ghResponse({ object: { sha: 'head-sha' } });
    if (method === 'GET' && path === '/repos/acme/app/git/commits/head-sha') return ghResponse({ tree: { sha: 'base-tree' } });
    if (method === 'POST' && path === '/repos/acme/app/git/trees') return ghResponse({ sha: 'next-tree' });
    if (method === 'POST' && path === '/repos/acme/app/git/commits') return ghResponse({ sha: 'new-commit', html_url: 'https://github.com/acme/app/commit/new-commit' });
    if (method === 'PATCH' && path === '/repos/acme/app/git/refs/heads/main') return ghResponse({});
    return ghResponse({ message: `Unexpected mocked GitHub request: ${method} ${path}` }, 404);
  }
  return new Response('{}');
};

let updateId = 1000;
const msg = (text, userId = 42) => ({ update_id: updateId++, message: { chat: { id: userId }, from: { id: userId, username: 'tester' }, message_id: Math.floor(Math.random() * 100000), text } });
const cb = (data, userId = 42) => ({ update_id: updateId++, callback_query: { id: 'cb1', from: { id: userId }, data, message: { chat: { id: userId }, message_id: 1 } } });
const fire = async (update) => {
  const req = new Request('http://x/webhook', { method: 'POST', body: JSON.stringify(update), headers: { 'Content-Type': 'application/json' } });
  await worker.fetch(req, env, { waitUntil: () => {} });
  await new Promise(r => setTimeout(r, 20));
};
const lastBotMsg = () => [...sent].reverse().find(s => s.endpoint === 'sendMessage');

// ---------- تست ----------
let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (cond ? '' : ' | ' + JSON.stringify(extra)));
  if (!cond) failures++;
};

// ۱) /start باید منوی شیشه‌ای جمع‌وجور زیر پیام داشته باشد
await fire(msg('/start'));
const sk = lastBotMsg().body.reply_markup;
check('start با دکمه‌های inline', !!sk?.inline_keyboard && !sk.keyboard, sk);
check('دکمه اتصال در کیبورد', JSON.stringify(sk).includes('🔌 اتصال مدل'));

// ۲) /ai منو را نشان می‌دهد
await fire(msg('/ai'));
const menu = lastBotMsg();
check('منوی /ai', menu.body.text.includes('هوش مصنوعی شخصی'), menu.body.text);
check('منوی /ai با دکمه شیشه‌ای', !!menu.body.reply_markup?.inline_keyboard && menu.body.parse_mode === 'HTML');

// ۳) کلیک روی دکمه اتصال → قدم ۱
await fire(cb('ai:connect'));
check('قدم ۱ Base URL (دکمه inline)', lastBotMsg().body.text.includes('قدم ۱'), lastBotMsg().body.text);
check('کیبورد لغو', JSON.stringify(lastBotMsg().body.reply_markup).includes('❌ لغو'));

// ۴) URL نامعتبر رد می‌شود
await fire(msg('https://api.example.com'));
check('رد URL بدون /v1', lastBotMsg().body.text.includes('باید با'), lastBotMsg().body.text);

// ۵) URL معتبر → قدم ۲
await fire(msg('https://api.example.com/v1/'));
check('قدم ۲ API Key', lastBotMsg().body.text.includes('قدم ۲'), lastBotMsg().body.text);

// ۶) کلید نامعتبر رد می‌شود
await fire(msg('short'));
check('رد کلید کوتاه', lastBotMsg().body.text.includes('معتبر'), lastBotMsg().body.text);

// ۷) کلید معتبر → پیام پاک می‌شود + قدم ۳
await fire(msg('sk-test-1234567890abcdef'));
const deleted = sent.some(s => s.endpoint === 'deleteMessage');
check('قدم ۳ نام مدل', lastBotMsg().body.text.includes('قدم ۳'), lastBotMsg().body.text);
check('پیام کلید پاک شد', deleted);

// ۸) نام مدل → تست اتصال به URL کاربر + ذخیره
aiCalls = [];
await fire(msg('gpt-4o-mini'));
check('تست به URL کاربر', aiCalls[0]?.url === 'https://api.example.com/v1/chat/completions', aiCalls[0]?.url);
check('مدل کاربر', aiCalls[0]?.body.model === 'gpt-4o-mini', aiCalls[0]?.body.model);
check('کلید کاربر', aiCalls[0]?.auth === 'Bearer sk-test-1234567890abcdef', aiCalls[0]?.auth);
check('پیام موفقیت', lastBotMsg().body.text.includes('متصل شدی'), lastBotMsg().body.text);
const conn = JSON.parse(kv.get('ai_conn:42'));
check('کیبورد متصل (تغییر/حذف)', JSON.stringify(lastBotMsg().body.reply_markup).includes('🗑 حذف اتصال'));
check('ذخیره در KV', conn.model === 'gpt-4o-mini' && conn.base_url === 'https://api.example.com/v1');

// ۹) جریان پس از اتصال غیرفعال است (پیام عادی به چت می‌رود)
aiCalls = [];
await fire(msg('سلام ربات'));
check('چت با مدل کاربر', aiCalls.some(c => c.url.includes('api.example.com') && c.body.model === 'gpt-4o-mini'), aiCalls.map(c => c.url));

// ۱۰) وضعیت منو بعد از اتصال
await fire(msg('📊 وضعیت اتصال'));
check('وضعیت: مدل کاربر', lastBotMsg().body.text.includes('gpt-4o-mini'), lastBotMsg().body.text);
check('کلید ماسک شده', lastBotMsg().body.text.includes('••••') && !lastBotMsg().body.text.includes('sk-test-1234567890abcdef'));

// ۱۱) حذف اتصال با دکمه
await fire(msg('🗑 حذف اتصال'));
check('حذف اتصال', !kv.has('ai_conn:42') && lastBotMsg().body.text.includes('حذف شد'));

// ۱۱.۵) لغو وسط جریان
await fire(msg('🔌 اتصال مدل'));
await fire(msg('❌ لغو'));
check('لغو با دکمه', !kv.has('ai_flow:42') && JSON.stringify(lastBotMsg().body.reply_markup).includes('🔌 اتصال مدل'));
// دکمه شیشه‌ای قدیمی هنوز کار می‌کند
await fire(cb('ai:status'));
check('سازگاری دکمه قدیمی', lastBotMsg().body.text.includes('هوش مصنوعی شخصی'));

// ۱۲) کاربر دوم مستقل است (تفکیک per-user)
await fire(cb('ai:connect', 77));
await fire(msg('https://api.user2.com/v1', 77));
await fire(msg('key-user2-abcdefgh', 77));
await fire(msg('llama-3.3-70b', 77));
aiCalls = [];
await fire(msg('hi', 77));
check('تفکیک کاربر دوم', aiCalls.some(c => c.url.includes('api.user2.com') && c.body.model === 'llama-3.3-70b'), aiCalls.map(c => c.url));
check('کاربر اول جدا', !kv.has('ai_conn:42'));

// ۱۳) پروژه‌ها: حافظه و فضای کار جدا، بدون دست‌زدن به فضای پیش‌فرض
await fire(msg('/project new Alpha', 77));
const projects = JSON.parse(kv.get('projects:77') || '[]');
const alpha = projects.find(p => p.name === 'Alpha');
check('ساخت پروژه و فعال‌شدن خودکار', !!alpha && kv.get('active_project:77') === alpha.id, projects);
kv.set(`ws:77:project:${alpha.id}`, JSON.stringify({ name: 'alpha-files', files: [{ path: 'alpha.js', size: 1, text: 'a' }] }));
kv.set('ws:77', JSON.stringify({ name: 'legacy-files', files: [{ path: 'legacy.js', size: 1, text: 'l' }] }));
await fire(msg('/workspace', 77));
check('workspace پروژه مستقل است', lastBotMsg().body.text.includes('alpha.js') && !lastBotMsg().body.text.includes('legacy.js'), lastBotMsg().body.text);
dbCalls.length = 0;
await fire(msg('پیام در پروژه آلفا', 77));
check('خواندن و ذخیره حافظه در جدول پروژه', dbCalls.some(c => c.sql.includes('FROM project_chat_history')) && dbCalls.some(c => c.sql.includes('INSERT INTO project_chat_history')) && !dbCalls.some(c => c.sql.includes('INSERT INTO chat_history')), dbCalls);
await fire(msg('/project off', 77));
await fire(msg('/workspace', 77));
check('بازگشت به workspace پیش‌فرض بدون تغییر', lastBotMsg().body.text.includes('legacy.js') && !lastBotMsg().body.text.includes('alpha.js'), lastBotMsg().body.text);
dbCalls.length = 0;
await fire(msg('پیام در حالت پیش‌فرض', 77));
check('حافظهٔ پیش‌فرض همچنان جدا و دست‌نخورده است', dbCalls.some(c => c.sql.includes('FROM chat_history')) && dbCalls.some(c => c.sql.includes('INSERT INTO chat_history')) && !dbCalls.some(c => c.sql.includes('INSERT INTO project_chat_history')), dbCalls);

// ۱۴) منوی شیشه‌ای مدیریت پروژه‌ها
await fire(msg('/project', 77));
const projectMenu = lastBotMsg().body.reply_markup?.inline_keyboard;
check('منوی پروژه دکمهٔ ساخت و انتخاب دارد', !!projectMenu && JSON.stringify(projectMenu).includes('project:new') && JSON.stringify(projectMenu).includes(`project:use:${alpha.id}`), projectMenu);
check('راهنمای /project placeholderهای HTML را امن می‌فرستد', lastBotMsg().body.parse_mode === 'HTML' && lastBotMsg().body.text.includes('&lt;نام&gt;') && !lastBotMsg().body.text.includes('<نام>'), lastBotMsg().body.text);
await fire(cb('project:new', 77));
check('دکمهٔ ساخت پروژه درخواست نام می‌کند', lastBotMsg().body.text.includes('اسم پروژه') && JSON.stringify(lastBotMsg().body.reply_markup).includes('project:cancel'), lastBotMsg().body);
await fire(msg('Beta', 77));
const beta = JSON.parse(kv.get('projects:77') || '[]').find(p => p.name === 'Beta');
check('ساخت پروژه با دکمه و فعال‌شدن آن', !!beta && kv.get('active_project:77') === beta.id, beta);
await fire(cb(`project:use:${alpha.id}`, 77));
check('انتخاب پروژه با دکمه', kv.get('active_project:77') === alpha.id);
await fire(cb('project:off', 77));
check('بازگشت به فضای پیش‌فرض با دکمه', !kv.has('active_project:77'));

// ۱۵) اتصال و sync امن GitHub برای پروژه
await fire(cb(`project:use:${alpha.id}`, 77));
kv.set('gh_token:77', 'ghp_' + 'a'.repeat(40));
await fire(msg('/project repo acme/app main', 77));
const linkedRepo = JSON.parse(kv.get(`project_repo:77:${alpha.id}`) || 'null');
check('اتصال مخزن به پروژه', linkedRepo?.repo === 'acme/app' && linkedRepo.branch === 'main', linkedRepo);
await fire(cb('project:github', 77));
check('منوی GitHub دکمه‌های pull و push دارد', JSON.stringify(lastBotMsg().body.reply_markup).includes('project:pull') && JSON.stringify(lastBotMsg().body.reply_markup).includes('project:push'));
await fire(cb('project:pull', 77));
const pulledWorkspace = JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}');
check('pull فایل مخزن را به workspace پروژه می‌آورد', pulledWorkspace.files.some(f => f.path === 'README.md' && f.text === 'remote readme'), pulledWorkspace.files.map(f => f.path));
check('pull پیش‌فرض فایل هم‌نام محلی را حفظ می‌کند', pulledWorkspace.files.find(f => f.path === 'alpha.js')?.text === 'a', pulledWorkspace.files.find(f => f.path === 'alpha.js'));
await fire(msg('/project pull overwrite', 77));
const overwrittenWorkspace = JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}');
check('overwrite صریح نسخهٔ مخزن را جایگزین می‌کند', overwrittenWorkspace.files.find(f => f.path === 'alpha.js')?.text === 'remote code', overwrittenWorkspace.files.find(f => f.path === 'alpha.js'));
githubCalls.length = 0;
await fire(msg('/project push', 77));
check('push ابتدا پیش‌نمایش و دکمهٔ تأیید نشان می‌دهد', lastBotMsg().body.text.includes('تأیید ارسال') && JSON.stringify(lastBotMsg().body.reply_markup).includes('project:push_confirm') && githubCalls.length === 0);
await fire(cb('project:push_confirm', 77));
check('پس از تأیید، commit به GitHub ارسال می‌شود', githubCalls.some(c => c.method === 'POST' && c.url.includes('/git/commits')) && lastBotMsg().body.text.includes('ارسال کامل شد'), githubCalls);

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TESTS FAILED`);
process.exit(failures === 0 ? 0 : 1);
