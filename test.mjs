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
const approvalRows = new Map();
const cloudflareSessionRows = new Map();
const cloudflareIntegrationRows = new Map();
const githubIntegrationRows = new Map();
const DB = {
  prepare: (sql) => {
    const statement = {
      sql, values: [],
      bind(...values) { this.values = values; return this; },
      run: async () => {
        dbCalls.push({ sql, values: statement.values, method: 'run' });
        let changes = 1;
        if (sql.includes('INSERT INTO cloudflare_connect_sessions')) {
          const [state_hash, user_id, chat_id, expires_at, created_at] = statement.values;
          cloudflareSessionRows.set(state_hash, { state_hash, user_id, chat_id, status: 'pending', expires_at, created_at });
        } else if (sql.includes('UPDATE cloudflare_connect_sessions')) {
          if (sql.includes("status = 'revoked'")) {
            for (const row of cloudflareSessionRows.values()) if (row.user_id === statement.values[0] && row.status === 'pending') row.status = 'revoked';
          } else {
            const [state_hash] = statement.values;
            const row = cloudflareSessionRows.get(state_hash);
            if (row) {
              if (sql.includes("status = 'processing'") && sql.includes("status = 'pending'")) {
                if (row.status === 'pending' && row.expires_at > statement.values[1]) row.status = 'processing'; else changes = 0;
              } else if (sql.includes("status = 'awaiting_confirmation'")) row.status = 'awaiting_confirmation';
              else if (sql.includes("status = 'failed'")) row.status = 'failed';
            } else changes = 0;
          }
        } else if (sql.includes('INSERT OR IGNORE INTO user_integrations')) {
          const [user_id, ciphertext, iv, metadata_json, created_at, updated_at] = statement.values;
          const key = `${user_id}:github`;
          if (!githubIntegrationRows.has(key)) githubIntegrationRows.set(key, { user_id, provider: 'github', ciphertext, iv, key_version: 1, metadata_json, created_at, updated_at });
          else changes = 0;
        } else if (sql.includes("VALUES (?, 'github', '', '', 1")) {
          const [user_id, metadata_json, created_at, updated_at] = statement.values;
          githubIntegrationRows.set(`${user_id}:github`, { user_id, provider: 'github', ciphertext: '', iv: '', key_version: 1, metadata_json, created_at, updated_at });
        } else if (sql.includes("VALUES (?, 'github', ?, ?, 1")) {
          const [user_id, ciphertext, iv, metadata_json, created_at, updated_at] = statement.values;
          githubIntegrationRows.set(`${user_id}:github`, { user_id, provider: 'github', ciphertext, iv, key_version: 1, metadata_json, created_at, updated_at });
        } else if (sql.includes('INSERT INTO user_integrations')) {
          const [user_id, ciphertext, iv, metadata_json, created_at, updated_at] = statement.values;
          cloudflareIntegrationRows.set(`${user_id}:cloudflare`, { user_id, ciphertext, iv, metadata_json, created_at, updated_at });
        } else if (sql.includes('DELETE FROM user_integrations')) {
          cloudflareIntegrationRows.delete(`${statement.values[0]}:cloudflare`);
        } else if (sql.includes('INSERT INTO action_approvals')) {
          const [id, chat_id, user_id, kind, payload_key, created_at, expires_at] = statement.values;
          approvalRows.set(id, { id, chat_id, user_id, kind, payload_key, status: 'pending', created_at, expires_at });
        } else if (sql.includes('UPDATE action_approvals')) {
          const v = statement.values;
          const row = approvalRows.get(v.length === 6 ? v[2] : v[2]);
          if (v.length === 6) {
            const [status, resolved_at, id, user_id, chat_id, now] = v;
            if (row && row.status === 'pending' && row.user_id === user_id && row.chat_id === chat_id && row.expires_at > now) {
              row.status = status; row.resolved_at = resolved_at;
            } else changes = 0;
          } else if (sql.includes("status = 'pending'")) {
            const [status, resolved_at, id] = v;
            if (row && row.status === 'pending') { row.status = status; row.resolved_at = resolved_at; }
            else changes = 0;
          } else {
            const [status, resolved_at, id] = v;
            if (row && row.status === 'executing') { row.status = status; row.resolved_at = resolved_at; }
            else changes = 0;
          }
        }
        return { meta: { changes } };
      },
      all: async () => { dbCalls.push({ sql, values: statement.values, method: 'all' }); return { results: [] }; },
      first: async () => {
        dbCalls.push({ sql, values: statement.values, method: 'first' });
        if (sql.includes('FROM action_approvals')) return approvalRows.get(statement.values[0]) || null;
        if (sql.includes('FROM cloudflare_connect_sessions')) return cloudflareSessionRows.get(statement.values[0]) || null;
        if (sql.includes("provider = 'github'")) return githubIntegrationRows.get(`${statement.values[0]}:github`) || null;
        if (sql.includes('FROM user_integrations')) return cloudflareIntegrationRows.get(`${statement.values[0]}:cloudflare`) || null;
        return null;
      }
    };
    return statement;
  },
  batch: async (statements) => { for (const s of statements) dbCalls.push({ sql: s.sql, values: s.values, method: 'batch' }); return {}; }
};
const env = { TELEGRAM_BOT_TOKEN: 'TEST', CLOUDFLARE_ENCRYPTION_KEY: btoa('E'.repeat(32)), CREDENTIALS_ENCRYPTION_KEY: btoa('G'.repeat(32)), STATS, FILES, DB };

// ثبت پیام‌های تلگرام و درخواست‌های AI
const sent = [];
let aiCalls = [];
let aiResponseQueue = [];
const githubCalls = [];
let githubErrorOverride = null;
const cloudflareCalls = [];
let cloudflareDnsRecord = { id: 'd'.repeat(32), type: 'A', name: 'old.example.com', content: '192.0.2.10', ttl: 300, proxied: false };
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
    const queued = aiResponseQueue.shift();
    if (queued?.__status) {
      const { __status, ...payload } = queued;
      return new Response(JSON.stringify(payload), { status: __status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(queued || {
      choices: [{ message: { content: 'OK', role: 'assistant' } }]
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('api.github.com')) {
    const parsed = new URL(u);
    const path = parsed.pathname;
    const method = opts.method || 'GET';
    githubCalls.push({ url: u, method, authorization: opts.headers?.Authorization, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (method === 'GET' && path === '/user' && githubErrorOverride) return ghResponse({ message: githubErrorOverride.message }, githubErrorOverride.status);
    if (method === 'GET' && path === '/user') return ghResponse({ login: 'tester', name: 'Test User', html_url: 'https://github.com/tester' });
    if (method === 'GET' && path === '/repos/acme/app') return ghResponse({ full_name: 'acme/app', default_branch: 'main', permissions: { push: true } });
    if (method === 'POST' && path === '/user/repos') return ghResponse({ full_name: `tester/${JSON.parse(opts.body).name}`, private: JSON.parse(opts.body).private, html_url: `https://github.com/tester/${JSON.parse(opts.body).name}`, default_branch: 'main' });
    if (method === 'GET' && path === '/repos/acme/app/git/trees/main') return ghResponse({ sha: 'tree-sha-1', truncated: false, tree: [
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
  if (u.includes('api.cloudflare.com/client/v4')) {
    const parsed = new URL(u);
    const path = parsed.pathname.replace('/client/v4', '');
    const method = opts.method || 'GET';
    const requestBody = opts.body ? JSON.parse(opts.body) : undefined;
    cloudflareCalls.push({ url: u, path, method, authorization: opts.headers?.Authorization, body: requestBody });
    if (method === 'GET' && path === '/user/tokens/verify') return ghResponse({ success: true, result: { id: 'cf-token-id', status: 'active', expires_on: '2027-01-01T00:00:00Z' } });
    if (method === 'GET' && path === '/zones') return ghResponse({ success: true, result: [{ id: 'a'.repeat(32), name: 'example.com', status: 'active', account: { name: 'Example' } }] });
    if (method === 'GET' && path === `/zones/${'a'.repeat(32)}/dns_records`) return ghResponse({ success: true, result: [cloudflareDnsRecord] });
    if (method === 'GET' && path === `/zones/${'a'.repeat(32)}/dns_records/${'d'.repeat(32)}`) return ghResponse({ success: true, result: cloudflareDnsRecord });
    if (method === 'POST' && path === `/zones/${'a'.repeat(32)}/dns_records`) return ghResponse({ success: true, result: { id: 'n'.repeat(32), ...requestBody } });
    if (method === 'PATCH' && path === `/zones/${'a'.repeat(32)}/dns_records/${'d'.repeat(32)}`) return ghResponse({ success: true, result: { ...cloudflareDnsRecord, ...requestBody } });
    if (method === 'DELETE' && path === `/zones/${'a'.repeat(32)}/dns_records/${'d'.repeat(32)}`) return ghResponse({ success: true, result: { id: 'd'.repeat(32) } });
    if (method === 'GET' && path === `/accounts/${'b'.repeat(32)}/workers/scripts`) return ghResponse({ success: true, result: [{ id: 'my-worker', modified_on: '2026-01-01T00:00:00Z' }] });
    if (method === 'GET' && path === `/accounts/${'b'.repeat(32)}/workers/scripts/my-worker/script-settings`) return ghResponse({ success: true, result: { logpush: true, observability: { enabled: true, logs: { enabled: true, invocation_logs: true, persist: false } } } });
    return ghResponse({ success: false, errors: [{ message: `Unexpected mocked Cloudflare request: ${method} ${path}` }] }, 404);
  }
  return new Response('{}');
};

let updateId = 1000;
const msg = (text, userId = 42) => ({ update_id: updateId++, message: { chat: { id: userId }, from: { id: userId, username: 'tester' }, message_id: Math.floor(Math.random() * 100000), text } });
const cb = (data, userId = 42) => ({ update_id: updateId++, callback_query: { id: 'cb1', from: { id: userId }, data, message: { chat: { id: userId }, message_id: 1 } } });
const fire = async (update) => {
  const req = new Request('https://x/webhook', { method: 'POST', body: JSON.stringify(update), headers: { 'Content-Type': 'application/json' } });
  await worker.fetch(req, env, { waitUntil: () => {} });
  await new Promise(r => setTimeout(r, 20));
};
const route = async (method, url, body = '') => worker.fetch(new Request(url, { method, body: method === 'POST' ? body : undefined, headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined }), env, { waitUntil: () => {} });
const lastBotMsg = () => [...sent].reverse().find(s => s.endpoint === 'sendMessage');

// ---------- تست ----------
let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (cond ? '' : ' | ' + JSON.stringify(extra)));
  if (!cond) failures++;
};

// ۱) /start باید منوی شیشه‌ای جمع‌وجور زیر پیام داشته باشد
await fire(msg('/start'));
const malformedWebhookResponse = await route('POST', 'https://x/webhook', '{not-json');
const malformedWebhookBody = await malformedWebhookResponse.text();
check('HTTP error boundary پاسخ عمومی بدون جزئیات parse یا stack می‌دهد', malformedWebhookResponse.status === 500 && malformedWebhookBody.includes('request_id') && !/SyntaxError|Unexpected token|worker\.js|at .*:\d+/.test(malformedWebhookBody), malformedWebhookBody);
const sk = lastBotMsg().body.reply_markup;
const telegramCommands = sent.find(s => s.endpoint === 'setMyCommands')?.body.commands || [];
const telegramCommandNames = telegramCommands.map(command => command.command);
check('فرمان‌های ربات در منوی رسمی تلگرام ثبت می‌شوند', ['start', 'help', 'ai', 'login', 'logout', 'project', 'github', 'github_off', 'cloudflare', 'workspace', 'workspace_clear', 'lang', 'search', 'debug', 'clear', 'new'].every(command => telegramCommandNames.includes(command)), telegramCommandNames);
check('start با دکمه‌های inline', !!sk?.inline_keyboard && !sk.keyboard, sk);
check('دکمه اتصال در کیبورد', JSON.stringify(sk).includes('🔌 اتصال مدل'));

// ۲) /ai منو را نشان می‌دهد
await fire(msg('/login'));
check('فرمان /login منوی اتصال مدل را باز می‌کند', lastBotMsg().body.text.includes('هوش مصنوعی شخصی'), lastBotMsg().body.text);
await fire(msg('/ai'));
const menu = lastBotMsg();
check('منوی /ai', menu.body.text.includes('هوش مصنوعی شخصی'), menu.body.text);
check('منوی /ai با دکمه شیشه‌ای', !!menu.body.reply_markup?.inline_keyboard && menu.body.parse_mode === 'HTML');

await fire(msg('/search'));
check('فرمان /search بدون عبارت راهنمایی می‌دهد', lastBotMsg().body.text.includes('/search Cloudflare Workers'), lastBotMsg().body.text);
await fire(msg('/debug'));
check('فرمان /debug بدون کد راهنمایی می‌دهد', lastBotMsg().body.text.includes('کد یا متن خطا'), lastBotMsg().body.text);

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
const privateProviderDetail = 'SENTINEL_PRIVATE_PROVIDER_DETAIL_DO_NOT_LEAK';
aiResponseQueue.push({ __status: 502, error: { message: privateProviderDetail } });
await fire(msg('لطفاً این سوال را پاسخ بده', 77));
check('خطای خام AI به کاربر ارسال نمی‌شود', !lastBotMsg().body.text.includes(privateProviderDetail) && lastBotMsg().body.text.includes('سرویس هوش مصنوعی'), lastBotMsg().body.text);
const privateGithubDetail = 'SENTINEL_GITHUB_INTERNAL_RESPONSE_DO_NOT_LEAK';
githubErrorOverride = { status: 401, message: privateGithubDetail };
await fire(msg(`/github ghp_${'e'.repeat(40)}`, 101));
check('جزئیات خام خطای GitHub به Telegram ارسال نمی‌شود', !lastBotMsg().body.text.includes(privateGithubDetail) && lastBotMsg().body.text.includes('دسترسی GitHub معتبر نیست') && !githubIntegrationRows.has('101:github'));
githubErrorOverride = null;

// ۱۲.۵) توکن GitHub در D1 رمز می‌شود و توکن‌های قدیمی KV به‌صورت lazy مهاجرت می‌شوند.
const githubToken = 'ghp_' + 'b'.repeat(40);
await fire(msg(`/github ${githubToken}`, 88));
const savedGithubCredential = githubIntegrationRows.get('88:github');
check('توکن جدید GitHub فقط به‌صورت ciphertext در D1 ذخیره می‌شود', !!savedGithubCredential?.ciphertext && !savedGithubCredential.ciphertext.includes(githubToken) && !kv.has('gh_token:88') && !JSON.stringify(sent.slice(-3)).includes(githubToken));
await fire(msg('/github', 88));
check('توکن رمز‌شدهٔ GitHub برای API قابل بازیابی است', githubCalls.some(c => c.url.endsWith('/user') && c.authorization === `Bearer ${githubToken}`) && lastBotMsg().body.text.includes('@tester'));

const legacyGithubToken = 'ghp_' + 'c'.repeat(40);
kv.set('gh_token:99', legacyGithubToken);
await fire(msg('/github', 99));
const migratedGithubCredential = githubIntegrationRows.get('99:github');
check('توکن legacy از KV به D1 رمز‌شده مهاجرت می‌کند و KV پاک می‌شود', !!migratedGithubCredential?.ciphertext && !migratedGithubCredential.ciphertext.includes(legacyGithubToken) && !kv.has('gh_token:99') && lastBotMsg().body.text.includes('@tester'));

await fire(msg('/github_off', 88));
const githubTombstone = githubIntegrationRows.get('88:github');
check('قطع اتصال GitHub داده را با tombstone امن از دسترس خارج می‌کند', JSON.parse(githubTombstone?.metadata_json || '{}').deleted === true && !kv.has('gh_token:88'));

const credentialKey = env.CREDENTIALS_ENCRYPTION_KEY;
const cloudflareKey = env.CLOUDFLARE_ENCRYPTION_KEY;
delete env.CREDENTIALS_ENCRYPTION_KEY;
delete env.CLOUDFLARE_ENCRYPTION_KEY;
const rejectedGithubToken = 'ghp_' + 'd'.repeat(40);
await fire(msg(`/github ${rejectedGithubToken}`, 100));
check('بدون کلید رمزگذاری توکن تازه هرگز به KV plaintext نوشته نمی‌شود', !kv.has('gh_token:100') && !githubIntegrationRows.has('100:github') && lastBotMsg().body.text.includes('CREDENTIALS_ENCRYPTION_KEY'));
env.CREDENTIALS_ENCRYPTION_KEY = credentialKey;
env.CLOUDFLARE_ENCRYPTION_KEY = cloudflareKey;

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
const overwritePrompt = lastBotMsg();
const overwriteCallback = overwritePrompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
check('overwrite پیش از تغییر فایل‌های متعارض preview و تأیید می‌خواهد', overwritePrompt.body.text.includes('فایل‌های هم‌نامی') && overwriteCallback?.startsWith('action:yes:') && JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}').files.find(f => f.path === 'alpha.js')?.text === 'a', overwritePrompt.body);
await fire(cb(overwriteCallback, 77));
const overwrittenWorkspace = JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}');
check('overwrite فقط پس از تأیید نسخهٔ مخزن را جایگزین می‌کند', overwrittenWorkspace.files.find(f => f.path === 'alpha.js')?.text === 'remote code', overwrittenWorkspace.files.find(f => f.path === 'alpha.js'));
githubCalls.length = 0;
await fire(msg('/project push', 77));
const pushPrompt = lastBotMsg();
const pushConfirm = pushPrompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
check('push ابتدا preview و تأیید یک‌بارمصرف نشان می‌دهد', pushPrompt.body.text.includes('تأیید ارسال') && pushConfirm?.startsWith('action:yes:') && githubCalls.length === 0);
await fire(cb(pushConfirm, 77));
check('پس از تأیید، commit به GitHub ارسال می‌شود', githubCalls.some(c => c.method === 'POST' && c.url.includes('/git/commits')) && lastBotMsg().body.text.includes('ارسال کامل شد'), githubCalls);

// ۱۶) تأیید پیش از تغییرات agent، با مالکیت per-user و جلوگیری از replay
aiResponseQueue.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-write-1', type: 'function', function: { name: 'workspace_write_file', arguments: JSON.stringify({ path: 'confirmed.js', content: 'export const ready = true;' }) } }] } }] });
await fire(msg('یک فایل confirmed.js بساز', 77));
const writePrompt = lastBotMsg();
const writeConfirm = writePrompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
const writeId = writeConfirm?.split(':')[2];
check('عامل قبل از نوشتن workspace تأیید می‌خواهد و فایلی هنوز نوشته نشده', writePrompt.body.text.includes('تأیید لازم است') && writeConfirm?.startsWith('action:yes:') && !JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}').files.some(f => f.path === 'confirmed.js'));
await fire(cb(writeConfirm, 42));
check('کاربر دیگر نمی‌تواند تأیید را مصرف کند', approvalRows.get(writeId)?.status === 'pending' && !JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}').files.some(f => f.path === 'confirmed.js'));
await fire(cb(writeConfirm, 77));
const afterWrite = JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}');
check('نوشتن بعد از تأیید موفق است', afterWrite.files.some(f => f.path === 'confirmed.js' && f.text === 'export const ready = true;') && approvalRows.get(writeId)?.status === 'completed');
await fire(cb(writeConfirm, 77));
check('تأیید تکراری عملیات را دوباره اجرا نمی‌کند', afterWrite.files.filter(f => f.path === 'confirmed.js').length === 1 && approvalRows.get(writeId)?.status === 'completed');

aiResponseQueue.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-write-stale', type: 'function', function: { name: 'workspace_write_file', arguments: JSON.stringify({ path: 'stale.js', content: 'must not write after preview changes' }) } }] } }] });
await fire(msg('فایل stale.js را بساز', 77));
const staleConfirm = lastBotMsg().body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
const staleId = staleConfirm?.split(':')[2];
const beforeConcurrentChange = JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}');
beforeConcurrentChange.files.push({ path: 'external.js', size: 1, text: 'x' });
kv.set(`ws:77:project:${alpha.id}`, JSON.stringify(beforeConcurrentChange));
await fire(cb(staleConfirm, 77));
const afterStaleConfirm = JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}');
check('تغییر workspace بعد از preview باعث لغو امن می‌شود', approvalRows.get(staleId)?.status === 'failed' && !afterStaleConfirm.files.some(f => f.path === 'stale.js') && afterStaleConfirm.files.some(f => f.path === 'external.js'));

aiResponseQueue.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-write-expired', type: 'function', function: { name: 'workspace_write_file', arguments: JSON.stringify({ path: 'expired.js', content: 'must not write' }) } }] } }] });
await fire(msg('یک فایل موقت بساز', 77));
const expiredPrompt = lastBotMsg();
const expiredConfirm = expiredPrompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
const expiredId = expiredConfirm?.split(':')[2];
approvalRows.get(expiredId).expires_at = Math.floor(Date.now() / 1000) - 1;
await fire(cb(expiredConfirm, 77));
check('دکمهٔ منقضی‌شده اجرا نمی‌شود و payload دور ریخته می‌شود', approvalRows.get(expiredId)?.status === 'expired' && !JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}').files.some(f => f.path === 'expired.js'));

// تغییر GitHub از طریق agent نیز تا تأیید انجام نمی‌شود.
githubCalls.length = 0;
aiResponseQueue.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-repo-1', type: 'function', function: { name: 'github_create_repo', arguments: JSON.stringify({ name: 'confirmed-repo', private: true }) } }] } }] });
await fire(msg('یک مخزن خصوصی confirmed-repo بساز', 77));
const repoPrompt = lastBotMsg();
const repoConfirm = repoPrompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
check('ساخت مخزن GitHub پیش از تأیید هیچ POSTای نمی‌فرستد', repoPrompt.body.text.includes('confirmed-repo') && !githubCalls.some(c => c.method === 'POST' && c.url.endsWith('/user/repos')));
await fire(cb(repoConfirm, 77));
check('ساخت مخزن پس از تأیید اجرا می‌شود', githubCalls.some(c => c.method === 'POST' && c.url.endsWith('/user/repos')) && lastBotMsg().body.text.includes('confirmed-repo'));

// لغوِ preview و مسیرهای مخرب مستقیم هم باید بدون تغییر تمام شوند.
const beforeClear = JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}').files.length;
await fire(msg('/workspace_clear', 77));
const clearPrompt = lastBotMsg();
const clearCancel = clearPrompt.body.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data;
check('پاک‌کردن workspace ابتدا تأیید می‌خواهد', clearPrompt.body.text.includes('تمام فایل‌های این workspace') && clearCancel?.startsWith('action:no:') && JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}').files.length === beforeClear);
await fire(cb(clearCancel, 77));
check('لغو پاک‌کردن workspace فایل‌ها را نگه می‌دارد', JSON.parse(kv.get(`ws:77:project:${alpha.id}`) || '{}').files.length === beforeClear && lastBotMsg().body.text.includes('هیچ تغییری اعمال نشد'));

await fire(msg('/project delete Beta', 77));
const deletePrompt = lastBotMsg();
const deleteConfirm = deletePrompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
check('حذف پروژه ابتدا دربارهٔ داده‌های حذف‌شونده هشدار می‌دهد', deletePrompt.body.text.includes('تاریخچهٔ گفتگو') && JSON.parse(kv.get('projects:77') || '[]').some(p => p.name === 'Beta'));
await fire(cb(deleteConfirm, 77));
check('پروژه فقط پس از تأیید حذف می‌شود', !JSON.parse(kv.get('projects:77') || '[]').some(p => p.name === 'Beta'));

// ۱۷) اتصال امن Cloudflare: HTTPS، state یک‌بارمصرف، AES-GCM و تأیید تلگرام
await fire(msg('/cloudflare', 42));
const cloudflareConnectMessage = lastBotMsg();
const cloudflareLink = cloudflareConnectMessage.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url;
const cloudflareState = cloudflareLink ? new URL(cloudflareLink).searchParams.get('state') : '';
check('/cloudflare لینک HTTPS خصوصی و موقت می‌سازد', cloudflareLink?.startsWith('https://x/connect/cloudflare?') && cloudflareState?.length >= 40, cloudflareConnectMessage.body);
const cloudflareGet = await route('GET', cloudflareLink);
const cloudflareForm = await cloudflareGet.text();
check('فرم توکن HTTPS دارای no-store و ورودی password است', cloudflareGet.status === 200 && cloudflareGet.headers.get('Cache-Control')?.includes('no-store') && cloudflareForm.includes('type="password"') && cloudflareForm.includes('name="state"'));
const cloudflareToken = 'cf-user-token-' + 'x'.repeat(40);
const cloudflarePost = await route('POST', 'https://x/connect/cloudflare', new URLSearchParams({ state: cloudflareState, token: cloudflareToken }).toString());
const cloudflarePostText = await cloudflarePost.text();
const cfApprovalMessage = lastBotMsg();
const cfApproval = cfApprovalMessage.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
const cfApprovalId = cfApproval?.split(':')[2];
const cfApprovalRow = approvalRows.get(cfApprovalId);
const cfEncryptedPayload = cfApprovalRow ? JSON.parse(kv.get(cfApprovalRow.payload_key) || '{}') : {};
check('توکن اعتبارسنجی می‌شود اما اتصال تا دکمهٔ تأیید تلگرام ذخیره نمی‌شود', cloudflarePost.status === 200 && cloudflarePostText.includes('به گفت‌وگوی خصوصی تلگرام برگرد') && cfApproval?.startsWith('action:yes:') && !cloudflareIntegrationRows.has('42:cloudflare'));
check('payload تأیید فقط ciphertext/iv دارد و متن توکن را نگه نمی‌دارد', !!cfEncryptedPayload.encrypted?.ciphertext && !!cfEncryptedPayload.encrypted?.iv && !JSON.stringify(cfEncryptedPayload).includes(cloudflareToken) && !JSON.stringify(sent.slice(-4)).includes(cloudflareToken));
check('session اتصال یک‌بارمصرف به کاربر خصوصی bind شده', [...cloudflareSessionRows.values()].some(s => s.user_id === '42' && s.chat_id === '42' && s.status === 'awaiting_confirmation'));
await fire(cb(cfApproval, 42));
const savedCloudflareRow = cloudflareIntegrationRows.get('42:cloudflare');
check('ذخیرهٔ credential فقط پس از تأیید موفق می‌شود و در D1 رمز شده است', !!savedCloudflareRow && !savedCloudflareRow.ciphertext.includes(cloudflareToken) && approvalRows.get(cfApprovalId)?.status === 'completed');
await fire(msg('/cloudflare status', 42));
check('وضعیت اتصال Cloudflare نمایش داده می‌شود', lastBotMsg().body.text.includes('وصله') && lastBotMsg().body.text.includes('cf-token-id'));
await fire({ update_id: updateId++, message: { chat: { id: -10042 }, from: { id: 42 }, message_id: 9001, text: '/cloudflare' } });
check('شروع اتصال Cloudflare در گروه رد می‌شود', lastBotMsg().body.text.includes('فقط در گفت‌وگوی خصوصی'));

kv.set('ai_conn:42', JSON.stringify(conn));
cloudflareCalls.length = 0;
aiResponseQueue.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'cf-zones-1', type: 'function', function: { name: 'cloudflare_list_zones', arguments: '{}' } }] } }] });
await fire(msg('چه دامنه‌هایی به Cloudflare وصل است؟', 42));
check('فهرست Zoneها به Cloudflare API خواندنی وصل است', cloudflareCalls.some(c => c.method === 'GET' && c.path === '/zones') && !lastBotMsg().body.reply_markup?.inline_keyboard?.some(row => JSON.stringify(row).includes('action:yes:')));
aiResponseQueue.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'cf-workers-1', type: 'function', function: { name: 'cloudflare_list_workers', arguments: JSON.stringify({ account_id: 'b'.repeat(32) }) } }] } }] });
await fire(msg('فهرست Workerهای اکانت را ببین', 42));
check('فهرست Workerها به account_id محدود است و فقط metadata برمی‌گرداند', cloudflareCalls.some(c => c.path.endsWith('/workers/scripts')) && !JSON.stringify(cloudflareCalls.slice(-2)).includes('secret_text'));

// DNS write باید preview و تأیید داشته باشد؛ تغییر رکورد بعد از preview باعث abort می‌شود.
cloudflareCalls.length = 0;
aiResponseQueue.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'cf-create-1', type: 'function', function: { name: 'cloudflare_create_dns_record', arguments: JSON.stringify({ zone_id: 'a'.repeat(32), type: 'A', name: 'api.example.com', content: '192.0.2.22', ttl: 300, proxied: false }) } }] } }] });
await fire(msg('برای api.example.com رکورد A بساز', 42));
const cfCreatePrompt = lastBotMsg();
const cfCreateConfirm = cfCreatePrompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
check('ساخت DNS پیش از تأیید فقط preview دقیق نشان می‌دهد', cfCreatePrompt.body.text.includes('api.example.com') && cfCreatePrompt.body.text.includes('192.0.2.22') && cfCreateConfirm?.startsWith('action:yes:') && !cloudflareCalls.some(c => c.method === 'POST'));
await fire(cb(cfCreateConfirm, 42));
check('ساخت DNS پس از تأیید اجرا می‌شود', cloudflareCalls.some(c => c.method === 'POST' && c.path.endsWith('/dns_records')) && lastBotMsg().body.text.includes('اجرا شد'));

aiResponseQueue.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'cf-delete-1', type: 'function', function: { name: 'cloudflare_delete_dns_record', arguments: JSON.stringify({ zone_id: 'a'.repeat(32), record_id: 'd'.repeat(32) }) } }] } }] });
await fire(msg('این رکورد را حذف کن', 42));
const cfDeletePrompt = lastBotMsg();
const cfDeleteConfirm = cfDeletePrompt.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
check('پیش‌نمایش حذف DNS مقدار فعلی را نشان می‌دهد', cfDeletePrompt.body.text.includes('old.example.com') && cfDeletePrompt.body.text.includes('192.0.2.10') && cfDeleteConfirm?.startsWith('action:yes:'));
cloudflareDnsRecord = { ...cloudflareDnsRecord, content: '192.0.2.77' };
const cfDeleteCountBefore = cloudflareCalls.filter(c => c.method === 'DELETE').length;
await fire(cb(cfDeleteConfirm, 42));
check('تغییر رکورد بعد از preview مانع حذف می‌شود', cloudflareCalls.filter(c => c.method === 'DELETE').length === cfDeleteCountBefore && lastBotMsg().body.text.includes('از زمان preview تغییر کرده'));
await fire(msg('/cloudflare off', 42));
check('قطع اتصال Cloudflare توکن رمز‌شده را پاک می‌کند', !cloudflareIntegrationRows.has('42:cloudflare') && lastBotMsg().body.text.includes('حذف شد'));

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TESTS FAILED`);
process.exit(failures === 0 ? 0 : 1);
