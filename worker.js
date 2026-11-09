// worker.js - دستیار کدنویسی تلگرام + پنل ادمین (نسخه 3)
// امکانات: دیباگ کد با AI، حافظه گفتگو (D1)، جستجوی وب، خواندن اسکرین‌شات خطا،
//          خواندن فایل، تحلیل کامل مخزن (ZIP)، اتصال مدل هوش مصنوعی شخصی هر کاربر (/ai)
// مدل: anthropic/claude-sonnet-4 | Base URL: bedrock-mantle
//
// Bindings لازم: DB (D1) ، STATS (KV) ، FILES (KV)
// Secrets/Vars: TELEGRAM_BOT_TOKEN ، (اختیاری) ADMIN_SECRET ، WEBHOOK_SECRET ، OPENAI_API_KEY ، OPENAI_BASE_URL

// =============== تنظیمات پیش‌فرض هوش مصنوعی ===============
const DEFAULT_AI_BASE_URL = 'https://bedrock-mantle.us-east-2.api.aws/v1';
const DEFAULT_AI_MODEL = 'anthropic/claude-sonnet-4';

// خطاهای داخلی/provider نباید بدون پالایش به Telegram، پنل یا پاسخ HTTP برسند.
function userSafeErrorMessage(error, context = 'general') {
if (typeof error?.userMessage === 'string' && error.userMessage.trim()) return error.userMessage.trim().slice(0, 400);
if (/CREDENTIALS_ENCRYPTION_KEY/.test(String(error?.message || ''))) return 'ذخیرهٔ امن توکن آماده نیست؛ مدیر باید Worker Secret با نام CREDENTIALS_ENCRYPTION_KEY را تنظیم کند.';
const status = Number(error?.status || error?.statusCode || 0);
if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'درخواست بیش از حد طول کشید. کمی بعد دوباره تلاش کن.';
if (status === 401) return context === 'github' ? 'دسترسی GitHub معتبر نیست یا منقضی شده است؛ اتصال را دوباره انجام بده.' : 'اعتبار دسترسی سرویس پذیرفته نشد؛ تنظیمات اتصال را بررسی کن.';
if (status === 403) return context === 'github' ? 'این توکن GitHub اجازهٔ انجام این کار را ندارد؛ مجوزهای مخزن را بررسی کن.' : 'دسترسی لازم برای این کار وجود ندارد؛ مجوزهای اتصال را بررسی کن.';
if (status === 404) return context === 'github' ? 'مخزن یا فایل در GitHub پیدا نشد؛ نام و دسترسی را بررسی کن.' : 'منبع درخواستی پیدا نشد؛ شناسه و مقصد را بررسی کن.';
if (status === 429) return 'سرویس درخواست‌های زیادی دریافت کرده است. کمی صبر کن و دوباره تلاش کن.';
if (status >= 500) return context === 'ai' ? 'سرویس هوش مصنوعی موقتاً در دسترس نیست. کمی بعد دوباره تلاش کن.' : 'سرویس موقتاً در دسترس نیست. کمی بعد دوباره تلاش کن.';
if (context === 'github') return 'عملیات GitHub انجام نشد. اتصال، نام مخزن و مجوزها را بررسی کن.';
if (context === 'ai') return 'سرویس هوش مصنوعی نتوانست درخواست را کامل کند. اتصال و تنظیمات را بررسی کن یا کمی بعد دوباره تلاش کن.';
if (context === 'cloudflare') return 'عملیات Cloudflare انجام نشد. اتصال، دسترسی‌ها و مقصد را بررسی کن.';
if (context === 'file') return 'پردازش فایل انجام نشد. نوع و محتوای فایل را بررسی کن و دوباره تلاش کن.';
return 'انجام این درخواست با مشکل روبه‌رو شد. کمی بعد دوباره تلاش کن.';
}

function publicError(message) {
const error = new Error(message);
error.userMessage = message;
return error;
}

function logSafeError(context, error) {
const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'Error';
const status = Number.isInteger(Number(error?.status)) ? Number(error.status) : undefined;
console.error('Handled application error', { context: String(context).slice(0, 40), name, ...(status ? { status } : {}) });
}

// =============== حافظه گفتگو ===============
const MEMORY_DEFAULT_MESSAGES = 30;      // تعداد پیام‌های نگه‌داشته‌شده (کاربر + ربات)
const MEMORY_MAX_CHARS_PER_MSG = 4000;   // سقف طول هر پیام ذخیره‌شده
const MEMORY_TTL_HOURS = 72;             // پیام‌های قدیمی‌تر از این استفاده نمی‌شوند
const MAX_PROJECTS_PER_CHAT = 20;

// =============== پرامپت‌های سیستمی ===============
// لحن: مثل یک دوست باهوش و برنامه‌نویس باتجربه؛ طبیعی، راحت و دقیق
const STYLE = `
شیوهٔ حرف زدن:
- مثل یک آدم واقعی و رفیق باهوش حرف بزن؛ فارسی محاوره‌ای، گرم و راحت، نه رسمی و نه رباتی. («ببین»، «آره»، «اوکی» و... طبیعیه.)
- منظور کاربر را از کل گفتگو بفهم، حتی اگر نصفه، محاوره‌ای یا با غلط تایپی نوشته باشد. اگر واقعاً مبهم بود، یک سوال کوتاه بپرس؛ ولی سوال بی‌خود نپرس.
- طول جواب متناسب با سوال: سلام و احوالپرسی → یکی دو جمله؛ سوال فنی → هر قدر لازم است، ولی بدون پرگویی و تکرار.
- قالب ثابت و ایموجی‌بازی نکن. فقط وقتی لازم است از تیتر، لیست یا بلوک کد استفاده کن.
- کد، دستورها، نام فایل‌ها و اصطلاحات فنی انگلیسی بمانند. کد را داخل بلوک \`\`\` بنویس.
- حدس نزن و چیزی را از خودت نساز. اگر مطمئن نیستی، صادقانه بگو.
- پیام‌های قبلی گفتگو را یادت باشد و به آن‌ها ارجاع بده؛ کاربر نباید چیزی را دوباره توضیح دهد.
- اگر کاربر به زبان دیگری نوشت، به همان زبان جواب بده.`;

const PROMPTS = {
debug: `تو یک برنامه‌نویس ارشد و رفیق کاربر هستی. کاربر کد یا لاگ خطا فرستاده.
مشکل واقعی را پیدا کن، علتش را ساده و کوتاه بگو، و کد یا دستور اصلاح‌شده را بده (فقط بخش‌های تغییرکرده، مگر کل کد را خواسته باشد).
اگر مشکلی نبود، همین را راحت بگو.
${STYLE}`,

chat: `تو یک دستیار هوشمند و رفیق کاربر هستی که برنامه‌نویسی را خیلی خوب بلدی، ولی دربارهٔ هر موضوعی می‌توانی طبیعی گپ بزنی. ${STYLE}`,

photo: `کاربر یک تصویر فرستاده (معمولاً اسکرین‌شات خطا، ترمینال، لاگ یا کد).
متن مهم تصویر را دقیق بخوان. اگر خطاست: بگو خطا چیست، چرا رخ داده و دقیقاً چه کار کند (دستور یا کد).
اگر تصویر چیز دیگری است، طبیعی درباره‌اش حرف بزن. اگر بخشی ناخواناست، همین را بگو.
${STYLE}`,

file: `کاربر یک فایل کد فرستاده. اول بفهم فایل چه کار می‌کند، بعد باگ‌های واقعی را (با شماره خط) بگو و بخش‌های اصلاح‌شده را بده.
اگر کاربر درخواست خاصی نوشته، دقیقاً همان را انجام بده.
${STYLE}`,

zip: `تو یک برنامه‌نویس ارشد هستی. کد کامل یک پروژه/مخزن به تو داده شده؛ همه فایل‌ها را بخوان و ارتباط بین آن‌ها را در نظر بگیر.
شماره خطوط (مثل «12|») فقط برای ارجاع است؛ در کد اصلاح‌شده ننویسشان.
بگو پروژه چیست، باگ‌های واقعی را به ترتیب اهمیت (با «مسیر/فایل:شماره‌خط») بگو، و برای مهم‌ها کد اصلاح‌شده بده. اگر باگ مهمی نبود، صادقانه بگو.
${STYLE}`
};

// پرامپت حالت «ایجنت» — ربات با ابزارها کار واقعی انجام می‌دهد (گیت‌هاب، فایل‌ها، جستجو)
const AGENT_PROMPT = `تو یک دستیار هوشمند و رفیق کاربر هستی که برنامه‌نویسی را خیلی خوب بلدی و می‌توانی با ابزارهایی که داری کار واقعی انجام بدهی (ساخت مخزن گیت‌هاب، کامیت و پوش، خواندن و ویرایش فایل‌ها، ساخت برنچ و Pull Request، مدیریت DNS در Cloudflare، مشاهدهٔ Zoneها و Workerها، جستجوی وب).

روش کار تو (خیلی مهم):
1. اول دقیق بفهم کاربر چه می‌خواهد. اگر چیز مهمی مبهم است (مثلاً اسم مخزن، عمومی/خصوصی، کدام برنچ) و نمی‌شود از گفتگو فهمید، یک سوال کوتاه بپرس. در غیر این صورت سوال نپرس و کار را انجام بده.
2. قبل از تغییر، وضعیت فعلی را بررسی کن (مثلاً ببین مخزن وجود دارد یا نه، چه فایل‌هایی دارد، برنچ پیش‌فرض چیست).
3. کار را با ابزارها واقعاً انجام بده. هرگز نگو «انجام شد» مگر ابزار واقعاً موفق شده باشد. نتیجه، لینک یا شناسه را از خروجی ابزار بردار، از خودت نساز.
4. بعد از انجام، نتیجه را بررسی کن (مثلاً لیست فایل‌های مخزن را بعد از پوش ببین).
5. اگر خطا خورد، علت را از پیام خطا بفهم و راه دیگری امتحان کن؛ یک کار شکست‌خورده را عیناً تکرار نکن. اگر واقعاً گیر کردی، صادقانه بگو مشکل چیست و کاربر چه کاری باید بکند.
6. در پایان خیلی کوتاه بگو چه کار کردی و نتیجه چه شد (با لینک).

احتیاط:
- کارهایی که کاربر صریحاً خواسته (مثلاً «این پروژه رو تو یه ریپو جدید پوش کن») را مستقیم انجام بده.
- قبل از کارهای پرخطر که کاربر صریحاً نخواسته — مثل بازنویسی فایل‌های موجود روی برنچ اصلی یک مخزن پر، عمومی کردن مخزن، یا حذف فایل — اول دقیق بگو چه اتفاقی می‌افتد و تأیید بگیر.
- مخزن جدید را به‌طور پیش‌فرض خصوصی (private) بساز، مگر کاربر عمومی خواسته باشد.
- فایل‌های حاوی رمز و توکن (مثل .env) را پوش نکن و اگر در کد توکن یا رمز دیدی به کاربر هشدار بده.
- توکن‌ها را هیچ‌وقت در جواب ننویس؛ تو به خود توکن دسترسی نداری و ابزارها خودشان از آن استفاده می‌کنند.
- هر عملیات تغییردهندهٔ DNS فقط پس از preview روشن و تأیید صریح تلگرامی اجرا می‌شود. Cloudflare فقط در گفت‌وگوی خصوصی قابل استفاده است؛ برای عملیات مربوط به Worker فعلاً فقط فهرست/تنظیمات خوانده می‌شود و سورس یا secretهای Worker دریافت نمی‌شود.
- پیام کامیت را کوتاه، معنادار و انگلیسی بنویس (مگر کاربر چیز دیگری بخواهد).

اگر پیام کاربر فقط گپ یا سوال است، ابزار صدا نزن و طبیعی جواب بده.
${STYLE}`;

// =============== تنظیمات پیش‌فرض ===============
const DEFAULT_SETTINGS = {
max_code_length: 8000,
default_language: 'python',
welcome_message: 'سلام! من دستیار کدنویسی‌ات هستم. هر سوالی داری راحت بپرس، کد یا اسکرین‌شات خطا بفرست، یا اگه توکن گیت‌هاب بدی، پروژه‌ات رو برات پوش می‌کنم. /help هم راهنماست.',
search_enabled: true,
memory_messages: MEMORY_DEFAULT_MESSAGES,
ai_api_key: '',
ai_base_url: DEFAULT_AI_BASE_URL,
ai_model: DEFAULT_AI_MODEL,
ai_vision_model: DEFAULT_AI_MODEL
};

// پسوندهای فایل متنی/کد قابل تحلیل
const TEXT_EXTENSIONS = new Set([
'txt','js','mjs','cjs','ts','jsx','tsx','py','java','c','h','cpp','hpp','cc','cs','go',
'rb','rs','php','html','htm','css','scss','less','json','xml','yml','yaml',
'md','markdown','sql','sh','bash','bat','ps1','kt','kts','swift','dart',
'vue','svelte','ini','cfg','conf','toml','env','log','csv','tsv','r','m',
'pl','lua','gradle','properties','dockerfile','makefile','gitignore','jsonc','graphql','proto','tf'
]);

// پسوندهای «کد اصلی» (برای اولویت‌بندی در تحلیل ZIP)
const CODE_EXTENSIONS = new Set([
'js','mjs','cjs','ts','jsx','tsx','py','java','c','h','cpp','hpp','cc','cs','go','rb','rs','php',
'kt','kts','swift','dart','vue','svelte','lua','pl','r','sh','bash','sql','html','css','scss','less'
]);

// پوشه‌ها و فایل‌هایی که در ZIP نادیده گرفته می‌شوند
const ZIP_SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|target|vendor|__pycache__|\.venv|venv|\.next|\.nuxt|\.idea|\.vscode|coverage|\.gradle|Pods)\//i;
const ZIP_SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|\.DS_Store)$|\.min\.(js|css)$|\.map$/i;
// برای پوش به گیت‌هاب: فقط پوشه‌هایی که هیچ‌وقت نباید در مخزن باشند
const WS_SKIP_DIRS = /(^|\/)(node_modules|\.git|__pycache__|\.venv|venv|\.next|\.nuxt|\.wrangler)\/|(^|\/)\.DS_Store$/i;
const ZIP_SECRET_FILES = /(^|\/)\.env(\..*)?$/i;

export default {
async fetch(request, env, ctx) {
try {
// CORS
if (request.method === 'OPTIONS') {
return new Response(null, {
headers: {
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE',
'Access-Control-Allow-Headers': 'Content-Type, Authorization',
},
});
}

const url = new URL(request.url);

if (url.pathname === '/connect/cloudflare' && ['GET', 'POST'].includes(request.method)) {
return await handleCloudflareConnectPage(request, env);
}

// ============ مسیرهای Webhook ============
if (url.pathname === '/webhook' && request.method === 'POST') {
// اگر WEBHOOK_SECRET تنظیم شده، فقط درخواست‌های تلگرام پذیرفته می‌شوند
if (env.WEBHOOK_SECRET &&
request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
return new Response('Forbidden', { status: 403 });
}
const update = await request.json();
// جلوگیری از پردازش دوباره (تلگرام اگر دیر جواب بگیرد، همان آپدیت را دوباره می‌فرستد)
if (await isDuplicateUpdate(update.update_id, env)) {
return new Response('OK', { status: 200 });
}
// پردازش ادامه پیدا می‌کند حتی اگر تلگرام زودتر قطع کند (waitUntil)
const job = handleUpdate(update, env, url.origin);
if (ctx && ctx.waitUntil) ctx.waitUntil(job);
await job;
return new Response('OK', { status: 200 });
}

if (url.pathname === '/setup' && request.method === 'GET') {
return await setupWebhook(url, env);
}

// ============ احراز هویت اختیاری پنل ============
const isAdminPath = url.pathname.startsWith('/admin') || url.pathname.startsWith('/api');
if (isAdminPath && env.ADMIN_SECRET) {
const cookieToken = (request.headers.get('Cookie') || '').match(/admin_token=([^;]+)/)?.[1] || '';
const urlToken = url.searchParams.get('key') || '';
const headerToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
const token = cookieToken || urlToken || headerToken;
if (token !== env.ADMIN_SECRET) {
return new Response('🔒 دسترسی غیرمجاز. با ?key=YOUR_SECRET وارد شوید.', { status: 401 });
}
}

// ============ Admin Panel Routes ============
if (url.pathname === '/admin' || url.pathname === '/admin/') {
const res = await renderAdminPanel(env);
const key = url.searchParams.get('key');
if (key) {
res.headers.append('Set-Cookie', `admin_token=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; Max-Age=86400`);
}
return res;
}

if (url.pathname === '/api/stats' && request.method === 'GET') return await getStats(env);
if (url.pathname === '/api/users' && request.method === 'GET') return await getUsers(env);

if (url.pathname === '/api/user' && request.method === 'GET') {
return await getUserDetail(url.searchParams.get('id'), env);
}
if (url.pathname === '/api/user' && request.method === 'DELETE') {
return await deleteUser(url.searchParams.get('id'), env);
}

if (url.pathname === '/api/broadcast' && request.method === 'POST') {
const { message, type } = await request.json();
return await broadcastMessage(message, type, env);
}

if (url.pathname === '/api/settings' && request.method === 'GET') return await getSettings(env);
if (url.pathname === '/api/settings' && request.method === 'POST') {
const settings = await request.json();
return await saveSettings(settings, env);
}

// تست اتصال به هوش مصنوعی
if (url.pathname === '/api/test-ai' && request.method === 'POST') {
return await testAIConnection(env);
}

if (url.pathname === '/api/files' && request.method === 'GET') return await getFilesList(env);
if (url.pathname === '/api/file' && request.method === 'DELETE') {
return await deleteFile(url.searchParams.get('key'), env);
}
if (url.pathname === '/api/system' && request.method === 'GET') return await getSystemStatus(env);

return new Response('Bot is running! 🤖', { status: 200 });
} catch (error) {
const requestId = crypto.randomUUID();
logSafeError('http_request', error);
return new Response(JSON.stringify({ error: 'درخواست قابل انجام نیست. کمی بعد دوباره تلاش کن.', request_id: requestId }), {
status: 500,
headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
});
}
}
};


// =============== Admin Panel HTML ===============

function escapeHtml(str) {
return String(str ?? '').replace(/[&<>"']/g, c => ({
'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
}

function maskApiKey(key) {
if (!key) return '';
if (key.length <= 10) return '••••••••';
return key.slice(0, 5) + '••••••••' + key.slice(-4);
}

async function renderAdminPanel(env) {
const stats = await getStatsData(env);
const users = await getUsersData(env);
const settings = await getSettingsData(env);

const html = `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🤖 پنل مدیریت دستیار کدنویسی</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', Tahoma, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
.container { max-width: 1400px; margin: 0 auto; }
.header { background: white; border-radius: 15px; padding: 20px; margin-bottom: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center; }
.header h1 { color: #333; font-size: 24px; }
.header .status { padding: 8px 15px; border-radius: 20px; background: #4caf50; color: white; font-weight: bold; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 20px; }
.stat-card { background: white; border-radius: 15px; padding: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); transition: transform 0.3s; }
.stat-card:hover { transform: translateY(-5px); }
.stat-card .icon { font-size: 40px; margin-bottom: 10px; }
.stat-card .value { font-size: 28px; font-weight: bold; color: #667eea; }
.stat-card .label { color: #666; margin-top: 5px; }
.panel { background: white; border-radius: 15px; padding: 20px; margin-bottom: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
.panel h2 { color: #333; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 2px solid #f0f0f0; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 12px; text-align: right; border-bottom: 1px solid #f0f0f0; }
th { background: #f8f9fa; color: #333; font-weight: bold; }
tr:hover { background: #f8f9fa; }
.btn { padding: 8px 15px; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; margin: 0 5px; transition: all 0.3s; }
.btn-danger { background: #f44336; color: white; }
.btn-success { background: #4caf50; color: white; }
.btn-info { background: #2196f3; color: white; }
.btn-warning { background: #ff9800; color: white; }
.btn:hover { opacity: 0.8; transform: scale(1.05); }
.modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; }
.modal-content { background: white; margin: 10% auto; padding: 20px; border-radius: 15px; max-width: 500px; position: relative; }
.close { position: absolute; top: 10px; left: 15px; font-size: 24px; cursor: pointer; }
input, textarea, select { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
.tab { display: inline-block; padding: 10px 20px; cursor: pointer; background: #f8f9fa; border-radius: 5px 5px 0 0; margin-right: 5px; }
.tab.active { background: #667eea; color: white; }
.tab-content { display: none; padding: 20px; background: white; border-radius: 0 0 15px 15px; }
.tab-content.active { display: block; }
.badge { padding: 5px 10px; border-radius: 15px; font-size: 12px; font-weight: bold; }
.badge-success { background: #4caf50; color: white; }
.badge-danger { background: #f44336; color: white; }
.badge-warning { background: #ff9800; color: white; }
.hint { color: #777; font-size: 13px; margin: 5px 0; }
code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; direction: ltr; display: inline-block; }
@media (max-width: 768px) {
.stats-grid { grid-template-columns: 1fr; }
.header { flex-direction: column; text-align: center; }
table { font-size: 12px; }
}
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1>🤖 پنل مدیریت دستیار کدنویسی</h1>
<div class="status">🟢 آنلاین</div>
</div>

<div class="stats-grid">
<div class="stat-card"><div class="icon">👥</div><div class="value" id="totalUsers">${stats.total_users}</div><div class="label">کل کاربران</div></div>
<div class="stat-card"><div class="icon">💬</div><div class="value" id="totalMessages">${stats.total_messages}</div><div class="label">کل پیام‌ها</div></div>
<div class="stat-card"><div class="icon">📝</div><div class="value" id="totalCode">${stats.total_code}</div><div class="label">تحلیل کد</div></div>
<div class="stat-card"><div class="icon">🌐</div><div class="value" id="totalSearch">${stats.total_search}</div><div class="label">جستجوها</div></div>
<div class="stat-card"><div class="icon">📦</div><div class="value" id="totalFiles">${stats.total_files}</div><div class="label">فایل‌ها</div></div>
</div>

<div class="panel">
<div class="tab active" onclick="showTab('users')">👥 کاربران</div>
<div class="tab" onclick="showTab('files')">📦 فایل‌ها</div>
<div class="tab" onclick="showTab('settings')">⚙️ تنظیمات</div>
<div class="tab" onclick="showTab('ai')">🤖 هوش مصنوعی</div>
<div class="tab" onclick="showTab('broadcast')">📢 ارسال پیام</div>
</div>

<!-- Users Tab -->
<div id="users-tab" class="tab-content active">
<div class="panel">
<h2>👥 مدیریت کاربران</h2>
<div style="margin-bottom: 15px;">
<input type="text" id="searchUser" placeholder="🔍 جستجوی کاربر..." onkeyup="filterUsers()">
</div>
<table id="usersTable">
<thead>
<tr>
<th>ID</th><th>نام کاربری</th><th>زبان</th><th>تاریخ عضویت</th><th>عملیات</th>
</tr>
</thead>
<tbody>
${users.map(user => `
<tr>
<td>${user.id}</td>
<td>@${escapeHtml(user.username || 'کاربر')}</td>
<td>${escapeHtml(user.preferred_language || '-')}</td>
<td>${escapeHtml(user.created_at || '')}</td>
<td>
<button class="btn btn-info" onclick="viewUser('${user.id}')">👁️</button>
<button class="btn btn-danger" onclick="deleteUser('${user.id}')">🗑️</button>
</td>
</tr>
`).join('')}
</tbody>
</table>
</div>
</div>

<!-- Files Tab -->
<div id="files-tab" class="tab-content">
<div class="panel">
<h2>📦 مدیریت فایل‌ها</h2>
<table>
<thead><tr><th>نام فایل</th><th>نوع</th><th>سایز</th><th>تاریخ</th><th>عملیات</th></tr></thead>
<tbody id="filesTable"></tbody>
</table>
</div>
</div>

<!-- Settings Tab -->
<div id="settings-tab" class="tab-content">
<div class="panel">
<h2>⚙️ تنظیمات بات</h2>
<form onsubmit="saveSettings(event)">
<label>حداکثر طول کد:</label>
<input type="number" id="maxCodeLength" value="${settings.max_code_length || 5000}">

<label>زبان پیش‌فرض:</label>
<select id="defaultLanguage">
<option value="python" ${settings.default_language === 'python' ? 'selected' : ''}>Python</option>
<option value="javascript" ${settings.default_language === 'javascript' ? 'selected' : ''}>JavaScript</option>
<option value="html" ${settings.default_language === 'html' ? 'selected' : ''}>HTML</option>
<option value="java" ${settings.default_language === 'java' ? 'selected' : ''}>Java</option>
<option value="cpp" ${settings.default_language === 'cpp' ? 'selected' : ''}>C++</option>
</select>

<label>پیام خوش‌آمدگویی:</label>
<textarea id="welcomeMessage" rows="4">${escapeHtml(settings.welcome_message)}</textarea>

<label>فعال بودن جستجو:</label>
<select id="searchEnabled">
<option value="true" ${settings.search_enabled ? 'selected' : ''}>فعال</option>
<option value="false" ${!settings.search_enabled ? 'selected' : ''}>غیرفعال</option>
</select>

<button type="submit" class="btn btn-success">💾 ذخیره تنظیمات</button>
</form>
</div>
</div>

<!-- AI Tab -->
<div id="ai-tab" class="tab-content">
<div class="panel">
<h2>🤖 اتصال به هوش مصنوعی</h2>
<p class="hint">✅ مدل پیش‌فرض: <code>${DEFAULT_AI_MODEL}</code> — این مدل هم متن/کد و هم تصویر (عکس) را پشتیبانی می‌کند</p>
<p class="hint">Base URL پیش‌فرض پروژه: <code>${DEFAULT_AI_BASE_URL}</code></p>
<form onsubmit="saveAISettings(event)">
<label>Base URL:</label>
<input type="text" id="aiBaseUrl" value="${escapeHtml(settings.ai_base_url)}">

<label>API Key:</label>
<input type="text" id="aiApiKey" placeholder="کلید خود را وارد کنید (برای حفظ کلید قبلی خالی بگذارید)" value="${escapeHtml(maskApiKey(settings.ai_api_key))}">

<label>نام مدل (متن و کد):</label>
<input type="text" id="aiModel" value="${escapeHtml(settings.ai_model)}">

<label>نام مدل (بینایی — برای تحلیل عکس):</label>
<input type="text" id="aiVisionModel" value="${escapeHtml(settings.ai_vision_model)}">
<p class="hint">Claude Sonnet 4 قابلیت بینایی دارد؛ همان مدل برای تحلیل عکس هم استفاده می‌شود.</p>

<button type="submit" class="btn btn-success">💾 ذخیره</button>
<button type="button" class="btn btn-info" onclick="testAI()">🔌 تست اتصال</button>
</form>
<div id="aiTestResult" style="margin-top: 10px;"></div>
</div>
</div>

<!-- Broadcast Tab -->
<div id="broadcast-tab" class="tab-content">
<div class="panel">
<h2>📢 ارسال پیام به همه کاربران</h2>
<form onsubmit="sendBroadcast(event)">
<label>پیام:</label>
<textarea id="broadcastMessage" rows="4" placeholder="پیام خود را بنویسید..."></textarea>

<label>نوع ارسال:</label>
<select id="broadcastType">
<option value="all">همه کاربران</option>
<option value="active">کاربران فعال</option>
<option value="inactive">کاربران غیرفعال</option>
</select>

<button type="submit" class="btn btn-warning">📤 ارسال</button>
</form>
<div id="broadcastResult"></div>
</div>
</div>
</div>

<div id="userModal" class="modal">
<div class="modal-content">
<span class="close" onclick="closeModal()">&times;</span>
<h2 id="modalTitle">جزئیات کاربر</h2>
<div id="modalContent"></div>
</div>
</div>

<script>
function showTab(tabName) {
document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
event.target.classList.add('active');
document.getElementById(tabName + '-tab').classList.add('active');
if (tabName === 'files') loadFiles();
}

function filterUsers() {
const search = document.getElementById('searchUser').value.toLowerCase();
document.querySelectorAll('#usersTable tbody tr').forEach(row => {
row.style.display = row.textContent.toLowerCase().includes(search) ? '' : 'none';
});
}

async function viewUser(userId) {
const response = await fetch('/api/user?id=' + userId);
const data = await response.json();
document.getElementById('modalTitle').textContent = 'جزئیات کاربر';
document.getElementById('modalContent').innerHTML =
'<p><b>ID:</b> ' + data.user.id + '</p>' +
'<p><b>نام کاربری:</b> @' + (data.user.username || 'کاربر') + '</p>' +
'<p><b>زبان:</b> ' + (data.user.preferred_language || '-') + '</p>' +
'<p><b>تاریخ عضویت:</b> ' + (data.user.created_at || '-') + '</p>';
document.getElementById('userModal').style.display = 'block';
}

async function deleteUser(userId) {
if (!confirm('آیا از حذف این کاربر مطمئن هستید؟')) return;
const response = await fetch('/api/user?id=' + userId, { method: 'DELETE' });
const result = await response.json();
alert(result.message);
location.reload();
}

async function loadFiles() {
const response = await fetch('/api/files');
const data = await response.json();
const table = document.getElementById('filesTable');
table.innerHTML = data.files.map(file => \`
<tr>
<td>\${file.name}</td>
<td>\${file.type || 'file'}</td>
<td>\${formatSize(file.size)}</td>
<td>\${file.date}</td>
<td><button class="btn btn-danger" onclick="deleteFile('\${file.key}')">🗑️</button></td>
</tr>
\`).join('');
}

async function deleteFile(key) {
if (!confirm('حذف فایل؟')) return;
const response = await fetch('/api/file?key=' + encodeURIComponent(key), { method: 'DELETE' });
const result = await response.json();
alert(result.message);
loadFiles();
}

function formatSize(bytes) {
if (bytes < 1024) return bytes + ' B';
if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function saveSettings(event) {
event.preventDefault();
const settings = {
max_code_length: document.getElementById('maxCodeLength').value,
default_language: document.getElementById('defaultLanguage').value,
welcome_message: document.getElementById('welcomeMessage').value,
search_enabled: document.getElementById('searchEnabled').value === 'true'
};
const response = await fetch('/api/settings', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(settings)
});
const result = await response.json();
alert(result.message);
}

async function saveAISettings(event) {
event.preventDefault();
const settings = {
ai_base_url: document.getElementById('aiBaseUrl').value.trim(),
ai_api_key: document.getElementById('aiApiKey').value.trim(),
ai_model: document.getElementById('aiModel').value.trim(),
ai_vision_model: document.getElementById('aiVisionModel').value.trim()
};
const response = await fetch('/api/settings', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(settings)
});
const result = await response.json();
alert(result.message);
location.reload();
}

async function testAI() {
const el = document.getElementById('aiTestResult');
el.innerHTML = '<div class="badge badge-warning">⏳ در حال تست اتصال...</div>';
try {
const response = await fetch('/api/test-ai', { method: 'POST' });
const result = await response.json();
el.innerHTML = result.ok
? '<div class="badge badge-success">✅ ' + result.message + '</div>'
: '<div class="badge badge-danger">❌ ' + result.message + '</div>';
} catch (e) {
el.textContent = '❌ درخواست ناموفق بود. اتصال شبکه را بررسی کن و دوباره تلاش کن.';
}
}

async function sendBroadcast(event) {
event.preventDefault();
const message = document.getElementById('broadcastMessage').value;
const type = document.getElementById('broadcastType').value;
if (!message) { alert('لطفاً پیام را وارد کنید'); return; }
const response = await fetch('/api/broadcast', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ message, type })
});
const result = await response.json();
document.getElementById('broadcastResult').innerHTML =
'<div class="badge badge-success">' + result.message + '</div>';
}

function closeModal() {
document.getElementById('userModal').style.display = 'none';
}

// به‌روزرسانی خودکار آمار هر ۳۰ ثانیه
setInterval(async () => {
const response = await fetch('/api/stats');
const data = await response.json();
document.getElementById('totalUsers').textContent = data.total_users;
document.getElementById('totalMessages').textContent = data.total_messages;
document.getElementById('totalCode').textContent = data.total_code;
document.getElementById('totalSearch').textContent = data.total_search;
document.getElementById('totalFiles').textContent = data.total_files;
}, 30000);
</script>
</body>
</html>
`;

return new Response(html, {
headers: { 'Content-Type': 'text/html; charset=utf-8' }
});
}


// =============== اتصال هوش مصنوعی شخصی هر کاربر (BYO) ===============
// کاربر می‌تواند Base URL و API Key و نام مدل خودش (پولی یا رایگان) را بدهد
// و همه قابلیت‌های ربات با مدل خودش کار کند.
// کلید API هر کاربر جداگانه در KV ذخیره می‌شود، هرگز به مدل نشان داده نمی‌شود
// و پیام حاوی کلید بلافاصله از چت پاک می‌شود.

function aiConnKey(userId) { return `ai_conn:${userId}`; }
function aiFlowKey(userId) { return `ai_flow:${userId}`; }

async function getUserAIConn(userId, env) {
if (!userId) return null;
try {
const raw = await env.STATS.get(aiConnKey(userId));
if (!raw) return null;
const conn = JSON.parse(raw);
return (conn && conn.base_url && conn.api_key && conn.model) ? conn : null;
} catch (e) { return null; }
}

// آیا اصلاً هوش مصنوعی در دسترس است؟ (اتصال شخصی کاربر → تنظیمات ادمین → متغیر محیطی)
async function hasAnyAI(userId, env, settings) {
if (settings?.ai_api_key || env.OPENAI_API_KEY) return true;
return !!(await getUserAIConn(userId, env));
}

// =============== کیبورد ثابت پایین صفحه (Reply Keyboard) ===============
// دکمه‌های اتصال به‌صورت ثابت در پایین صفحه (جای کیبورد) نمایش داده می‌شوند،
// نه زیر هر پیام. با تغییر وضعیت اتصال، کیبورد هم به‌روز می‌شود.
const BTN = {
connect: '🔌 اتصال مدل',
change: '🔄 تغییر مدل',
status: '📊 وضعیت اتصال',
remove: '🗑 حذف اتصال',
help: '📋 راهنما',
cancel: '❌ لغو'
};

function mainKeyboard(connected) {
return {
inline_keyboard: connected
? [
[{ text: BTN.status, callback_data: 'ai:status' }],
[{ text: BTN.change, callback_data: 'ai:change' }, { text: BTN.remove, callback_data: 'ai:remove' }],
[{ text: BTN.help, callback_data: 'ai:help' }]
]
: [
[{ text: BTN.connect, callback_data: 'ai:connect' }, { text: BTN.status, callback_data: 'ai:status' }],
[{ text: BTN.help, callback_data: 'ai:help' }]
]
};
}

function cancelKeyboard() {
return {
inline_keyboard: [[{ text: BTN.cancel, callback_data: 'ai:cancel' }]]
};
}

// منوی شیشه‌ای زیر پیام؛ دکمه‌های قدیمیِ reply keyboard هم همچنان پذیرفته می‌شوند.
function aiMenuKeyboard(connected) { return mainKeyboard(connected); }

async function sendAiMenu(chatId, userId, env) {
const conn = await getUserAIConn(userId, env);
let text;
if (conn) {
text = '🤖 <b>هوش مصنوعی شخصی</b>\n\n' +
'وضعیت: ✅ متصل\n' +
`مدل: <code>${escapeHtml(conn.model)}</code>\n` +
`Base URL: <code>${escapeHtml(conn.base_url)}</code>\n` +
`API Key: <code>${escapeHtml(maskApiKey(conn.api_key))}</code>\n\n` +
'همه قابلیت‌های ربات (چت، دیباگ، تحلیل عکس، فایل، ZIP و ایجنت گیت‌هاب) با همین مدل کار می‌کنند.';
} else {
text = '🤖 <b>هوش مصنوعی شخصی</b>\n\n' +
'وضعیت: ⚪️ متصل نیست\n\n' +
'اگر به مدل پولی یا رایگان دسترسی داری (هر سرویس سازگار با OpenAI API)، با دکمه «' + BTN.connect + '» وصلش کن.\n\n' +
'لازم داری:\n' +
'1. Base URL (باید به <code>/v1</code> ختم بشه)\n' +
'2. API Key\n' +
'3. نام مدل';
}
await sendMessage(chatId, text, env, mainKeyboard(!!conn), 'HTML');
}

async function startAiConnectFlow(chatId, userId, env) {
await env.STATS.put(aiFlowKey(userId), JSON.stringify({ step: 'base_url', data: {} }), { expirationTtl: 600 });
await sendMessage(chatId,
'🔗 <b>قدم ۱ از ۳ — Base URL</b>\n\n' +
'آدرس سرویس را بفرست؛ باید به <code>/v1</code> ختم بشه.\n\n' +
'نمونه‌ها:\n' +
'<code>https://api.openai.com/v1</code>\n' +
'<code>https://api.groq.com/openai/v1</code>\n' +
'<code>https://openrouter.ai/api/v1</code>', env, cancelKeyboard(), 'HTML');
}

async function removeAiConn(chatId, userId, env) {
await env.STATS.delete(aiConnKey(userId));
await env.STATS.delete(aiFlowKey(userId));
await sendMessage(chatId, '🗑 اتصال هوش مصنوعی شخصی حذف شد.\nاز این به بعد از مدل پیش‌فرض ربات استفاده میشه (اگر ادمین تنظیم کرده باشه).', env, mainKeyboard(false));
}

// دکمه‌های کیبورد ثابت؛ اگر پیام یکی از دکمه‌ها بود true برمی‌گردد
async function handleKeyboardButton(chatId, userId, text, env) {
const t = (text || '').trim();
switch (t) {
case BTN.connect:
case BTN.change:
await startAiConnectFlow(chatId, userId, env);
return true;
case BTN.status:
await env.STATS.delete(aiFlowKey(userId));
await sendAiMenu(chatId, userId, env);
return true;
case BTN.remove:
await removeAiConn(chatId, userId, env);
return true;
case BTN.cancel: {
const had = await env.STATS.get(aiFlowKey(userId));
await env.STATS.delete(aiFlowKey(userId));
const conn = await getUserAIConn(userId, env);
await sendMessage(chatId, had ? '❌ لغو شد.' : 'کاری برای لغو نبود.', env, mainKeyboard(!!conn));
return true;
}
case BTN.help:
await handleCommand(chatId, userId, '/help', env, null);
return true;
}
return false;
}

// تست اتصال با مشخصات شخصی کاربر (مستقیم، بدون ذخیره)
async function testUserAIConn(conn, env) {
const res = await fetch(`${conn.base_url.replace(/\/+$/, '')}/chat/completions`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${conn.api_key}`
},
body: JSON.stringify({
model: conn.model,
messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
max_tokens: 10
})
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
const err = new Error(data.error?.message || data.message || `خطای سرویس (کد ${res.status})`);
err.status = res.status;
throw err;
}
const content = data.choices?.[0]?.message?.content;
if (!content) throw new Error('پاسخی از مدل دریافت نشد');
return String(content).trim().substring(0, 60);
}

// دکمه‌های شیشه‌ای منو و callbackهای قدیمی
const ACTION_APPROVAL_TTL_SECONDS = 300;
const MAX_ACTION_APPROVAL_PAYLOAD_BYTES = 20 * 1024 * 1024;
const READ_ONLY_AGENT_TOOLS = new Set([
'github_whoami', 'github_list_repos', 'github_get_repo', 'github_list_files', 'github_read_file',
'cloudflare_list_zones', 'cloudflare_list_dns_records', 'cloudflare_list_workers', 'cloudflare_get_worker',
'workspace_list_files', 'workspace_read_file', 'web_search'
]);

function agentToolNeedsApproval(name) {
// پیش‌فرض امن: ابزار تازه تا وقتی صریحاً read-only اعلام نشده، نیازمند تأیید است.
return !READ_ONLY_AGENT_TOOLS.has(name);
}

async function requestActionConfirmation(chatId, userId, env, { kind, payload, title, details }) {
await ensureSchema(env);
const serializedPayload = JSON.stringify(payload);
if (new TextEncoder().encode(serializedPayload).length > MAX_ACTION_APPROVAL_PAYLOAD_BYTES) {
throw new Error('حجم عملیات برای یک preview از حد امن بیشتر است؛ آن را به چند تغییر کوچک‌تر تقسیم کن.');
}
const id = crypto.randomUUID().replace(/-/g, '');
const payloadKey = `action_approval_payload:${id}`;
const now = Math.floor(Date.now() / 1000);
const expiresAt = now + ACTION_APPROVAL_TTL_SECONDS;
await env.DB.prepare(`DELETE FROM action_approvals
WHERE (status = 'pending' AND expires_at < ?) OR (status != 'pending' AND resolved_at IS NOT NULL AND resolved_at < ?)`)
.bind(now - 24 * 3600, now - 7 * 24 * 3600).run();
await env.STATS.put(payloadKey, serializedPayload, { expirationTtl: ACTION_APPROVAL_TTL_SECONDS });
try {
await env.DB.prepare(`INSERT INTO action_approvals
(id, chat_id, user_id, kind, payload_key, status, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
.bind(id, String(chatId), String(userId), kind, payloadKey, now, expiresAt).run();
} catch (error) {
await env.STATS.delete(payloadKey);
throw error;
}
await sendMessage(chatId,
`⚠️ <b>تأیید لازم است</b>\n\n<b>${escapeHtml(title)}</b>\n${escapeHtml(details)}\n\nفقط با تأیید همین درخواست اجرا می‌شود. این پیش‌نمایش تا ۵ دقیقه معتبر است.`,
env,
{ inline_keyboard: [[
{ text: '✅ تأیید و اجرا', callback_data: `action:yes:${id}` },
{ text: '❌ لغو', callback_data: `action:no:${id}` }
]] },
'HTML');
return id;
}

async function finishActionApproval(env, id, status) {
await env.DB.prepare(`UPDATE action_approvals SET status = ?, resolved_at = ?
WHERE id = ? AND status = 'executing'`)
.bind(status, Math.floor(Date.now() / 1000), id).run();
}

async function handleActionConfirmationCallback(cb, env) {
const chatId = cb.message?.chat?.id;
const userId = cb.from?.id;
const parts = String(cb.data || '').split(':');
const decision = parts[1];
const id = parts[2] || '';
if (!chatId || !userId || !['yes', 'no'].includes(decision) || !/^[a-f0-9]{32}$/.test(id)) {
if (chatId) await sendMessage(chatId, 'این دکمهٔ تأیید معتبر نیست.', env);
return;
}
await ensureSchema(env);
const row = await env.DB.prepare(`SELECT id, chat_id, user_id, kind, payload_key, status, expires_at
FROM action_approvals WHERE id = ?`).bind(id).first();
if (!row || String(row.user_id) !== String(userId) || String(row.chat_id) !== String(chatId)) {
await sendMessage(chatId, 'این درخواست تأیید برای حساب یا گفت‌وگوی دیگری است.', env);
return;
}
const now = Math.floor(Date.now() / 1000);
const nextStatus = decision === 'yes' ? 'executing' : 'cancelled';
const claimed = await env.DB.prepare(`UPDATE action_approvals SET status = ?, resolved_at = ?
WHERE id = ? AND user_id = ? AND chat_id = ? AND status = 'pending' AND expires_at > ?`)
.bind(nextStatus, now, id, String(userId), String(chatId), now).run();
if (!claimed.meta?.changes) {
if (row.expires_at <= now) {
await env.DB.prepare(`UPDATE action_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`)
.bind('expired', now, id).run();
await env.STATS.delete(row.payload_key);
}
await sendMessage(chatId, row.expires_at <= now ? '⏱ این پیش‌نمایش منقضی شده؛ درخواست را دوباره بفرست.' : 'این درخواست قبلاً استفاده یا لغو شده است.', env);
return;
}
if (decision === 'no') {
await env.STATS.delete(row.payload_key);
await sendMessage(chatId, 'لغو شد؛ هیچ تغییری اعمال نشد.', env);
return;
}

const raw = await env.STATS.get(row.payload_key);
if (!raw) {
await finishActionApproval(env, id, 'expired');
await sendMessage(chatId, '⏱ اطلاعات پیش‌نمایش منقضی شده؛ هیچ تغییری اعمال نشد. درخواست را دوباره بفرست.', env);
return;
}
let payload;
try { payload = JSON.parse(raw); }
catch (error) {
await env.STATS.delete(row.payload_key);
await finishActionApproval(env, id, 'failed');
await sendMessage(chatId, 'پیش‌نمایش قابل‌خواندن نیست؛ هیچ تغییری اعمال نشد.', env);
return;
}

try {
const result = await executeApprovedAction(row.kind, payload, { env, chatId, userId });
await finishActionApproval(env, id, 'completed');
await env.STATS.delete(row.payload_key);
if (result?.reportedToChat) return;
const label = row.kind === 'agent_tool' ? toolLabel(payload.toolName, payload.args || {}) : (payload.label || 'عملیات تأییدشده');
const rendered = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
await sendLongMessage(chatId, `✅ اجرا شد: ${label}${rendered ? `\n\n${rendered}` : ''}`, env);
if (row.kind === 'agent_tool' && payload.requestText) {
const settings = await getSettingsData(env);
await addHistory(chatId, [
{ role: 'user', content: String(payload.requestText).substring(0, MEMORY_MAX_CHARS_PER_MSG) },
{ role: 'assistant', content: `عملیات «${label}» پس از تأیید اجرا شد. نتیجه: ${String(rendered || 'موفق').substring(0, MEMORY_MAX_CHARS_PER_MSG)}` }
], env, settings);
}
} catch (error) {
await finishActionApproval(env, id, 'failed');
await env.STATS.delete(row.payload_key);
logSafeError('approved_action', error);
await sendMessage(chatId, `❌ اجرای عملیات تأییدشده ناموفق بود. ${userSafeErrorMessage(error)}`, env);
}
}

async function executeApprovedAction(kind, payload, ctx) {
const { env, chatId, userId } = ctx;
if (kind === 'cloudflare_connect') {
if (String(chatId) !== String(userId)) throw new Error('اتصال Cloudflare فقط در گفت‌وگوی خصوصی مجاز است.');
const encrypted = payload?.encrypted;
if (!encrypted?.ciphertext || !encrypted?.iv) throw new Error('دادهٔ اتصال امن ناقص است؛ دوباره اتصال را شروع کن.');
const token = await decryptCloudflareToken(encrypted.ciphertext, encrypted.iv, userId, env);
const metadata = await verifyCloudflareToken(token);
await storeCloudflareCredential(userId, encrypted, metadata, env);
return { ok: true, provider: 'Cloudflare', tokenId: metadata.tokenId || null, expiresOn: metadata.expiresOn || null, note: 'توکن با AES-GCM رمزگذاری و ذخیره شد.' };
}
if (kind === 'agent_tool') {
const activeProject = await getActiveProject(chatId, env);
if ((activeProject?.id || null) !== (payload.activeProjectId || null)) {
throw new Error('پروژهٔ فعال از زمان پیش‌نمایش عوض شده؛ برای جلوگیری از تغییر فضای اشتباه، درخواست را دوباره بفرست.');
}
if (payload.workspaceFingerprint) {
const ws = await getWorkspace(chatId, env);
if (await projectFilesFingerprint(ws.files || []) !== payload.workspaceFingerprint) throw new Error('فایل‌های workspace از زمان preview تغییر کرده‌اند؛ هیچ تغییری اعمال نشد و باید دوباره درخواست بدهی.');
}
if (payload.githubTokenFingerprint) {
const token = await getGithubToken(userId, env);
if (!token || await textFingerprint(token) !== payload.githubTokenFingerprint) {
throw new Error('اتصال GitHub از زمان پیش‌نمایش عوض شده؛ درخواست را دوباره بفرست.');
}
}
let cloudflareToken;
if (payload.cloudflareTokenFingerprint) {
cloudflareToken = await getCloudflareToken(userId, env);
if (!cloudflareToken || await textFingerprint(cloudflareToken) !== payload.cloudflareTokenFingerprint) throw new Error('اتصال Cloudflare از زمان preview عوض شده؛ درخواست را دوباره بفرست.');
}
if (payload.cloudflareRecordFingerprint) {
const args = payload.args || {};
const zoneId = validateCloudflareId(args.zone_id, 'zone_id');
const recordId = validateCloudflareId(args.record_id, 'record_id');
const current = await cloudflareApiRequest(cloudflareToken, 'GET', `/zones/${zoneId}/dns_records/${recordId}`);
const fingerprint = await textFingerprint(JSON.stringify(cloudflareSafeRecord(current.result || {})));
if (fingerprint !== payload.cloudflareRecordFingerprint) throw publicError('رکورد DNS از زمان preview تغییر کرده؛ هیچ تغییری اعمال نشد. دوباره preview بگیر.');
}
return await executeTool(payload.toolName, payload.args || {}, { env, chatId, userId, token: undefined, cloudflareToken, login: null });
}
if (kind === 'workspace_clear') {
const activeProject = await getActiveProject(chatId, env);
if ((activeProject?.id || null) !== (payload.projectId || null)) throw new Error('پروژهٔ فعال عوض شده؛ هیچ workspaceای پاک نشد.');
const ws = await getWorkspace(chatId, env);
if (await projectFilesFingerprint(ws.files || []) !== payload.workspaceFingerprint) throw new Error('محتوای workspace از زمان preview تغییر کرده؛ هیچ فایلی پاک نشد و باید دوباره درخواست بدهی.');
await env.STATS.delete(wsKey(chatId, payload.projectId || null));
return { ok: true, workspace: payload.workspaceName || 'فضای کار پیش‌فرض' };
}
if (kind === 'project_delete') {
const result = await deleteProjectById(chatId, payload.projectId, env);
if (!result.ok) throw new Error(result.message);
return result;
}
if (kind === 'project_push') {
const project = await getActiveProject(chatId, env);
const linked = project ? await getProjectRepo(chatId, project.id, env) : null;
if (!project || project.id !== payload.projectId || !linked || linked.repo !== payload.repo || linked.branch !== payload.branch) throw new Error('پروژه یا مقصد GitHub از زمان preview عوض شده؛ دوباره پیش‌نمایش بگیر.');
const ws = await getWorkspace(chatId, env);
const files = projectSyncFiles(ws);
if (!files.length || await projectFilesFingerprint(files) !== payload.fingerprint) throw publicError('فایل‌های workspace از زمان preview تغییر کرده‌اند؛ دوباره پیش‌نمایش بگیر.');
const token = await getGithubToken(userId, env);
if (!token || await textFingerprint(token) !== payload.githubTokenFingerprint) throw new Error('اتصال GitHub از زمان preview تغییر کرده؛ دوباره آن را بررسی کن.');
const result = await githubPushFiles(token, linked.repo, {
branch: linked.branch,
message: `Sync project ${project.name}`,
files: files.map(f => ({ path: cleanRepoPath(f.path), text: f.text, b64: f.b64 }))
});
return { ok: true, message: `ارسال کامل شد: ${result.files_pushed || files.length} فایل به ${linked.repo}@${linked.branch}.`, ...result };
}
if (kind === 'project_pull_overwrite') {
const project = await getActiveProject(chatId, env);
const linked = project ? await getProjectRepo(chatId, project.id, env) : null;
if (!project || project.id !== payload.projectId || !linked || linked.repo !== payload.repo || linked.branch !== payload.branch) {
throw publicError('پروژه یا مخزن از زمان پیش‌نمایش عوض شده؛ درخواست را دوباره بفرست.');
}
const ws = await getWorkspace(chatId, env);
if (await projectFilesFingerprint(ws.files || []) !== payload.workspaceFingerprint) throw publicError('فایل‌های workspace از زمان پیش‌نمایش تغییر کرده‌اند؛ درخواست را دوباره بفرست.');
const ok = await pullProjectRepo(chatId, userId, env, true, payload.treeSha, payload.workspaceFingerprint);
if (!ok) throw new Error('دریافت overwrite کامل نشد؛ جزئیات در پیام منوی GitHub آمده است.');
return { reportedToChat: true };
}
throw new Error('نوع عملیات تأیید ناشناخته است؛ تغییری انجام نشد.');
}

async function textFingerprint(value) {
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function handleCallbackQuery(cb, env) {
try { await answerCallbackQuery(cb.id, env); } catch (e) {}
const chatId = cb.message?.chat?.id;
const userId = cb.from?.id;
const data = cb.data || '';
if (!chatId || !userId) return;
try {
if (data.startsWith('action:')) {
await handleActionConfirmationCallback(cb, env);
return;
}
if (data.startsWith('project:')) {
await handleProjectCallbackQuery(chatId, userId, data, env);
return;
}
if (data === 'ai:connect') await startAiConnectFlow(chatId, userId, env);
else if (data === 'ai:change') await startAiConnectFlow(chatId, userId, env);
else if (data === 'ai:remove') await removeAiConn(chatId, userId, env);
else if (data === 'ai:cancel') {
await env.STATS.delete(aiFlowKey(userId));
const conn = await getUserAIConn(userId, env);
await sendMessage(chatId, '❌ لغو شد.', env, mainKeyboard(!!conn));
}
else if (data === 'ai:help') await handleCommand(chatId, userId, '/help', env, null);
else if (data === 'ai:status') {
await env.STATS.delete(aiFlowKey(userId));
await sendAiMenu(chatId, userId, env);
}
else await sendAiMenu(chatId, userId, env);
} catch (e) {
logSafeError('callback', e);
}
}

async function handleProjectCallbackQuery(chatId, userId, data, env) {
if (data === 'project:menu') { await sendProjectMenu(chatId, env); return; }
if (data === 'project:github') { await sendProjectGithubMenu(chatId, userId, env); return; }
if (data === 'project:link') { await startProjectRepoFlow(chatId, env); return; }
if (data === 'project:unlink') {
const project = await getActiveProject(chatId, env);
if (project) await env.STATS.delete(projectRepoKey(chatId, project.id));
await sendProjectGithubMenu(chatId, userId, env, 'اتصال مخزن از پروژه جدا شد؛ فایل‌های workspace حفظ شدند.');
return;
}
if (data === 'project:pull') { await pullProjectRepo(chatId, userId, env); return; }
if (data === 'project:push') { await startProjectPush(chatId, userId, env); return; }
if (data === 'project:push_confirm') { await confirmProjectPush(chatId, userId, env); return; }
if (data === 'project:push_cancel') {
await env.STATS.delete(projectPushPlanKey(chatId));
await sendProjectGithubMenu(chatId, userId, env, 'ارسال لغو شد.');
return;
}
if (data === 'project:new') {
await startProjectCreateFlow(chatId, env);
return;
}
if (data === 'project:cancel') {
await env.STATS.delete(projectFlowKey(chatId));
await sendProjectMenu(chatId, env, 'ساخت پروژه لغو شد.');
return;
}
if (data === 'project:off') {
await env.STATS.delete(activeProjectKey(chatId));
await sendProjectMenu(chatId, env, '✅ به فضای پیش‌فرض برگشتی؛ داده‌های پروژه‌ها حفظ شده‌اند.');
return;
}
if (data.startsWith('project:use:')) {
const id = data.slice('project:use:'.length);
const project = (await getProjects(chatId, env)).find(p => p.id === id);
if (!project) { await sendProjectMenu(chatId, env, 'این پروژه دیگر در دسترس نیست.'); return; }
await env.STATS.put(activeProjectKey(chatId), project.id);
await env.STATS.delete(projectFlowKey(chatId));
await sendProjectMenu(chatId, env, `✅ پروژهٔ «${project.name}» فعال شد.`);
return;
}
await sendProjectMenu(chatId, env);
}

async function answerCallbackQuery(id, env, text) {
try {
await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}) })
});
} catch (e) {}
}

// ورودی‌های جریان اتصال (wizard). اگر پیام مربوط به جریان بود true برمی‌گردد.
async function handleAiFlowInput(chatId, userId, text, env, messageId) {
const raw = await env.STATS.get(aiFlowKey(userId));
if (!raw) return false;
let flow;
try { flow = JSON.parse(raw); } catch (e) { await env.STATS.delete(aiFlowKey(userId)); return false; }

const t = (text || '').trim();
if (!t) return false;
if (t.toLowerCase() === '/cancel' || t === 'لغو') {
await env.STATS.delete(aiFlowKey(userId));
const conn = await getUserAIConn(userId, env);
await sendMessage(chatId, '❌ لغو شد.', env, mainKeyboard(!!conn));
return true;
}

if (flow.step === 'base_url') {
const url = t.replace(/\/+$/, '');
if (!/^https?:\/\/[^\s]+\/v1$/i.test(url)) {
await sendMessage(chatId, '⚠️ Base URL باید با <code>/v1</code> تمام بشه.\nمثال: <code>https://api.openai.com/v1</code>\n\nدوباره بفرست.', env, cancelKeyboard(), 'HTML');
return true;
}
flow = { step: 'api_key', data: { base_url: url } };
await env.STATS.put(aiFlowKey(userId), JSON.stringify(flow), { expirationTtl: 600 });
await sendMessage(chatId, '✅ Base URL ثبت شد.\n\n🔑 <b>قدم ۲ از ۳ — API Key</b>\n\nکلید را بفرست. پیامش بلافاصله از چت پاک میشه و فقط برای خودت ذخیره میشه.', env, cancelKeyboard(), 'HTML');
return true;
}

if (flow.step === 'api_key') {
if (t.length < 8 || /\s/.test(t)) {
await sendMessage(chatId, '⚠️ این کلید معتبر به نظر نمیاد (بدون فاصله و حداقل ۸ کاراکتر). دوباره بفرست.', env, cancelKeyboard());
return true;
}
const deleted = await deleteTelegramMessage(chatId, messageId, env);
flow = { step: 'model', data: { ...flow.data, api_key: t } };
await env.STATS.put(aiFlowKey(userId), JSON.stringify(flow), { expirationTtl: 600 });
let msg = '✅ API Key ثبت شد' + (deleted ? ' و پیامش از چت پاک شد.' : '. (نتونستم پیامش رو پاک کنم؛ خودت پاکش کن)');
msg += '\n\n🧠 <b>قدم ۳ از ۳ — نام مدل</b>\n\nمثال: <code>gpt-4o-mini</code> یا <code>llama-3.3-70b-versatile</code>';
await sendMessage(chatId, msg, env, cancelKeyboard(), 'HTML');
return true;
}

if (flow.step === 'model') {
if (t.includes('\n') || t.length > 100) {
await sendMessage(chatId, '⚠️ فقط نام مدل را بفرست. مثال: <code>gpt-4o-mini</code>', env, cancelKeyboard(), 'HTML');
return true;
}
const conn = { ...flow.data, model: t };
await sendChatAction(chatId, 'typing', env);
try {
await testUserAIConn(conn, env);
await env.STATS.put(aiConnKey(userId), JSON.stringify(conn));
await env.STATS.delete(aiFlowKey(userId));
await sendMessage(chatId,
`🎉 <b>متصل شدی</b>\n\nمدل <code>${escapeHtml(conn.model)}</code> فعال شد و همه قابلیت‌های ربات با همین مدل کار می‌کنند.\n\n` +
'💡 برای تحلیل عکس، مدل باید قابلیت بینایی (vision) داشته باشه.', env, mainKeyboard(true), 'HTML');
} catch (e) {
// جریان در همین قدم می‌ماند تا کاربر نام مدل دیگری بفرستد
await sendMessage(chatId,
`❌ تست اتصال ناموفق بود:\n${userSafeErrorMessage(e, 'ai')}\n\n` +
'نام مدل دیگری بفرست، یا اگر Base URL یا کلید مشکل داره «' + BTN.cancel + '» را بزن و از اول شروع کن.', env, cancelKeyboard());
}
return true;
}

return false;
}

// =============== موتور هوش مصنوعی (سازگار با OpenAI API) ===============

async function callAI(messages, env, options = {}) {
const settings = await getSettingsData(env);
// اولویت مدل: اتصال شخصی کاربر → پنل ادمین → متغیر محیطی → پیش‌فرض پروژه
const userConn = options.userId ? await getUserAIConn(options.userId, env) : null;
const apiKey = userConn?.api_key || settings.ai_api_key || env.OPENAI_API_KEY || '';
const baseUrl = (userConn?.base_url || settings.ai_base_url || env.OPENAI_BASE_URL || DEFAULT_AI_BASE_URL).replace(/\/+$/, '');
const model = userConn?.model || options.model || settings.ai_model || DEFAULT_AI_MODEL;

if (!apiKey) {
throw new Error('کلید API هوش مصنوعی تنظیم نشده. ادمین از پنل (تب هوش مصنوعی) وارد کند، یا خودت با دستور /ai مدل شخصی‌ات را وصل کن.');
}

const res = await fetch(`${baseUrl}/chat/completions`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${apiKey}`
},
body: JSON.stringify({
model: model,
messages: messages,
temperature: options.temperature ?? 0.5,
max_tokens: options.max_tokens || 3000,
...(options.tools ? { tools: options.tools, tool_choice: 'auto' } : {})
})
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
const err = new Error(data.error?.message || data.message || `خطای سرویس هوش مصنوعی (کد ${res.status})`);
err.status = res.status;
throw err;
}

const message = data.choices?.[0]?.message;
// حالت raw: کل پیام (شامل tool_calls) برگردانده می‌شود
if (options.raw) {
if (!message) throw new Error('پاسخی از هوش مصنوعی دریافت نشد');
return message;
}
const content = message?.content;
if (!content) throw new Error('پاسخی از هوش مصنوعی دریافت نشد');
return content;
}

async function testAIConnection(env) {
try {
const reply = await callAI(
[{ role: 'user', content: 'Reply with exactly: OK' }],
env,
{ max_tokens: 10 }
);
return jsonResponse({ ok: true, message: 'اتصال موفق! پاسخ مدل: ' + String(reply).trim().substring(0, 60) });
} catch (e) {
logSafeError('ai_connection_test', e);
return jsonResponse({ ok: false, message: userSafeErrorMessage(e, 'ai') });
}
}



// =============== حافظه گفتگو و ضد‌تکرار (D1) ===============

let schemaReady = false;
async function ensureSchema(env) {
if (schemaReady) return;
await env.DB.prepare(`CREATE TABLE IF NOT EXISTS chat_history (
id INTEGER PRIMARY KEY AUTOINCREMENT,
chat_id INTEGER NOT NULL,
role TEXT NOT NULL,
content TEXT NOT NULL,
created_at INTEGER NOT NULL
)`).run();
await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_hist_chat ON chat_history (chat_id, id)').run();
await env.DB.prepare(`CREATE TABLE IF NOT EXISTS processed_updates (
update_id INTEGER PRIMARY KEY,
created_at INTEGER NOT NULL
)`).run();
await env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_chat_history (
id INTEGER PRIMARY KEY AUTOINCREMENT,
chat_id INTEGER NOT NULL,
project_id TEXT NOT NULL,
role TEXT NOT NULL,
content TEXT NOT NULL,
created_at INTEGER NOT NULL
)`).run();
await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_project_hist_scope ON project_chat_history (chat_id, project_id, id)').run();
await env.DB.prepare(`CREATE TABLE IF NOT EXISTS action_approvals (
id TEXT PRIMARY KEY,
chat_id TEXT NOT NULL,
user_id TEXT NOT NULL,
kind TEXT NOT NULL,
payload_key TEXT NOT NULL,
status TEXT NOT NULL,
created_at INTEGER NOT NULL,
expires_at INTEGER NOT NULL,
resolved_at INTEGER
)`).run();
await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_action_approvals_owner ON action_approvals (user_id, chat_id, status, expires_at)').run();
await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_integrations (
user_id TEXT NOT NULL,
provider TEXT NOT NULL,
ciphertext TEXT NOT NULL,
iv TEXT NOT NULL,
key_version INTEGER NOT NULL DEFAULT 1,
metadata_json TEXT NOT NULL DEFAULT '{}',
created_at INTEGER NOT NULL,
updated_at INTEGER NOT NULL,
PRIMARY KEY (user_id, provider)
)`).run();
await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cloudflare_connect_sessions (
state_hash TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
chat_id TEXT NOT NULL,
status TEXT NOT NULL,
expires_at INTEGER NOT NULL,
created_at INTEGER NOT NULL
)`).run();
await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_cf_connect_expiry ON cloudflare_connect_sessions (status, expires_at)').run();
schemaReady = true;
}

// آیا این آپدیت قبلاً پردازش شده؟ (تلگرام در صورت تأخیر دوباره می‌فرستد)
async function isDuplicateUpdate(updateId, env) {
if (updateId === undefined || updateId === null) return false;
try {
await ensureSchema(env);
const now = Math.floor(Date.now() / 1000);
const r = await env.DB.prepare('INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?, ?)')
.bind(updateId, now).run();
// پاکسازی گاه‌به‌گاه ردیف‌های قدیمی
if (Math.random() < 0.02) {
await env.DB.prepare('DELETE FROM processed_updates WHERE created_at < ?').bind(now - 3600).run();
}
return (r.meta?.changes ?? 1) === 0;
} catch (e) {
logSafeError('update_dedupe', e);
return false;
}
}

function memoryLimit(settings) {
const n = parseInt(settings?.memory_messages);
return Math.min(Math.max(n || MEMORY_DEFAULT_MESSAGES, 2), 40);
}

// خواندن آخرین پیام‌ها (به ترتیب زمانی، با نقش‌های متناوب user/assistant)
async function getHistory(chatId, env, settings) {
try {
await ensureSchema(env);
const since = Math.floor(Date.now() / 1000) - MEMORY_TTL_HOURS * 3600;
const project = await getActiveProject(chatId, env);
const query = project
? env.DB.prepare('SELECT role, content FROM project_chat_history WHERE chat_id = ? AND project_id = ? AND created_at > ? ORDER BY id DESC LIMIT ?').bind(chatId, project.id, since, memoryLimit(settings))
: env.DB.prepare('SELECT role, content FROM chat_history WHERE chat_id = ? AND created_at > ? ORDER BY id DESC LIMIT ?').bind(chatId, since, memoryLimit(settings));
const { results } = await query.all();

const rows = (results || []).reverse();
const out = [];
for (const r of rows) {
if (out.length === 0 && r.role !== 'user') continue; // باید با user شروع شود
const last = out[out.length - 1];
if (last && last.role === r.role) last.content += '\n\n' + r.content; // ادغام نقش‌های تکراری
else out.push({ role: r.role, content: r.content });
}
return out;
} catch (e) {
logSafeError('history_read', e);
return [];
}
}

// ذخیره پیام‌ها و نگه‌داشتن فقط N پیام آخر
async function addHistory(chatId, messages, env, settings) {
try {
await ensureSchema(env);
const now = Math.floor(Date.now() / 1000);
const project = await getActiveProject(chatId, env);
const stmts = messages.map(m => project
? env.DB.prepare('INSERT INTO project_chat_history (chat_id, project_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').bind(chatId, project.id, m.role, String(m.content).substring(0, MEMORY_MAX_CHARS_PER_MSG), now)
: env.DB.prepare('INSERT INTO chat_history (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').bind(chatId, m.role, String(m.content).substring(0, MEMORY_MAX_CHARS_PER_MSG), now));
await env.DB.batch(stmts);

const keep = memoryLimit(settings);
if (project) {
await env.DB.prepare(
`DELETE FROM project_chat_history WHERE chat_id = ? AND project_id = ? AND id NOT IN (
SELECT id FROM project_chat_history WHERE chat_id = ? AND project_id = ? ORDER BY id DESC LIMIT ?)`
).bind(chatId, project.id, chatId, project.id, keep).run();
} else await env.DB.prepare(
`DELETE FROM chat_history WHERE chat_id = ? AND id NOT IN (
SELECT id FROM chat_history WHERE chat_id = ? ORDER BY id DESC LIMIT ?)`
).bind(chatId, chatId, keep).run();
} catch (e) {
logSafeError('history_write', e);
}
}

async function clearHistory(chatId, env) {
await ensureSchema(env);
const project = await getActiveProject(chatId, env);
if (project) await env.DB.prepare('DELETE FROM project_chat_history WHERE chat_id = ? AND project_id = ?').bind(chatId, project.id).run();
else await env.DB.prepare('DELETE FROM chat_history WHERE chat_id = ?').bind(chatId).run();
}

function projectsKey(chatId) { return `projects:${chatId}`; }
function activeProjectKey(chatId) { return `active_project:${chatId}`; }
function normalizeProjectName(name) { return String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase(); }

async function getProjects(chatId, env) {
try {
const projects = JSON.parse(await env.STATS.get(projectsKey(chatId)) || '[]');
return Array.isArray(projects) ? projects : [];
} catch (e) { return []; }
}

async function getActiveProject(chatId, env) {
const id = await env.STATS.get(activeProjectKey(chatId));
if (!id) return null;
const project = (await getProjects(chatId, env)).find(p => p.id === id);
if (!project) { await env.STATS.delete(activeProjectKey(chatId)); return null; }
return project;
}

function projectFlowKey(chatId) { return `project_flow:${chatId}`; }

function projectMenuKeyboard(projects, active) {
const rows = [];
for (let i = 0; i < projects.length; i += 2) {
rows.push(projects.slice(i, i + 2).map(project => ({
text: `${project.id === active?.id ? '✅ ' : '📁 '}${project.name}`,
callback_data: `project:use:${project.id}`
})));
}
rows.push([{ text: '➕ پروژهٔ جدید', callback_data: 'project:new' }]);
if (active) rows.push([{ text: '🏠 فضای پیش‌فرض', callback_data: 'project:off' }]);
if (active) rows.push([{ text: '🐙 مخزن و همگام‌سازی GitHub', callback_data: 'project:github' }]);
return { inline_keyboard: rows };
}

async function sendProjectMenu(chatId, env, notice = '') {
const projects = await getProjects(chatId, env);
const active = await getActiveProject(chatId, env);
const status = active ? `پروژهٔ فعال: ✅ «${escapeHtml(active.name)}»` : 'پروژهٔ فعال: 🏠 فضای پیش‌فرض';
const intro = notice ? `${escapeHtml(notice)}\n\n` : '';
const guidance = projects.length
? 'برای جابه‌جایی، روی نام پروژه بزن؛ پروژه‌ها حافظه و workspace جدا دارند.'
: 'هنوز پروژه‌ای نساخته‌ای. برای شروع روی «پروژهٔ جدید» بزن.';
await sendMessage(chatId, `${intro}📂 <b>مدیریت پروژه‌ها</b>\n${status}\n\n${guidance}`, env, projectMenuKeyboard(projects, active), 'HTML');
}

function projectRepoKey(chatId, projectId) { return `project_repo:${chatId}:${projectId}`; }
function projectPushPlanKey(chatId) { return `project_push_plan:${chatId}`; }

async function getProjectRepo(chatId, projectId, env) {
try { return JSON.parse(await env.STATS.get(projectRepoKey(chatId, projectId)) || 'null'); }
catch (e) { return null; }
}

async function startProjectRepoFlow(chatId, env) {
if (!(await getActiveProject(chatId, env))) { await sendProjectMenu(chatId, env, 'برای اتصال مخزن ابتدا یک پروژه را فعال کن.'); return; }
await env.STATS.put(projectFlowKey(chatId), 'repo', { expirationTtl: 600 });
await sendMessage(chatId, '🐙 آدرس مخزن GitHub را بفرست (owner/repo یا لینک مخزن). برای تعیین برنچ، بعد از آدرس یک فاصله و نام برنچ را بنویس.', env, {
inline_keyboard: [[{ text: '❌ لغو', callback_data: 'project:cancel' }]]
});
}

async function linkProjectRepo(chatId, userId, input, env) {
const project = await getActiveProject(chatId, env);
if (!project) return { ok: false, message: 'اول یک پروژه بساز یا از منوی /project انتخابش کن.' };
const token = await getGithubToken(userId, env);
if (!token) return { ok: false, message: 'اول گیت‌هاب را وصل کن: /github <توکن>' };
const [rawRepo, ...branchParts] = String(input || '').trim().split(/\s+/);
const repo = String(rawRepo || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { ok: false, message: 'آدرس مخزن معتبر نیست؛ نمونه: owner/repo' };
const branchInput = branchParts.join(' ').trim();
if (branchInput && (!/^[A-Za-z0-9._/-]+$/.test(branchInput) || branchInput.startsWith('/') || branchInput.endsWith('/') || branchInput.includes('..'))) {
return { ok: false, message: 'نام برنچ معتبر نیست.' };
}
try {
const { data } = await ghRequest(token, 'GET', `/repos/${repo}`);
const fullRepo = data.full_name || repo;
const branch = branchInput || data.default_branch || 'main';
await env.STATS.put(projectRepoKey(chatId, project.id), JSON.stringify({ repo: fullRepo, branch, linked_at: new Date().toISOString() }));
return { ok: true, repo: fullRepo, branch, message: `✅ پروژهٔ «${project.name}» به ${fullRepo} وصل شد (برنچ ${branch}).` };
} catch (e) { logSafeError('github_link_repo', e); return { ok: false, message: `اتصال مخزن انجام نشد. ${userSafeErrorMessage(e, 'github')}` }; }
}

async function sendProjectGithubMenu(chatId, userId, env, notice = '') {
const project = await getActiveProject(chatId, env);
if (!project) { await sendProjectMenu(chatId, env, 'برای اتصال مخزن ابتدا یک پروژه را فعال کن.'); return; }
const linked = await getProjectRepo(chatId, project.id, env);
const token = await getGithubToken(userId, env);
let text = `${notice ? `${notice}\n\n` : ''}🐙 <b>مخزن GitHub پروژه</b>\nپروژه: «${project.name}»\n`;
text += linked ? `مخزن: <code>${escapeHtml(linked.repo)}</code>\nبرنچ: <code>${escapeHtml(linked.branch)}</code>` : 'هنوز مخزنی وصل نشده است.';
text += token ? '' : '\n\n⚠️ ابتدا با /github توکن متصل کن.';
const buttons = linked
? [
[{ text: '⬇️ دریافت فایل‌های جدید', callback_data: 'project:pull' }],
[{ text: '⬆️ ارسال به GitHub', callback_data: 'project:push' }],
[{ text: '🔄 اتصال/تغییر مخزن', callback_data: 'project:link' }],
[{ text: '🔌 قطع اتصال مخزن', callback_data: 'project:unlink' }],
[{ text: '↩️ بازگشت به پروژه‌ها', callback_data: 'project:menu' }]
]
: [
[{ text: '🔗 اتصال مخزن', callback_data: 'project:link' }],
[{ text: '↩️ بازگشت به پروژه‌ها', callback_data: 'project:menu' }]
];
await sendMessage(chatId, text, env, { inline_keyboard: buttons }, 'HTML');
}

function isSafeProjectFilePath(path) {
const raw = String(path || '');
const clean = cleanRepoPath(raw);
return !!clean && !raw.startsWith('/') && !clean.split('/').some(part => !part || part === '.' || part === '..') &&
!raw.startsWith('\\') &&
!ZIP_SECRET_FILES.test(clean) && !ZIP_SKIP_DIRS.test(`${clean}/`);
}

function projectSyncFiles(workspace) {
return (workspace?.files || []).filter(file => isSafeProjectFilePath(file.path) && !ZIP_SECRET_FILES.test(file.path));
}

async function pullProjectRepo(chatId, userId, env, overwrite = false, expectedTreeSha = null, expectedWorkspaceFingerprint = null) {
const project = await getActiveProject(chatId, env);
if (!project) { await sendProjectGithubMenu(chatId, userId, env, 'پروژه‌ای فعال نیست.'); return false; }
const linked = await getProjectRepo(chatId, project.id, env);
const token = await getGithubToken(userId, env);
if (!linked) { await sendProjectGithubMenu(chatId, userId, env, 'ابتدا مخزن را به پروژه وصل کن.'); return false; }
if (!token) { await sendProjectGithubMenu(chatId, userId, env, 'ابتدا با /github توکن وصل کن.'); return false; }
try {
const treeResult = await ghRequest(token, 'GET', `/repos/${linked.repo}/git/trees/${encodePath(linked.branch)}?recursive=1`);
if (treeResult.data.truncated) throw new Error('درخت مخزن از حد GitHub بزرگ‌تر است؛ برای جلوگیری از دریافت ناقص، سینک متوقف شد.');
if (expectedTreeSha && treeResult.data.sha !== expectedTreeSha) throw new Error('شاخهٔ GitHub از زمان پیش‌نمایش تغییر کرده؛ دوباره preview بگیر.');
const candidates = [];
let plannedBytes = 0, skipped = 0;
for (const entry of treeResult.data.tree || []) {
if (entry.type !== 'blob' || !isSafeProjectFilePath(entry.path)) { skipped++; continue; }
if ((entry.size || 0) > 2 * 1024 * 1024 || candidates.length >= 200 || plannedBytes + (entry.size || 0) > 10 * 1024 * 1024) { skipped++; continue; }
candidates.push(entry);
plannedBytes += entry.size || 0;
}
const existing = await getWorkspace(chatId, env);
if (expectedWorkspaceFingerprint && await projectFilesFingerprint(existing.files || []) !== expectedWorkspaceFingerprint) throw new Error('فایل‌های workspace از زمان پیش‌نمایش تغییر کرده‌اند؛ دوباره preview بگیر.');
const existingPaths = new Set((existing.files || []).map(f => cleanRepoPath(f.path)));
const toDownload = candidates.filter(entry => overwrite || !existingPaths.has(entry.path));
const conflicts = candidates.length - toDownload.length;
const imported = [];
let downloadedBytes = 0;
for (let i = 0; i < toDownload.length; i += 4) {
const batch = toDownload.slice(i, i + 4);
const files = await Promise.all(batch.map(async entry => {
const { data } = await ghRequest(token, 'GET', `/repos/${linked.repo}/git/blobs/${encodeURIComponent(entry.sha)}`);
if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(`محتوای ${entry.path} از GitHub قابل دریافت نبود.`);
const bytes = base64ToBytes(data.content);
return bytesToWsFile(entry.path, bytes);
}));
for (const file of files) {
if ((file.size || 0) > 2 * 1024 * 1024 || downloadedBytes + (file.size || 0) > 10 * 1024 * 1024) { skipped++; continue; }
imported.push(file);
downloadedBytes += file.size || 0;
}
}
if (imported.length) await addFilesToWorkspace(chatId, imported, env, null);
const report = `⬇️ دریافت از ${linked.repo}@${linked.branch} تمام شد: ${imported.length} فایل اضافه/به‌روزرسانی شد.` +
(conflicts ? ` ${conflicts} فایل هم‌نام حفظ شد${overwrite ? '' : ' (برای جایگزینی صریح، /project pull overwrite را اجرا کن)'}.` : '') +
(skipped ? ` ${skipped} فایل به‌خاطر نوع/حجم/محدودیت کنار گذاشته شد.` : '');
await sendProjectGithubMenu(chatId, userId, env, report);
return true;
} catch (e) {
logSafeError('github_pull', e);
await sendProjectGithubMenu(chatId, userId, env, `❌ دریافت مخزن ناموفق بود. ${userSafeErrorMessage(e, 'github')}`);
return false;
}
}

async function projectFilesFingerprint(files) {
const source = JSON.stringify(files.map(f => [f.path, f.size, f.text ?? null, f.b64 ?? null]));
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function startProjectOverwritePull(chatId, userId, env) {
const project = await getActiveProject(chatId, env);
const linked = project ? await getProjectRepo(chatId, project.id, env) : null;
const token = await getGithubToken(userId, env);
if (!project || !linked || !token) {
await sendProjectGithubMenu(chatId, userId, env, !project ? 'پروژه‌ای فعال نیست.' : !linked ? 'ابتدا مخزن را به پروژه وصل کن.' : 'ابتدا با /github توکن وصل کن.');
return;
}
try {
const treeResult = await ghRequest(token, 'GET', `/repos/${linked.repo}/git/trees/${encodePath(linked.branch)}?recursive=1`);
if (treeResult.data.truncated) throw new Error('درخت مخزن از حد GitHub بزرگ‌تر است؛ preview کامل ممکن نیست.');
const candidates = [];
let plannedBytes = 0;
for (const entry of treeResult.data.tree || []) {
if (entry.type !== 'blob' || !isSafeProjectFilePath(entry.path)) continue;
if ((entry.size || 0) > 2 * 1024 * 1024 || candidates.length >= 200 || plannedBytes + (entry.size || 0) > 10 * 1024 * 1024) continue;
candidates.push(entry);
plannedBytes += entry.size || 0;
}
const ws = await getWorkspace(chatId, env);
const localPaths = new Set((ws.files || []).map(f => cleanRepoPath(f.path)));
const conflicts = candidates.filter(f => localPaths.has(f.path)).map(f => f.path);
const workspaceFingerprint = await projectFilesFingerprint(ws.files || []);
if (!conflicts.length) {
await pullProjectRepo(chatId, userId, env, true, treeResult.data.sha, workspaceFingerprint);
return;
}
const listed = conflicts.slice(0, 15).map(p => `• ${p}`).join('\n');
await requestActionConfirmation(chatId, userId, env, {
kind: 'project_pull_overwrite',
payload: { projectId: project.id, repo: linked.repo, branch: linked.branch, treeSha: treeResult.data.sha, workspaceFingerprint },
title: 'جایگزینی فایل‌های محلی با نسخهٔ مخزن',
details: `پروژه: ${project.name}\nمخزن: ${linked.repo}@${linked.branch}\nفایل‌های هم‌نامی که جایگزین می‌شوند: ${conflicts.length}\n${listed}${conflicts.length > 15 ? `\n… و ${conflicts.length - 15} فایل دیگر` : ''}\n\nاگر فایل‌های workspace یا شاخهٔ GitHub قبل از تأیید تغییر کنند، عملیات متوقف می‌شود.`
});
} catch (error) {
logSafeError('github_overwrite_preview', error);
await sendProjectGithubMenu(chatId, userId, env, `❌ ساخت پیش‌نمایش overwrite ناموفق بود. ${userSafeErrorMessage(error, 'github')}`);
}
}

async function startProjectPush(chatId, userId, env) {
const project = await getActiveProject(chatId, env);
if (!project) { await sendProjectGithubMenu(chatId, userId, env, 'پروژه‌ای فعال نیست.'); return; }
const linked = await getProjectRepo(chatId, project.id, env);
const token = await getGithubToken(userId, env);
if (!linked) { await sendProjectGithubMenu(chatId, userId, env, 'ابتدا مخزن را به پروژه وصل کن.'); return; }
if (!token) { await sendProjectGithubMenu(chatId, userId, env, 'ابتدا با /github توکن وصل کن.'); return; }
const ws = await getWorkspace(chatId, env);
const files = projectSyncFiles(ws);
if (!files.length) { await sendProjectGithubMenu(chatId, userId, env, 'فایل امنی در workspace پروژه برای ارسال نیست.'); return; }
if (files.length > 300) { await sendProjectGithubMenu(chatId, userId, env, 'تعداد فایل‌ها بیش از حد مجاز برای یک sync است (حداکثر ۳۰۰).'); return; }
const fingerprint = await projectFilesFingerprint(files);
const list = files.slice(0, 12).map(f => `• ${f.path}`).join('\n');
await requestActionConfirmation(chatId, userId, env, {
kind: 'project_push',
payload: { projectId: project.id, repo: linked.repo, branch: linked.branch, fingerprint, githubTokenFingerprint: await textFingerprint(token), label: 'ارسال workspace به GitHub' },
title: 'تأیید ارسال به GitHub',
details: `پروژه: ${project.name}\nمخزن: ${linked.repo}@${linked.branch}\nفایل‌ها: ${files.length}\n${list}${files.length > 12 ? `\n… و ${files.length - 12} فایل دیگر` : ''}\n\nفقط فایل‌های workspace اضافه/به‌روزرسانی می‌شوند؛ فایل‌های دیگر مخزن حذف نمی‌شوند. مقصد، فایل‌ها و اتصال GitHub هنگام تأیید دوباره بررسی می‌شوند.`
});
}

async function confirmProjectPush(chatId, userId, env) {
const raw = await env.STATS.get(projectPushPlanKey(chatId));
if (!raw) { await sendProjectGithubMenu(chatId, userId, env, 'پیش‌نمایش منقضی شده؛ دوباره ارسال را شروع کن.'); return; }
let plan;
try { plan = JSON.parse(raw); } catch (e) { await env.STATS.delete(projectPushPlanKey(chatId)); await sendProjectGithubMenu(chatId, userId, env, 'پیش‌نمایش معتبر نیست؛ دوباره تلاش کن.'); return; }
if (!plan.userId || String(plan.userId) !== String(userId)) {
if (!plan.userId) await env.STATS.delete(projectPushPlanKey(chatId));
await sendMessage(chatId, 'این پیش‌نمایش قدیمی یا متعلق به کاربر دیگری است؛ push را دوباره از منوی پروژه شروع کن.', env);
return;
}
const project = await getActiveProject(chatId, env);
const linked = project ? await getProjectRepo(chatId, project.id, env) : null;
if (!project || project.id !== plan.projectId || !linked || linked.repo !== plan.repo || linked.branch !== plan.branch) {
await env.STATS.delete(projectPushPlanKey(chatId));
await sendProjectGithubMenu(chatId, userId, env, 'پروژه یا مقصد عوض شده؛ پیش‌نمایش قبلی لغو شد.');
return;
}
const ws = await getWorkspace(chatId, env);
const files = projectSyncFiles(ws);
if (!files.length || await projectFilesFingerprint(files) !== plan.fingerprint) {
await env.STATS.delete(projectPushPlanKey(chatId));
await sendProjectGithubMenu(chatId, userId, env, 'فایل‌های workspace بعد از پیش‌نمایش تغییر کرده‌اند؛ برای امنیت، دوباره پیش‌نمایش بگیر.');
return;
}
const token = await getGithubToken(userId, env);
if (!token) { await env.STATS.delete(projectPushPlanKey(chatId)); await sendProjectGithubMenu(chatId, userId, env, 'توکن GitHub در دسترس نیست؛ دوباره /github را وصل کن.'); return; }
await env.STATS.delete(projectPushPlanKey(chatId));
try {
const result = await githubPushFiles(token, linked.repo, {
branch: linked.branch,
message: `Sync project ${project.name}`,
files: files.map(f => ({ path: cleanRepoPath(f.path), text: f.text, b64: f.b64 }))
});
await sendProjectGithubMenu(chatId, userId, env, `✅ ارسال کامل شد: ${result.files_pushed || files.length} فایل به ${linked.repo}@${linked.branch}. ${result.commit_url || ''}`);
} catch (e) {
logSafeError('github_push', e);
await sendProjectGithubMenu(chatId, userId, env, `❌ ارسال ناموفق بود. ${userSafeErrorMessage(e, 'github')}`);
}
}

async function createProject(chatId, name, env) {
const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
if (!cleanName || cleanName.length > 40 || !/^[\p{L}\p{N} _.-]+$/u.test(cleanName)) {
return { ok: false, message: 'نام پروژه باید ۱ تا ۴۰ نویسه باشد و از حروف، عدد، فاصله، نقطه، خط تیره یا زیرخط تشکیل شود.' };
}
const projects = await getProjects(chatId, env);
if (projects.length >= MAX_PROJECTS_PER_CHAT) return { ok: false, message: `حداکثر ${MAX_PROJECTS_PER_CHAT} پروژه می‌توانی داشته باشی.` };
if (projects.some(p => normalizeProjectName(p.name) === normalizeProjectName(cleanName))) {
return { ok: false, message: 'پروژه‌ای با این نام از قبل وجود دارد.' };
}
const project = { id: crypto.randomUUID().replace(/-/g, ''), name: cleanName, created_at: new Date().toISOString() };
projects.push(project);
await env.STATS.put(projectsKey(chatId), JSON.stringify(projects));
await env.STATS.put(activeProjectKey(chatId), project.id);
return { ok: true, project, message: `✅ پروژهٔ «${cleanName}» ساخته و فعال شد.` };
}

async function deleteProjectById(chatId, projectId, env) {
const projects = await getProjects(chatId, env);
const project = projects.find(p => p.id === projectId);
if (!project) return { ok: false, message: 'این پروژه دیگر وجود ندارد؛ هیچ داده‌ای حذف نشد.' };
const active = await getActiveProject(chatId, env);
await env.STATS.delete(wsKey(chatId, project.id));
await env.STATS.delete(projectRepoKey(chatId, project.id));
await ensureSchema(env);
await env.DB.prepare('DELETE FROM project_chat_history WHERE chat_id = ? AND project_id = ?').bind(chatId, project.id).run();
await env.STATS.put(projectsKey(chatId), JSON.stringify(projects.filter(p => p.id !== project.id)));
if (active?.id === project.id) await env.STATS.delete(activeProjectKey(chatId));
return { ok: true, name: project.name };
}

async function startProjectCreateFlow(chatId, env) {
await env.STATS.put(projectFlowKey(chatId), 'name', { expirationTtl: 600 });
await sendMessage(chatId, '✏️ اسم پروژهٔ جدید را بفرست (حداکثر ۴۰ نویسه).', env, {
inline_keyboard: [[{ text: '❌ لغو', callback_data: 'project:cancel' }]]
});
}

async function handleProjectFlowInput(chatId, userId, text, env) {
const flow = await env.STATS.get(projectFlowKey(chatId));
if (!flow) return false;
if (flow === 'repo') {
const result = await linkProjectRepo(chatId, userId, text, env);
if (!result.ok) {
await sendMessage(chatId, `⚠️ ${result.message}\n\nآدرس دیگری بفرست یا لغو کن.`, env, {
inline_keyboard: [[{ text: '❌ لغو', callback_data: 'project:cancel' }]]
});
return true;
}
await env.STATS.delete(projectFlowKey(chatId));
await sendProjectGithubMenu(chatId, userId, env, result.message);
return true;
}
if (flow !== 'name') return false;
const result = await createProject(chatId, text, env);
if (!result.ok) {
await sendMessage(chatId, `⚠️ ${result.message}\n\nاسم دیگری بفرست یا لغو کن.`, env, {
inline_keyboard: [[{ text: '❌ لغو', callback_data: 'project:cancel' }]]
});
return true;
}
await env.STATS.delete(projectFlowKey(chatId));
await sendProjectMenu(chatId, env, result.message);
return true;
}

async function handleProjectCommand(chatId, userId, args, env) {
const action = (args[0] || '').toLowerCase();
const name = args.slice(1).join(' ').trim();
if (!action) {
await sendProjectMenu(chatId, env, 'دستورها: /project new <نام> برای ساخت مستقیم، /project delete <نام> برای حذف.');
return;
}
if (action === 'list' || action === 'ls') {
await sendProjectMenu(chatId, env);
return;
}
if (action === 'new' || action === 'create') {
if (!name) {
await startProjectCreateFlow(chatId, env);
return;
}
const result = await createProject(chatId, name, env);
await sendProjectMenu(chatId, env, result.message);
return;
}
if (action === 'repo') {
if (name.toLowerCase() === 'off') {
const project = await getActiveProject(chatId, env);
if (project) await env.STATS.delete(projectRepoKey(chatId, project.id));
await sendProjectGithubMenu(chatId, userId, env, 'اتصال مخزن از پروژه جدا شد؛ فایل‌های workspace حفظ شدند.');
return;
}
if (!name) { await sendProjectGithubMenu(chatId, userId, env); return; }
const result = await linkProjectRepo(chatId, userId, name, env);
await sendProjectGithubMenu(chatId, userId, env, result.message);
return;
}
if (action === 'sync') { await sendProjectGithubMenu(chatId, userId, env); return; }
if (action === 'pull') {
if ((args[1] || '').toLowerCase() === 'overwrite') await startProjectOverwritePull(chatId, userId, env);
else await pullProjectRepo(chatId, userId, env, false);
return;
}
if (action === 'push') { await startProjectPush(chatId, userId, env); return; }
if (action === 'use' || action === 'switch') {
const projects = await getProjects(chatId, env);
const project = projects.find(p => normalizeProjectName(p.name) === normalizeProjectName(name));
if (!project) { await sendProjectMenu(chatId, env, 'این پروژه پیدا نشد.'); return; }
await env.STATS.put(activeProjectKey(chatId), project.id);
await sendProjectMenu(chatId, env, `✅ پروژهٔ «${project.name}» فعال شد.`);
return;
}
if (['off', 'default'].includes(action)) {
await env.STATS.delete(activeProjectKey(chatId));
await sendProjectMenu(chatId, env, '✅ به فضای پیش‌فرض برگشتی؛ داده‌های پروژه‌ها حفظ شده‌اند.');
return;
}
if (['delete', 'remove'].includes(action)) {
const projects = await getProjects(chatId, env);
const active = await getActiveProject(chatId, env);
const project = projects.find(p => normalizeProjectName(p.name) === normalizeProjectName(name));
if (!project) { await sendProjectMenu(chatId, env, 'این پروژه پیدا نشد.'); return; }
await requestActionConfirmation(chatId, userId, env, {
kind: 'project_delete',
payload: { projectId: project.id, label: `حذف پروژهٔ ${project.name}` },
title: `حذف پروژهٔ «${project.name}»`,
details: `فضای کار، تاریخچهٔ گفتگو و اتصال مخزن این پروژه حذف می‌شود. این کار قابل بازگشت نیست.${active?.id === project.id ? '\nاین پروژه در حال حاضر فعال است و پس از حذف به حالت پیش‌فرض برمی‌گردی.' : ''}`
});
return;
}
await sendProjectMenu(chatId, env, 'دستور پروژه را نشناختم.');
}

// =============== مدیریت پیام‌های تلگرام ===============

const TELEGRAM_COMMANDS_VERSION = '2026-11-09-v2';
const TELEGRAM_COMMANDS = [
{ command: 'start', description: 'شروع ربات و نمایش منوی اصلی' },
{ command: 'help', description: 'راهنما و فهرست قابلیت‌های ربات' },
{ command: 'login', description: 'اتصال مدل هوش مصنوعی شخصی' },
{ command: 'logout', description: 'قطع اتصال مدل هوش مصنوعی شخصی' },
{ command: 'ai', description: 'مدیریت اتصال مدل هوش مصنوعی' },
{ command: 'project', description: 'مدیریت پروژه‌ها، workspace و GitHub' },
{ command: 'github', description: 'اتصال یا بررسی اتصال GitHub' },
{ command: 'github_off', description: 'حذف توکن GitHub' },
{ command: 'cloudflare', description: 'اتصال امن و مدیریت Cloudflare' },
{ command: 'workspace', description: 'نمایش فایل‌های فضای کار فعال' },
{ command: 'workspace_clear', description: 'پاک‌کردن فضای کار فعال' },
{ command: 'lang', description: 'تنظیم زبان پیش‌فرض' },
{ command: 'search', description: 'جست‌وجوی وب؛ پس از دستور عبارت را بنویس' },
{ command: 'debug', description: 'تحلیل و دیباگ کد یا خطا' },
{ command: 'clear', description: 'پاک‌کردن حافظهٔ گفتگو' },
{ command: 'new', description: 'شروع گفتگوی تازه' }
];

async function ensureTelegramCommands(env) {
if (!env.TELEGRAM_BOT_TOKEN) return;
const versionKey = 'telegram_command_menu_version';
try {
if (await env.STATS.get(versionKey) === TELEGRAM_COMMANDS_VERSION) return;
} catch {}

try {
const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ commands: TELEGRAM_COMMANDS })
});
const result = await response.json();
if (!response.ok || !result.ok) throw new Error(result.description || `HTTP ${response.status}`);
await env.STATS.put(versionKey, TELEGRAM_COMMANDS_VERSION);
} catch (error) {
logSafeError('telegram_command_menu', error);
}
}

async function handleUpdate(update, env, publicOrigin = '') {
await ensureTelegramCommands(env);
// دکمه‌های شیشه‌ای (inline) — منوی هوش مصنوعی شخصی
if (update.callback_query) {
await handleCallbackQuery(update.callback_query, env);
return;
}

if (!update.message) return;

const chatId = update.message.chat.id;
const userId = update.message.from.id;
const username = update.message.from.username || 'کاربر';
const text = update.message.text || '';
const caption = update.message.caption || '';
const photo = update.message.photo;
const document = update.message.document;
const messageId = update.message.message_id;

try {
await saveUser(userId, username, chatId, env);

await incrementStat('total_messages', env);

if (photo) {
await handlePhoto(chatId, userId, photo, caption, env);
await incrementStat('total_files', env);
} else if (document) {
await handleDocument(chatId, document, caption, env, userId);
await incrementStat('total_files', env);
} else if (text.startsWith('/')) {
await handleCommand(chatId, userId, text, env, messageId, publicOrigin);
} else if (await handleProjectFlowInput(chatId, userId, text, env)) {
// نام پروژه در جریان ساخت با دکمه دریافت شد
} else if (looksLikeGithubToken(text)) {
// کاربر توکن را بدون دستور فرستاده
await saveGithubTokenFromChat(chatId, userId, text.trim(), env, messageId);
} else if (await handleKeyboardButton(chatId, userId, text, env)) {
// یکی از دکمه‌های کیبورد ثابت زده شد
} else if (await handleAiFlowInput(chatId, userId, text, env, messageId)) {
// پیام در جریان اتصال مدل شخصی مصرف شد
} else {
await handleText(chatId, userId, text, env);
}
} catch (error) {
logSafeError('telegram_update', error);
await sendMessage(chatId, `❌ ${userSafeErrorMessage(error)}`, env);
}
}

// دستورات
async function handleCommand(chatId, userId, text, env, messageId, publicOrigin = '') {
const parts = text.trim().split(/\s+/);
const command = parts[0].toLowerCase().split('@')[0];
const args = parts.slice(1);
const settings = await getSettingsData(env);

switch (command) {
case '/start': {
await sendMessage(chatId, settings.welcome_message || 'به دستیار کدنویسی خوش آمدید! 🤖', env, aiMenuKeyboard(!!(await getUserAIConn(userId, env))));
break;
}

case '/ai':
case '/login': {
if (['off', 'remove', 'حذف'].includes((args[0] || '').toLowerCase())) {
await removeAiConn(chatId, userId, env);
} else {
await sendAiMenu(chatId, userId, env);
}
break;
}

case '/logout': {
await removeAiConn(chatId, userId, env);
break;
}

case '/help': {
let help = '📋 راهنما:\n\n' +
'/start - شروع مجدد\n' +
'/help - نمایش این راهنما\n' +
'/ai - اتصال مدل هوش مصنوعی شخصی (Base URL + API Key + نام مدل)\n' +
'/login - میان‌بر اتصال مدل هوش مصنوعی شخصی\n' +
'/logout - قطع اتصال مدل هوش مصنوعی شخصی\n' +
'/project - ساخت و جابه‌جایی بین پروژه‌ها (حافظه و فضای کار جداگانه)\n' +
'/project repo <owner/repo> [branch] - اتصال مخزن به پروژهٔ فعال\n' +
'/project sync - منوی GitHub پروژه\n' +
'/project pull [overwrite] - دریافت فایل‌های مخزن (بدون overwrite پیش‌فرض)\n' +
'/project push - پیش‌نمایش و ارسال workspace پس از تأیید\n' +
'/lang <زبان> - تنظیم زبان پیش‌فرض\n' +
'/search <عبارت> - جستجوی وب\n' +
'/debug <کد/خطا> - تحلیل و دیباگ کد یا خطا\n' +
'/clear - پاک کردن حافظه گفتگو (میان‌بر: /new)\n\n' +
'🤖 قابلیت‌ها:\n' +
'• ارسال کد (متنی) → دیباگ خودکار با هوش مصنوعی\n' +
'• ارسال سوال → پاسخ از هوش مصنوعی (با حافظه گفتگو)\n' +
'• search: عبارت → جستجوی وب\n' +
'• 📷 ارسال اسکرین‌شات خطا → خواندن خطا از تصویر و ارائه راه‌حل\n' +
'• 📄 ارسال فایل کد → تحلیل و دیباگ فایل\n' +
'• 🗜️ ارسال ZIP مخزن → باز کردن و خواندن کامل کدها و پیدا کردن باگ‌ها\n' +
'• می‌توانید زیر عکس/فایل توضیح یا سوال خود را بنویسید (Caption)\n\n' +
'🧠 هوش مصنوعی شخصی:\n' +
'اگر به مدل پولی یا رایگان دسترسی داری، با /ai یا دکمه‌های ربات وصلش کن تا همه قابلیت‌ها با مدل خودت کار کنه.\n\n' +
'🐙 گیت‌هاب:\n' +
'/github <توکن> - وصل کردن گیت‌هاب (پیام توکن خودکار پاک می‌شود)\n' +
'/github - وضعیت اتصال\n' +
'/github_off - حذف توکن\n' +
'/cloudflare - اتصال امن، وضعیت یا مدیریت حساب Cloudflare\n' +
'• اتصال Cloudflare در چت خصوصی با فرم HTTPS انجام می‌شود؛ توکن را داخل تلگرام نفرست.\n' +
'/cloudflare off - قطع اتصال و حذف توکن رمزگذاری‌شده\n' +
'/workspace - فایل‌های آماده برای پوش\n' +
'/workspace_clear - خالی کردن فضای کار\n' +
'بعد از وصل شدن، کافیه طبیعی بگی؛ مثلاً: «این ZIP رو تو یه ریپو خصوصی جدید به اسم my-app پوش کن»';
if (!(await hasAnyAI(userId, env, settings))) {
help += '\n\n⚠️ هوش مصنوعی هنوز تنظیم نشده است! می‌توانید با /ai مدل شخصی خودتان را وصل کنید.';
}
await sendMessage(chatId, help, env, aiMenuKeyboard(!!(await getUserAIConn(userId, env))));
break;
}

case '/lang': {
if (args.length === 0) {
await sendMessage(chatId, '⚠️ لطفا زبان را مشخص کنید. مثال: /lang python', env);
} else {
const lang = args[0].toLowerCase();
await env.DB.prepare('UPDATE users SET preferred_language = ? WHERE id = ?').bind(lang, userId).run();
await sendMessage(chatId, `✅ زبان پیش‌فرض شما به «${lang}» تغییر یافت.`, env);
}
break;
}

case '/search': {
const query = text.trim().slice(parts[0].length).trim();
if (!query) {
await sendMessage(chatId, '⚠️ عبارت جستجو را بعد از دستور بنویس. مثال: /search Cloudflare Workers', env);
} else {
await handleText(chatId, userId, `search: ${query}`, env);
}
break;
}

case '/debug': {
const input = text.trim().slice(parts[0].length).trim();
if (!input) {
await sendMessage(chatId, '⚠️ کد یا متن خطا را بعد از دستور بفرست؛ یا فایل/عکس را مستقیم پیوست کن.', env);
} else {
await handleText(chatId, userId, input, env);
}
break;
}

case '/project': {
await handleProjectCommand(chatId, userId, args, env);
break;
}

case '/clear':
case '/new': {
await clearHistory(chatId, env);
await sendMessage(chatId, '🧹 حافظه گفتگو پاک شد.', env);
break;
}

case '/github': {
if (args.length === 0) {
await sendGithubStatus(chatId, userId, env);
} else if (['off', 'logout', 'remove'].includes(args[0].toLowerCase())) {
await deleteGithubCredential(userId, env);
await sendMessage(chatId, 'توکن گیت‌هاب پاک شد.', env);
} else {
await saveGithubTokenFromChat(chatId, userId, args[0], env, messageId);
}
break;
}

case '/github_off': {
await deleteGithubCredential(userId, env);
await sendMessage(chatId, 'توکن گیت‌هاب پاک شد.', env);
break;
}

case '/cloudflare': {
if (String(chatId) !== String(userId)) {
await sendMessage(chatId, 'برای امنیت، اتصال یا مدیریت Cloudflare را فقط در گفت‌وگوی خصوصی با ربات انجام بده.', env);
break;
}
const action = (args[0] || '').toLowerCase();
if (['off', 'disconnect', 'remove', 'حذف'].includes(action)) {
await deleteCloudflareCredential(userId, env);
await sendMessage(chatId, 'اتصال Cloudflare حذف شد؛ توکن ذخیره‌شده دیگر قابل استفاده نیست.', env);
} else if (action === 'status') {
const meta = await getCloudflareCredentialMeta(userId, env);
await sendMessage(chatId, meta ? `Cloudflare وصله. شناسهٔ token: ${meta.tokenId || 'نامشخص'}${meta.expiresOn ? `\nانقضا: ${meta.expiresOn}` : ''}\nبرای قطع اتصال: /cloudflare off` : 'Cloudflare هنوز وصل نیست. برای اتصال امن: /cloudflare connect', env);
} else if (action === 'connect') {
await startCloudflareConnect(chatId, userId, env, publicOrigin);
} else if (await getCloudflareCredentialMeta(userId, env)) {
const meta = await getCloudflareCredentialMeta(userId, env);
await sendMessage(chatId, `Cloudflare وصله. شناسهٔ token: ${meta?.tokenId || 'نامشخص'}\nبرای اتصال دوباره: /cloudflare connect\nبرای قطع اتصال: /cloudflare off`, env);
} else {
await startCloudflareConnect(chatId, userId, env, publicOrigin);
}
break;
}

case '/workspace': {
const ws = await getWorkspace(chatId, env);
if (!ws.files.length) {
await sendMessage(chatId, 'فضای کار خالیه. یه فایل ZIP یا فایل کد بفرست تا اینجا ذخیره بشه.', env);
} else {
const total = ws.files.reduce((a, f) => a + (f.size || 0), 0);
const list = ws.files.slice(0, 40).map(f => '- ' + f.path).join('\n');
await sendMessage(chatId, `فضای کار: ${ws.name || 'بدون نام'} — ${ws.files.length} فایل (${formatSizeClient(total)})\n\n${list}${ws.files.length > 40 ? `\n... و ${ws.files.length - 40} فایل دیگر` : ''}`, env);
}
break;
}

case '/workspace_clear': {
const project = await getActiveProject(chatId, env);
const ws = await getWorkspace(chatId, env);
if (!ws.files.length) {
await sendMessage(chatId, 'فضای کار از قبل خالی است.', env);
break;
}
await requestActionConfirmation(chatId, userId, env, {
kind: 'workspace_clear',
payload: { projectId: project?.id || null, workspaceName: project?.name || ws.name || 'فضای کار پیش‌فرض', workspaceFingerprint: await projectFilesFingerprint(ws.files || []), label: 'پاک‌کردن فضای کار' },
title: 'پاک‌کردن فضای کار فعال',
details: `فضا: ${project?.name || ws.name || 'پیش‌فرض'} | فایل‌ها: ${ws.files.length}\nتمام فایل‌های این workspace حذف می‌شوند و قابل بازگشت نیستند.`
});
break;
}

default: {
// دستور ناشناخته → به‌جای خطا، طبیعی جواب بده
await handleText(chatId, userId, text, env);
}
}
}

// پیام‌های متنی: جستجو، دیباگ کد با AI، یا چت با AI
async function handleText(chatId, userId, text, env) {
if (!text) return;
const settings = await getSettingsData(env);

// ۱) جستجوی وب: "search: عبارت" یا "جستجو: عبارت"
const searchMatch = text.match(/^\s*(search|جستجو)\s*:\s*(.+)$/i);
if (searchMatch) {
if (!settings.search_enabled) {
await sendMessage(chatId, '⚠️ قابلیت جستجو در حال حاضر غیرفعال است.', env);
return;
}
const query = searchMatch[2].trim();
await sendChatAction(chatId, 'typing', env);
const result = await webSearch(query);
await incrementStat('total_search', env);
await sendLongMessage(chatId, `🌐 نتیجه جستجو برای «${query}»:\n\n${result}`, env);
return;
}

// ۲) محدودیت طول
const maxLen = settings.max_code_length || 8000;
if (text.length > maxLen) {
await sendMessage(chatId, `⚠️ متن ارسالی بیش از حد مجاز (${maxLen} کاراکتر) است. برای کد بلند، آن را به‌صورت فایل بفرستید.`, env);
return;
}

await sendChatAction(chatId, 'typing', env);

// ۳) ارسال به هوش مصنوعی — حالت ایجنت (گفتگو + ابزارها) همراه با حافظه گفتگو
if (await hasAnyAI(userId, env, settings)) {
const isCode = isLikelyCode(text);
if (isCode) await incrementStat('total_code', env);
try {
await runAgent(chatId, userId, text, env, settings, { isCode });
} catch (e) {
logSafeError('ai_chat', e);
await sendLongMessage(chatId, userSafeErrorMessage(e, 'ai'), env);
}
return;
}

// ۴) بدون AI → تحلیل محلی ساده
const report = analyzeCode(text, settings.default_language);
await incrementStat('total_code', env);
await sendLongMessage(chatId, report + '\n\n💡 برای دیباگ واقعی، کلید API را در پنل ادمین تنظیم کنید یا با /ai مدل شخصی خودتان را وصل کنید.', env);
}

// تشخیص دقیق‌تر: کد یا لاگ خطا؟ (سوال‌های معمولی وارد پرامپت دیباگ نمی‌شوند)
function isLikelyCode(text) {
if (text.includes('```')) return true;
const lineCount = text.split('\n').length;
if (lineCount >= 3 && /Traceback \(most recent call last\)|^\s*at\s+\S+.*:\d+:\d+|\b\w*(Error|Exception)\b\s*:/m.test(text)) return true;
return lineCount >= 3 && detectLanguage(text) !== null;
}

// تحلیل عکس با مدل بینایی (Vision)
async function handlePhoto(chatId, userId, photo, caption, env) {
const settings = await getSettingsData(env);
const largest = photo[photo.length - 1];

try {
await sendChatAction(chatId, 'typing', env);
const fileInfo = await getTelegramFile(largest.file_id, env);

// ذخیره متادیتا
const key = `photo_${Date.now()}_${largest.file_id}`;
await env.FILES.put(key, JSON.stringify({
key,
name: (fileInfo.file_path || `${largest.file_id}.jpg`).split('/').pop(),
size: largest.file_size || fileInfo.file_size || 0,
date: new Date().toISOString(),
file_id: largest.file_id,
type: 'photo'
}));

if (!(await hasAnyAI(userId, env, settings))) {
await sendMessage(chatId, '📸 عکس ذخیره شد.\n💡 برای تحلیل عکس با هوش مصنوعی، کلید API را در پنل ادمین تنظیم کنید یا با /ai مدل شخصی خودتان را وصل کنید.', env);
return;
}

const buffer = await downloadTelegramFile(fileInfo.file_path, env);
const mime = (fileInfo.file_path || '').toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
await analyzeImage(chatId, userId, buffer, mime, caption, env, settings);
} catch (error) {
logSafeError('image_processing', error);
await sendLongMessage(chatId, `❌ ${userSafeErrorMessage(error, 'ai')}`, env);
}
}

// خواندن اسکرین‌شات با مدل بینایی (هم برای عکس معمولی، هم عکسِ ارسال‌شده به‌صورت فایل)
async function analyzeImage(chatId, userId, buffer, mime, caption, env, settings) {
if (!(await hasAnyAI(userId, env, settings))) {
await sendMessage(chatId, '💡 برای تحلیل عکس، کلید API هوش مصنوعی را در پنل ادمین تنظیم کنید یا با /ai مدل شخصی خودتان را وصل کنید.', env);
return;
}
if (buffer.byteLength > 8 * 1024 * 1024) {
await sendMessage(chatId, '⚠️ حجم عکس برای تحلیل زیاد است (حداکثر ۸ مگابایت).', env);
return;
}

const base64 = arrayBufferToBase64(buffer);
const history = await getHistory(chatId, env, settings);
const userText = caption
? `درخواست کاربر درباره این تصویر: ${caption}`
: 'این اسکرین‌شات را بررسی کن و خطا را پیدا کن.';

const reply = await callAI([
{ role: 'system', content: PROMPTS.photo },
...history,
{ role: 'user', content: [
{ type: 'text', text: userText },
{ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
] }
], env, {
userId,
model: settings.ai_vision_model || settings.ai_model,
max_tokens: 1500
});

await addHistory(chatId, [
{ role: 'user', content: `[اسکرین‌شات ارسال شد] ${caption || ''}`.trim() },
{ role: 'assistant', content: reply }
], env, settings);

await sendLongMessage(chatId, '📸 ' + reply, env);
}

// مدیریت فایل‌ها: فایل کد → تحلیل | ZIP → استخراج و تحلیل
async function handleDocument(chatId, document, caption, env, userId) {
const settings = await getSettingsData(env);
const fileName = document.file_name || 'file';
const ext = (fileName.split('.').pop() || '').toLowerCase();
const mimeType = document.mime_type || '';
const isZip = ext === 'zip' ||
mimeType === 'application/zip' ||
mimeType === 'application/x-zip-compressed';
const isImage = mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp'].includes(ext);

// محدودیت API تلگرام: ۲۰ مگابایت
if ((document.file_size || 0) > 20 * 1024 * 1024) {
await sendMessage(chatId, '⚠️ حجم فایل بیش از ۲۰ مگابایت است و قابل پردازش نیست.', env);
return;
}

await sendChatAction(chatId, 'typing', env);

try {
const fileInfo = await getTelegramFile(document.file_id, env);
const buffer = await downloadTelegramFile(fileInfo.file_path, env);

// ذخیره متادیتا
const key = `doc_${Date.now()}_${document.file_id}`;
await env.FILES.put(key, JSON.stringify({
key,
name: fileName,
size: document.file_size || buffer.byteLength,
date: new Date().toISOString(),
file_id: document.file_id,
mime_type: mimeType,
type: isZip ? 'zip' : (isImage ? 'photo' : 'document')
}));

if (isZip) {
await handleZipFile(chatId, buffer, fileName, env, settings, caption, userId);
} else if (isImage) {
// اسکرین‌شاتی که به‌صورت فایل (بدون فشرده‌سازی) فرستاده شده
const imgMime = mimeType.startsWith('image/') ? mimeType : (ext === 'png' ? 'image/png' : 'image/jpeg');
await analyzeImage(chatId, userId, buffer, imgMime, caption, env, settings);
} else if (isTextFile(ext, mimeType)) {
await handleTextFile(chatId, userId, buffer, fileName, env, settings, caption, userId);
} else {
await sendMessage(chatId, `📦 فایل «${fileName}» (${formatSizeClient(buffer.byteLength)}) ذخیره شد.\n💡 فقط فایل‌های متنی/کد، تصویر و ZIP تحلیل می‌شوند.`, env);
}
} catch (error) {
logSafeError('file_processing', error);
await sendMessage(chatId, `❌ ${userSafeErrorMessage(error, 'file')}`, env);
}
}

// خواندن و تحلیل فایل متنی/کد
async function handleTextFile(chatId, userId, buffer, fileName, env, settings, caption = '') {
const text = new TextDecoder().decode(buffer);

// فایل به فضای کار اضافه می‌شود تا بشود بعداً آن را ویرایش یا پوش کرد
let wsNote = '';
if (!ZIP_SECRET_FILES.test(fileName)) {
try {
await addFilesToWorkspace(chatId, [{ path: fileName, size: buffer.byteLength, text }], env, null);
wsNote = fileName;
} catch (e) { logSafeError('workspace_add', e); }
}

// اگر کاربر زیر فایل درخواست نوشته (مثلاً «اینو تو ریپوی X پوش کن»)، ایجنت انجامش می‌دهد
if (caption && (await hasAnyAI(userId, env, settings))) {
const preview = text.length > 30000 ? text.substring(0, 30000) + '\n... [ادامه فایل در فضای کار موجود است]' : text;
await runAgent(chatId, userId, `[کاربر فایل «${fileName}» را فرستاد${wsNote ? ' و این فایل در فضای کار (workspace) ذخیره شد' : ''}]\nدرخواست کاربر: ${caption}\n\nمحتوای فایل:\n\`\`\`\n${preview}\n\`\`\``, env, settings, { historyText: `[فایل «${fileName}» ارسال شد] ${caption}` });
return;
}

if (!(await hasAnyAI(userId, env, settings))) {
const report = analyzeCode(text, null);
await sendLongMessage(chatId, `📄 فایل «${fileName}»:\n\n${report}\n\n💡 برای تحلیل کامل، کلید API را در پنل تنظیم کنید یا با /ai مدل شخصی خودتان را وصل کنید.`, env);
return;
}

// محدود کردن حجم متن ارسالی به AI
const truncated = text.length > 150000
? text.substring(0, 150000) + '\n\n... [بخشی از فایل به دلیل حجم حذف شد]'
: text;

await sendChatAction(chatId, 'typing', env);
const numbered = addLineNumbers(truncated);
const reply = await callAI([
{ role: 'system', content: PROMPTS.file + '\nشماره خطوط (مثل «12|») فقط برای ارجاع است و در کد اصلاح‌شده نباید بیاید.' },
{ role: 'user', content: `نام فایل: ${fileName}\n${caption ? 'درخواست کاربر: ' + caption + '\n' : ''}محتوا:\n${numbered}` }
], env, { userId, max_tokens: 2500 });

await addHistory(chatId, [
{ role: 'user', content: `[فایل «${fileName}» ارسال شد] ${caption || ''}`.trim() },
{ role: 'assistant', content: reply }
], env, settings);

await sendLongMessage(chatId, `📄 «${fileName}»:\n\n${reply}`, env);
}

function addLineNumbers(text) {
return text.split('\n').map((l, i) => `${i + 1}| ${l}`).join('\n');
}

// استخراج و تحلیل فایل ZIP
async function handleZipFile(chatId, buffer, fileName, env, settings, caption = '', userId = null) {
let files;
try {
files = await extractZip(buffer);
} catch (e) {
logSafeError('zip_processing', e);
await sendMessage(chatId, `باز کردن فایل ZIP ناموفق بود. ${userSafeErrorMessage(e, 'file')}`, env);
return;
}

// کل پروژه (با فایل‌های باینری) در فضای کار ذخیره می‌شود تا قابل پوش به گیت‌هاب باشد
let wsInfo = null;
try {
wsInfo = await saveZipToWorkspace(chatId, buffer, fileName, env);
} catch (e) { logSafeError('workspace_save', e); }

// اگر کاربر زیر ZIP درخواستی نوشته (مثلاً پوش به گیت‌هاب)، ایجنت انجامش می‌دهد
if (caption && (await hasAnyAI(userId, env, settings))) {
const note = wsInfo
? `[کاربر فایل ZIP «${fileName}» را فرستاد. ${wsInfo.count} فایل (${formatSizeClient(wsInfo.bytes)}) در فضای کار (workspace) ذخیره شد${wsInfo.skipped ? `؛ ${wsInfo.skipped} فایل (node_modules، .git، .env و...) کنار گذاشته شد` : ''}. برای دیدن فایل‌ها از workspace_list_files استفاده کن.]`
: `[کاربر فایل ZIP «${fileName}» را فرستاد اما ذخیره در فضای کار ناموفق بود.]`;
await runAgent(chatId, userId, `${note}\nدرخواست کاربر: ${caption}`, env, settings, { historyText: `[پروژه ZIP «${fileName}» ارسال شد] ${caption}` });
return;
}

// حذف پوشه ریشه مشترک (مثلاً repo-main/) برای خوانایی
const rootMatch = files.length && files.every(f => f.name.includes('/') && f.name.split('/')[0] === files[0].name.split('/')[0])
? files[0].name.split('/')[0] + '/' : '';
const cleanName = n => (rootMatch && n.startsWith(rootMatch)) ? n.slice(rootMatch.length) : n;

// فایل‌های قابل خواندن
const readable = [];
let secretsSkipped = 0;
for (const f of files) {
const name = cleanName(f.name);
if (ZIP_SECRET_FILES.test(name)) { secretsSkipped++; continue; }
if (!f.content) continue;
let content = new TextDecoder().decode(f.content);
if (content.includes('\u0000')) continue; // فایل باینری
let note = '';
if (content.length > 60000) { content = content.substring(0, 60000); note = ' (بخش اول فایل)'; }
const ext = (name.split('.').pop() || '').toLowerCase();
const rank = CODE_EXTENSIONS.has(ext) ? 0 : (['md', 'markdown', 'txt', 'csv', 'tsv', 'log'].includes(ext) ? 2 : 1);
readable.push({ name, content, note, rank });
}

if (readable.length === 0) {
await sendMessage(chatId, `🗜️ «${fileName}» شامل ${files.length} فایل است، اما فایل متنی/کدی قابل خواندن پیدا نشد.`, env);
return;
}

// اولویت: کد اصلی → تنظیمات → مستندات؛ سپس ترتیب مسیر
readable.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

// تقسیم به بخش‌ها (هر بخش حداکثر ~۱۰۰ هزار کاراکتر، حداکثر ۳ بخش)
const BATCH_CHARS = 100000;
const MAX_BATCHES = 3;
const batches = [];
let cur = [], curChars = 0;
const skippedForSize = [];
for (const f of readable) {
const block = `\n\n===== فایل: ${f.name}${f.note} =====\n${addLineNumbers(f.content)}`;
if (curChars + block.length > BATCH_CHARS && cur.length > 0) {
if (batches.length + 1 >= MAX_BATCHES) { skippedForSize.push(f.name); continue; }
batches.push(cur); cur = []; curChars = 0;
}
cur.push(block); curChars += block.length;
}
if (cur.length) batches.push(cur);

const tree = readable.map(f => '- ' + f.name).join('\n');

let msg = `🗜️ «${fileName}»: ${files.length} فایل، ${readable.length} فایل کد/متن خوانده می‌شود.`;
if (wsInfo) msg += `\n📦 پروژه تو فضای کار ذخیره شد؛ اگه خواستی بگو تا تو گیت‌هاب پوشش کنم.`;
if (secretsSkipped) msg += `\n🔒 ${secretsSkipped} فایل .env به‌دلیل امنیت نادیده گرفته شد.`;
if (skippedForSize.length) msg += `\n⚠️ به‌دلیل حجم زیاد ${skippedForSize.length} فایل کم‌اهمیت‌تر خوانده نشد.`;
if (batches.length > 1) msg += `\n⏳ پروژه بزرگ است؛ در ${batches.length} بخش بررسی می‌شود.`;
await sendMessage(chatId, msg, env);

if (!(await hasAnyAI(userId, env, settings))) {
await sendMessage(chatId, '💡 برای تحلیل محتوای پروژه، کلید API را در پنل تنظیم کنید یا با /ai مدل شخصی خودتان را وصل کنید.', env);
return;
}

const replies = [];
for (let i = 0; i < batches.length; i++) {
await sendChatAction(chatId, 'typing', env);
let userContent = `پروژه: «${fileName}»\nساختار کل فایل‌ها:\n${tree}\n`;
if (caption) userContent += `\nدرخواست کاربر: ${caption}\n`;
if (batches.length > 1) userContent += `\nاین «بخش ${i + 1} از ${batches.length}» کد است. فقط فایل‌های همین بخش را بررسی کن.\n`;
userContent += `\nکدها:${batches[i].join('')}`;

const reply = await callAI([
{ role: 'system', content: PROMPTS.zip },
{ role: 'user', content: userContent }
], env, { userId, max_tokens: 3500 });
replies.push(reply);

const title = batches.length > 1 ? `🔍 تحلیل پروژه (بخش ${i + 1}/${batches.length}):` : '🔍 تحلیل پروژه:';
await sendLongMessage(chatId, `${title}\n\n${reply}`, env);
}

await incrementStat('total_code', env);
await addHistory(chatId, [
{ role: 'user', content: `[پروژه ZIP «${fileName}» ارسال شد. فایل‌ها:\n${readable.slice(0, 40).map(f => f.name).join('\n')}]` },
{ role: 'assistant', content: replies.join('\n\n') }
], env, settings);
}

// استخراج ZIP با DecompressionStream داخلی Workers (بدون کتابخانه خارجی)
async function extractZip(buffer, opts = {}) {
const view = new DataView(buffer);
const decoder = new TextDecoder();

// جستجوی امضای End of Central Directory
let eocd = -1;
const minPos = Math.max(0, buffer.byteLength - 22 - 65536);
for (let i = buffer.byteLength - 22; i >= minPos; i--) {
if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('ساختار فایل ZIP معتبر نیست');

let count = view.getUint16(eocd + 10, true);
let offset = view.getUint32(eocd + 16, true);
if (count > 5000) count = 5000; // محدودیت امنیتی

const MAX_FILE_BYTES = opts.all ? 5 * 1024 * 1024 : 300 * 1024;        // فایل بزرگ‌تر از این خوانده نمی‌شود
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // سقف مجموع حجم باز‌شده (ضد ZIP bomb)
let totalExtracted = 0;
const files = [];

for (let i = 0; i < count; i++) {
if (view.getUint32(offset, true) !== 0x02014b50) break;

const method = view.getUint16(offset + 10, true);
const compressedSize = view.getUint32(offset + 20, true);
const uncompressedSize = view.getUint32(offset + 24, true);
const nameLen = view.getUint16(offset + 28, true);
const extraLen = view.getUint16(offset + 30, true);
const commentLen = view.getUint16(offset + 32, true);
const localOffset = view.getUint32(offset + 42, true);

const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLen));

if (!name.endsWith('/')) { // پوشه‌ها را رد کن
const ext = (name.split('.').pop() || '').toLowerCase();
// فقط فایل‌های متنی/کد و غیرِ پوشه‌های بی‌ارزش (node_modules و ...) باز می‌شوند
const wanted = opts.all
// حالت فضای کار: همه فایل‌ها (حتی باینری) جز پوشه‌های ساختنی/وابستگی و فایل‌های رمز
? (!WS_SKIP_DIRS.test(name) && !ZIP_SECRET_FILES.test(name) &&
uncompressedSize <= MAX_FILE_BYTES &&
totalExtracted + uncompressedSize <= MAX_TOTAL_BYTES)
: (!ZIP_SKIP_DIRS.test(name) && !ZIP_SKIP_FILES.test(name) && !ZIP_SECRET_FILES.test(name) &&
isTextFile(ext, '') &&
uncompressedSize <= MAX_FILE_BYTES &&
totalExtracted + uncompressedSize <= MAX_TOTAL_BYTES);

let content = null;
if (wanted) {
const lNameLen = view.getUint16(localOffset + 26, true);
const lExtraLen = view.getUint16(localOffset + 28, true);
const dataStart = localOffset + 30 + lNameLen + lExtraLen;
const rawData = new Uint8Array(buffer, dataStart, compressedSize);

if (method === 0) {
content = rawData; // بدون فشرده‌سازی
} else if (method === 8) {
const stream = new Blob([rawData]).stream()
.pipeThrough(new DecompressionStream('deflate-raw'));
content = new Uint8Array(await new Response(stream).arrayBuffer());
}
if (content) totalExtracted += content.byteLength;
}

files.push({ name, size: uncompressedSize, content });
}

offset += 46 + nameLen + extraLen + commentLen;
}

return files;
}

async function webSearch(query) {
try {
const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
const res = await fetch(url);
const data = await res.json();

let result = data.AbstractText || data.Answer || data.Definition || '';
if (data.AbstractURL) result += `\n🔗 ${data.AbstractURL}`;

if (data.RelatedTopics && data.RelatedTopics.length > 0) {
const related = data.RelatedTopics.filter(t => t.Text).slice(0, 5);
if (related.length > 0) {
result += '\n\n📌 موضوعات مرتبط:\n' +
related.map(t => `• ${t.Text}${t.FirstURL ? '\n ' + t.FirstURL : ''}`).join('\n');
}
}

return result || 'نتیجه مشخصی برای این عبارت پیدا نشد. عبارت دیگری را امتحان کنید.';
} catch (error) {
logSafeError('web_search', error);
return 'جستجو موقتاً انجام نشد. کمی بعد دوباره تلاش کن.';
}
}


// =============== حالت ایجنت: ابزارها، فضای کار و گیت‌هاب ===============
// ربات می‌تواند مثل یک دستیار واقعی با ابزارها کار انجام دهد:
// بررسی وضعیت → انجام کار → بررسی نتیجه → گزارش کوتاه

const AGENT_MAX_STEPS = 14;          // حداکثر دور فراخوانی ابزار در یک درخواست
const TOOL_RESULT_MAX_CHARS = 12000; // سقف خروجی هر ابزار که به مدل برمی‌گردد
const WS_MAX_TOTAL_BYTES = 15 * 1024 * 1024; // سقف حجم فضای کار (محدودیت KV = ۲۵ مگابایت)
const GH_TOKEN_TTL_SECONDS = 30 * 24 * 3600; // توکن حداکثر ۳۰ روز نگه داشته می‌شود
let agentToolsUnsupported = false;    // اگر مدل/سرویس از tool calling پشتیبانی نکند

// ---------- توکن گیت‌هاب (هر کاربر جدا؛ هرگز به مدل داده نمی‌شود) ----------
function ghTokenKey(userId) { return `gh_token:${userId}`; }
function githubCredentialMetadata(expiresAt, deleted = false) {
return JSON.stringify(deleted ? { deleted: true } : { expiresAt });
}

async function credentialCryptoKey(env) {
const value = env.CREDENTIALS_ENCRYPTION_KEY || env.CLOUDFLARE_ENCRYPTION_KEY;
if (!value) throw publicError('ذخیرهٔ امن توکن GitHub آماده نیست؛ مدیر باید CREDENTIALS_ENCRYPTION_KEY را به‌عنوان Worker Secret تنظیم کند.');
let raw;
try { raw = cfUnb64(String(value).trim()); } catch { throw new Error('کلید رمزگذاری اعتبارنامه باید Base64 معتبرِ ۳۲ بایتی باشد.'); }
if (raw.length !== 32) throw new Error('کلید رمزگذاری اعتبارنامه باید Base64 معتبرِ ۳۲ بایتی باشد.');
return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function githubCredentialAAD(userId) { return new TextEncoder().encode(`telegram-code-assistant:github:v1:${String(userId)}`); }
async function encryptGithubToken(token, userId, env) {
const key = await credentialCryptoKey(env);
const iv = crypto.getRandomValues(new Uint8Array(12));
const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: githubCredentialAAD(userId) }, key, new TextEncoder().encode(token));
return { iv: cfB64(iv), ciphertext: cfB64(new Uint8Array(cipher)) };
}
async function decryptGithubToken(ciphertext, ivValue, userId, env) {
const key = await credentialCryptoKey(env);
const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: cfUnb64(ivValue), additionalData: githubCredentialAAD(userId) }, key, cfUnb64(ciphertext));
return new TextDecoder().decode(raw);
}

async function readGithubCredentialRow(userId, env) {
await ensureSchema(env);
return env.DB.prepare("SELECT ciphertext, iv, metadata_json FROM user_integrations WHERE user_id = ? AND provider = 'github'").bind(String(userId)).first();
}

async function writeGithubCredential(userId, encrypted, expiresAt, env, insertOnly = false) {
await ensureSchema(env);
const now = Math.floor(Date.now() / 1000);
const insert = insertOnly ? 'INSERT OR IGNORE' : 'INSERT';
const conflict = insertOnly ? '' : ` ON CONFLICT(user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
key_version = 1, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`;
await env.DB.prepare(`${insert} INTO user_integrations
(user_id, provider, ciphertext, iv, key_version, metadata_json, created_at, updated_at)
VALUES (?, 'github', ?, ?, 1, ?, ?, ?)${conflict}`)
.bind(String(userId), encrypted.ciphertext, encrypted.iv, githubCredentialMetadata(expiresAt), now, now).run();
}

async function deleteGithubCredential(userId, env) {
await ensureSchema(env);
const now = Math.floor(Date.now() / 1000);
await env.DB.prepare(`INSERT INTO user_integrations
(user_id, provider, ciphertext, iv, key_version, metadata_json, created_at, updated_at)
VALUES (?, 'github', '', '', 1, ?, ?, ?)
ON CONFLICT(user_id, provider) DO UPDATE SET ciphertext = '', iv = '', key_version = 1,
metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
.bind(String(userId), githubCredentialMetadata(null, true), now, now).run();
await env.STATS.delete(ghTokenKey(userId));
}

function looksLikeGithubToken(text) {
const t = (text || '').trim();
return /^(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|gho_[A-Za-z0-9]{30,}|ghu_[A-Za-z0-9]{30,})$/.test(t);
}

async function getGithubToken(userId, env) {
if (!userId) return null;
const row = await readGithubCredentialRow(userId, env);
if (row) {
let metadata = {};
try { metadata = JSON.parse(row.metadata_json || '{}'); } catch {}
if (metadata.deleted) return null;
if (metadata.expiresAt && metadata.expiresAt <= Math.floor(Date.now() / 1000)) {
await deleteGithubCredential(userId, env);
return null;
}
try { return await decryptGithubToken(row.ciphertext, row.iv, userId, env); }
catch (error) {
logSafeError('github_credential_decrypt', error);
throw new Error('توکن GitHub قابل رمزگشایی نیست؛ کلید رمزگذاری Worker تغییر کرده یا تنظیم نشده است.');
}
}

// سازگاری عقب‌رو: توکن‌های قدیمی KV تا زمان فراهم‌شدن کلید قابل استفاده می‌مانند.
const legacy = await env.STATS.get(ghTokenKey(userId));
if (!legacy || !(env.CREDENTIALS_ENCRYPTION_KEY || env.CLOUDFLARE_ENCRYPTION_KEY)) return legacy;
const encrypted = await encryptGithubToken(legacy, userId, env);
const expiresAt = Math.floor(Date.now() / 1000) + GH_TOKEN_TTL_SECONDS;
// INSERT OR IGNORE و tombstone در D1 از بازنویسی credential جدید/قطع‌شده با مهاجرت هم‌زمان جلوگیری می‌کنند.
await writeGithubCredential(userId, encrypted, expiresAt, env, true);
const migrated = await readGithubCredentialRow(userId, env);
if (!migrated) return legacy;
let migratedMeta = {};
try { migratedMeta = JSON.parse(migrated.metadata_json || '{}'); } catch {}
if (migratedMeta.deleted) { await env.STATS.delete(ghTokenKey(userId)); return null; }
const result = await decryptGithubToken(migrated.ciphertext, migrated.iv, userId, env);
await env.STATS.delete(ghTokenKey(userId));
return result;
}

// ---------- اتصال Cloudflare: token فقط از فرم HTTPS دریافت و در D1 رمز می‌شود ----------
const CLOUDFLARE_CONNECT_TTL_SECONDS = 10 * 60;
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

function cfB64(bytes) {
let binary = '';
for (const b of bytes) binary += String.fromCharCode(b);
return btoa(binary);
}
function cfUnb64(value) {
const binary = atob(value);
return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function cfB64Url(bytes) { return cfB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function cfFromB64Url(value) { return cfUnb64(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)); }

async function cloudflareCryptoKey(env) {
if (!env.CLOUDFLARE_ENCRYPTION_KEY) throw new Error('اتصال Cloudflare هنوز آماده نیست؛ secret به نام CLOUDFLARE_ENCRYPTION_KEY در تنظیمات Worker تعریف نشده است.');
let raw;
try { raw = cfUnb64(String(env.CLOUDFLARE_ENCRYPTION_KEY).trim()); } catch { throw new Error('CLOUDFLARE_ENCRYPTION_KEY باید Base64 معتبرِ ۳۲ بایتی باشد.'); }
if (raw.length !== 32) throw new Error('CLOUDFLARE_ENCRYPTION_KEY باید Base64 معتبرِ ۳۲ بایتی باشد.');
return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function cloudflareAAD(userId) { return new TextEncoder().encode(`telegram-code-assistant:cloudflare:v1:${String(userId)}`); }
async function encryptCloudflareToken(token, userId, env) {
const key = await cloudflareCryptoKey(env);
const iv = crypto.getRandomValues(new Uint8Array(12));
const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: cloudflareAAD(userId) }, key, new TextEncoder().encode(token));
return { iv: cfB64(iv), ciphertext: cfB64(new Uint8Array(cipher)) };
}
async function decryptCloudflareToken(ciphertext, ivValue, userId, env) {
const key = await cloudflareCryptoKey(env);
const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: cfUnb64(ivValue), additionalData: cloudflareAAD(userId) }, key, cfUnb64(ciphertext));
return new TextDecoder().decode(raw);
}

async function cloudflareApiRequest(token, method, path, body) {
if (!path.startsWith('/') || path.startsWith('//')) throw new Error('مسیر Cloudflare API نامعتبر است.');
const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
method,
headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
body: body ? JSON.stringify(body) : undefined
});
const raw = await response.text();
let data;
try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
if (!response.ok || data.success === false) {
const detail = (data.errors || []).map(x => x.message || x.code).filter(Boolean).join('; ');
const error = new Error(`Cloudflare ${response.status}: ${detail || `درخواست ناموفق بود (HTTP ${response.status})`}`);
error.status = response.status;
throw error;
}
return data;
}

async function verifyCloudflareToken(token) {
const data = await cloudflareApiRequest(token, 'GET', '/user/tokens/verify');
if (data.result?.status !== 'active') throw new Error('این Cloudflare API Token فعال نیست.');
return { tokenId: String(data.result?.id || ''), expiresOn: data.result?.expires_on || null };
}

async function getCloudflareCredentialMeta(userId, env) {
await ensureSchema(env);
const row = await env.DB.prepare("SELECT metadata_json FROM user_integrations WHERE user_id = ? AND provider = 'cloudflare'").bind(String(userId)).first();
if (!row) return null;
try { return JSON.parse(row.metadata_json || '{}'); } catch { return {}; }
}

async function getCloudflareToken(userId, env) {
if (!userId) return null;
await ensureSchema(env);
const row = await env.DB.prepare("SELECT ciphertext, iv FROM user_integrations WHERE user_id = ? AND provider = 'cloudflare'").bind(String(userId)).first();
if (!row) return null;
try { return await decryptCloudflareToken(row.ciphertext, row.iv, userId, env); }
catch (error) { logSafeError('cloudflare_credential_decrypt', error); throw new Error('توکن Cloudflare قابل رمزگشایی نیست؛ کلید رمزگذاری Worker تغییر کرده یا تنظیم نشده است.'); }
}

async function storeCloudflareCredential(userId, encrypted, metadata, env) {
await ensureSchema(env);
const now = Math.floor(Date.now() / 1000);
await env.DB.prepare(`INSERT INTO user_integrations
(user_id, provider, ciphertext, iv, key_version, metadata_json, created_at, updated_at)
VALUES (?, 'cloudflare', ?, ?, 1, ?, ?, ?)
ON CONFLICT(user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
key_version = 1, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
.bind(String(userId), encrypted.ciphertext, encrypted.iv, JSON.stringify(metadata || {}), now, now).run();
}

async function deleteCloudflareCredential(userId, env) {
await ensureSchema(env);
await env.DB.prepare("DELETE FROM user_integrations WHERE user_id = ? AND provider = 'cloudflare'").bind(String(userId)).run();
}

function cloudflareHtmlPage(title, body, status = 200) {
const html = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;background:#101827;color:#e8edf5;margin:0;padding:24px}main{max-width:560px;margin:7vh auto;background:#1d293b;border:1px solid #34435b;border-radius:16px;padding:24px}h1{font-size:1.35rem}p{line-height:1.8;color:#cbd5e1}label{display:block;margin:20px 0 8px}input{box-sizing:border-box;width:100%;padding:14px;border-radius:10px;border:1px solid #52617a;background:#111b2b;color:#fff;font-size:16px}button{width:100%;padding:14px;border:0;border-radius:10px;background:#f48120;color:#111;font-weight:700;font-size:16px;margin-top:16px}.notice{font-size:14px;color:#fcd9ad}</style><main><h1>${escapeHtml(title)}</h1>${body}</main></html>`;
return new Response(html, { status, headers: {
'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache',
'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
} });
}

async function startCloudflareConnect(chatId, userId, env, publicOrigin) {
if (!env.CLOUDFLARE_ENCRYPTION_KEY) {
await sendMessage(chatId, 'اتصال Cloudflare هنوز آماده نیست. مدیر باید secret به نام CLOUDFLARE_ENCRYPTION_KEY را روی Worker تنظیم کند؛ مقدار آن را به ربات یا چت نفرست.', env);
return;
}
if (!publicOrigin || !/^https:\/\//i.test(publicOrigin)) {
await sendMessage(chatId, 'آدرس امن Worker در دسترس نیست؛ دوباره از چت خصوصی /cloudflare را بزن.', env);
return;
}
await ensureSchema(env);
const state = cfB64Url(crypto.getRandomValues(new Uint8Array(32)));
const stateHash = await textFingerprint(state);
const now = Math.floor(Date.now() / 1000);
await env.DB.prepare("DELETE FROM cloudflare_connect_sessions WHERE expires_at < ? OR status != 'pending'").bind(now - 86400).run();
await env.DB.prepare("UPDATE cloudflare_connect_sessions SET status = 'revoked' WHERE user_id = ? AND status = 'pending'").bind(String(userId)).run();
await env.DB.prepare(`INSERT INTO cloudflare_connect_sessions (state_hash, user_id, chat_id, status, expires_at, created_at)
VALUES (?, ?, ?, 'pending', ?, ?)`).bind(stateHash, String(userId), String(chatId), now + CLOUDFLARE_CONNECT_TTL_SECONDS, now).run();
const link = new URL('/connect/cloudflare', publicOrigin);
link.searchParams.set('state', state);
await sendMessage(chatId,
'برای امنیت، توکن را در تلگرام نفرست. لینک زیر ۱۰ دقیقه و فقط یک‌بار معتبر است؛ در صفحهٔ HTTPS توکن را وارد کن، بعد از برگشت به تلگرام اتصال را تأیید کن. یک API Token با دسترسی محدود بساز و رمز Global API Key را وارد نکن.',
env, { inline_keyboard: [[{ text: '🔐 اتصال امن Cloudflare', url: link.toString() }]] });
}

async function handleCloudflareConnectPage(request, env) {
if (!env.DB || !env.CLOUDFLARE_ENCRYPTION_KEY) return cloudflareHtmlPage('اتصال Cloudflare آماده نیست', '<p>پیکربندی امن اتصال روی Worker کامل نشده است.</p>', 503);
await ensureSchema(env);
if (request.method === 'GET') {
const state = new URL(request.url).searchParams.get('state') || '';
if (!/^[A-Za-z0-9_-]{40,60}$/.test(state)) return cloudflareHtmlPage('لینک نامعتبر', '<p>این لینک اتصال معتبر نیست؛ در چت خصوصی /cloudflare را دوباره بزن.</p>', 400);
const stateHash = await textFingerprint(state);
const row = await env.DB.prepare("SELECT status, expires_at FROM cloudflare_connect_sessions WHERE state_hash = ?").bind(stateHash).first();
if (!row || row.status !== 'pending' || row.expires_at <= Math.floor(Date.now() / 1000)) return cloudflareHtmlPage('لینک منقضی شده', '<p>این لینک منقضی یا استفاده شده است. در تلگرام /cloudflare را دوباره بزن.</p>', 410);
return cloudflareHtmlPage('اتصال امن Cloudflare', `<p>API Token محدود Cloudflare را وارد کن. این صفحه از HTTPS استفاده می‌کند؛ توکن در پیام تلگرام یا URL قرار نمی‌گیرد.</p><p class="notice">برای مشاهدهٔ Zoneها: <b>Zone: Zone Read</b>. برای خواندن DNS: <b>DNS: DNS Read</b>. برای تغییر DNS: <b>DNS: DNS Write</b>. برای فهرست Workerها: <b>Workers Scripts Read</b>. محدودهٔ دسترسی را فقط به Zone/Account لازم محدود کن.</p><form method="post" action="/connect/cloudflare"><input type="hidden" name="state" value="${escapeHtml(state)}"><label for="token">Cloudflare API Token</label><input id="token" name="token" type="password" autocomplete="off" minlength="20" maxlength="512" required><button type="submit">اعتبارسنجی توکن</button></form>`);
}

const contentLength = Number(request.headers.get('Content-Length') || 0);
if (contentLength > 4096) return cloudflareHtmlPage('درخواست نامعتبر', '<p>درخواست بیش از حد بزرگ است.</p>', 413);
const reader = request.body?.getReader();
const chunks = [];
let totalBytes = 0;
if (reader) {
while (true) {
const { value, done } = await reader.read();
if (done) break;
totalBytes += value.byteLength;
if (totalBytes > 4096) {
await reader.cancel();
return cloudflareHtmlPage('درخواست نامعتبر', '<p>درخواست بیش از حد بزرگ است.</p>', 413);
}
chunks.push(value);
}
}
const joined = new Uint8Array(totalBytes);
let offset = 0;
for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
const body = new TextDecoder().decode(joined);
const form = new URLSearchParams(body);
const state = form.get('state') || '';
const token = (form.get('token') || '').trim();
if (!/^[A-Za-z0-9_-]{40,60}$/.test(state) || token.length < 20 || token.length > 512 || /[\u0000-\u0020\u007f]/.test(token)) {
return cloudflareHtmlPage('ورودی نامعتبر', '<p>توکن یا لینک معتبر نیست؛ در تلگرام اتصال را دوباره شروع کن.</p>', 400);
}
const stateHash = await textFingerprint(state);
const now = Math.floor(Date.now() / 1000);
const session = await env.DB.prepare("SELECT user_id, chat_id, status, expires_at FROM cloudflare_connect_sessions WHERE state_hash = ?").bind(stateHash).first();
if (!session || session.status !== 'pending' || session.expires_at <= now || String(session.user_id) !== String(session.chat_id)) {
return cloudflareHtmlPage('لینک منقضی شده', '<p>لینک معتبر نیست یا منقضی شده. در چت خصوصی /cloudflare را دوباره بزن.</p>', 410);
}
const claimed = await env.DB.prepare(`UPDATE cloudflare_connect_sessions SET status = 'processing'
WHERE state_hash = ? AND status = 'pending' AND expires_at > ?`).bind(stateHash, now).run();
if (!claimed.meta?.changes) return cloudflareHtmlPage('لینک استفاده شده', '<p>این لینک قبلاً مصرف شده؛ در تلگرام اتصال را دوباره شروع کن.</p>', 409);
try {
const metadata = await verifyCloudflareToken(token);
const encrypted = await encryptCloudflareToken(token, session.user_id, env);
await requestActionConfirmation(session.chat_id, session.user_id, env, {
kind: 'cloudflare_connect', payload: { encrypted, metadata },
title: 'اتصال حساب Cloudflare',
details: `توکن Cloudflare اعتبارسنجی شد. شناسه: ${metadata.tokenId || 'نامشخص'}${metadata.expiresOn ? `\nانقضا: ${metadata.expiresOn}` : ''}\nاگر همین الان خودت این توکن را در صفحهٔ امن وارد کردی، تأیید کن؛ در غیر این صورت لغو کن.`
});
await env.DB.prepare("UPDATE cloudflare_connect_sessions SET status = 'awaiting_confirmation' WHERE state_hash = ? AND status = 'processing'").bind(stateHash).run();
return cloudflareHtmlPage('توکن اعتبارسنجی شد', '<p>توکن معتبر است. به گفت‌وگوی خصوصی تلگرام برگرد و دکمهٔ تأیید اتصال را بزن. توکن تا پایان این درخواست به‌صورت رمزگذاری‌شده نگه‌داری می‌شود.</p>');
} catch (error) {
await env.DB.prepare("UPDATE cloudflare_connect_sessions SET status = 'failed' WHERE state_hash = ? AND status = 'processing'").bind(stateHash).run();
logSafeError('cloudflare_connect', error);
return cloudflareHtmlPage('اتصال انجام نشد', `<p>${escapeHtml(userSafeErrorMessage(error, 'cloudflare'))}</p><p>توکن در چت تلگرام ارسال نشده است. در تلگرام اتصال را دوباره شروع کن.</p>`, 400);
}
}

async function deleteTelegramMessage(chatId, messageId, env) {
if (!messageId) return false;
try {
const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: chatId, message_id: messageId })
});
return r.ok;
} catch (e) { return false; }
}

async function saveGithubTokenFromChat(chatId, userId, token, env, messageId) {
// پیام حاوی توکن بلافاصله از چت پاک می‌شود
const deleted = await deleteTelegramMessage(chatId, messageId, env);
token = (token || '').trim();
if (!token || token.length < 20) {
await sendMessage(chatId, 'این توکن معتبر به نظر نمیاد. این‌جوری بفرست:\n/github ghp_xxxxxxxx', env);
return;
}
try {
// هرگز credential تازه را به‌صورت plaintext ذخیره نکن.
const encrypted = await encryptGithubToken(token, userId, env);
const info = await githubWhoAmI(token);
const expiresAt = Math.floor(Date.now() / 1000) + GH_TOKEN_TTL_SECONDS;
await writeGithubCredential(userId, encrypted, expiresAt, env);
await env.STATS.delete(ghTokenKey(userId));
let msg = `گیت‌هاب وصل شد، با حساب @${info.login}.`;
if (info.scopes) msg += `\nدسترسی‌ها: ${info.scopes}`;
if (info.scopes !== null && info.scopes !== undefined && info.scopes !== '' && !/\brepo\b|public_repo/.test(info.scopes)) {
msg += '\n⚠️ این توکن دسترسی repo نداره؛ برای ساخت مخزن و پوش، یه توکن با دسترسی repo بساز.';
}
msg += deleted ? '\nپیام توکن رو هم از چت پاک کردم.' : '\n⚠️ نتونستم پیام توکن رو پاک کنم؛ خودت پاکش کن.';
msg += '\nحالا هر وقت خواستی بگو چی رو کجا پوش کنم.';
await sendMessage(chatId, msg, env);
} catch (e) {
logSafeError('github_token_connect', e);
await sendMessage(chatId, `اتصال GitHub انجام نشد: ${userSafeErrorMessage(e, 'github')}\n${deleted ? 'پیام توکن رو از چت پاک کردم.' : ''}`, env);
}
}

async function sendGithubStatus(chatId, userId, env) {
const token = await getGithubToken(userId, env);
if (!token) {
await sendMessage(chatId, 'گیت‌هاب هنوز وصل نیست. توکن رو این‌جوری بفرست (پیامش خودکار پاک میشه):\n/github ghp_xxxxxxxx\n\nتوکن رو از github.com/settings/tokens بساز؛ برای Classic دسترسی repo، برای Fine-grained دسترسی Contents و Administration (Read & write) لازمه.', env);
return;
}
try {
const info = await githubWhoAmI(token);
await sendMessage(chatId, `گیت‌هاب وصله: @${info.login}${info.scopes ? `\nدسترسی‌ها: ${info.scopes}` : ''}\nبرای قطع: /github_off`, env);
} catch (e) {
logSafeError('github_status', e);
await sendMessage(chatId, `وضعیت اتصال GitHub قابل بررسی نیست: ${userSafeErrorMessage(e, 'github')}\nاگر توکن منقضی شده، با /github <توکن> دوباره وصل کن.`, env);
}
}

// ---------- فراخوانی API گیت‌هاب ----------
async function ghRequest(token, method, path, body) {
const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
method,
headers: {
'Authorization': `Bearer ${token}`,
'Accept': 'application/vnd.github+json',
'X-GitHub-Api-Version': '2022-11-28',
'User-Agent': 'telegram-code-assistant-bot',
...(body ? { 'Content-Type': 'application/json' } : {})
},
body: body ? JSON.stringify(body) : undefined
});
const raw = await res.text();
let data;
try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = { message: raw.substring(0, 300) }; }
if (!res.ok) {
let msg = data.message || `HTTP ${res.status}`;
if (Array.isArray(data.errors) && data.errors.length) {
msg += ' — ' + data.errors.map(x => x.message || x.code || JSON.stringify(x)).join('; ');
}
const err = new Error(`GitHub ${res.status}: ${msg}`);
err.status = res.status;
throw err;
}
return { data, headers: res.headers };
}

async function githubWhoAmI(token) {
const { data, headers } = await ghRequest(token, 'GET', '/user');
return { login: data.login, name: data.name, scopes: headers.get('x-oauth-scopes'), html_url: data.html_url };
}

// «name» یا «owner/name» → owner/name
async function resolveRepo(token, repo, ctx) {
repo = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
if (!repo) throw new Error('اسم مخزن مشخص نشده');
if (repo.includes('/')) return repo;
if (!ctx.login) ctx.login = (await githubWhoAmI(token)).login;
return `${ctx.login}/${repo}`;
}

function encodePath(p) {
return String(p).split('/').map(encodeURIComponent).join('/');
}

function cleanRepoPath(p) {
return String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/{2,}/g, '/');
}

function utf8ToBase64(str) {
return arrayBufferToBase64(new TextEncoder().encode(str).buffer);
}

function base64ToBytes(b64) {
const bin = atob(String(b64).replace(/\s/g, ''));
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
return bytes;
}

function base64ToUtf8(b64) {
return new TextDecoder().decode(base64ToBytes(b64));
}

// پوش چند فایل در یک کامیت (Git Data API) — مخزن خالی و برنچ جدید هم پشتیبانی می‌شود
async function githubPushFiles(token, fullRepo, { branch, message, files, deletePaths = [], baseBranch }) {
const { data: repoInfo } = await ghRequest(token, 'GET', `/repos/${fullRepo}`);
const defaultBranch = repoInfo.default_branch || 'main';
branch = branch || defaultBranch;
files = (files || []).map(f => ({ ...f, path: cleanRepoPath(f.path) })).filter(f => f.path);
deletePaths = (deletePaths || []).map(cleanRepoPath).filter(Boolean);
if (!files.length && !deletePaths.length) throw new Error('هیچ فایلی برای پوش نیست');

// پیدا کردن آخرین کامیت برنچ
let headSha = null;
let repoEmpty = false;
try {
const { data } = await ghRequest(token, 'GET', `/repos/${fullRepo}/git/ref/heads/${encodePath(branch)}`);
headSha = data.object.sha;
} catch (e) {
if (e.status === 409) {
repoEmpty = true; // مخزن کاملاً خالی است
} else if (e.status === 404) {
// برنچ وجود ندارد → از برنچ پایه ساخته می‌شود
const from = baseBranch || defaultBranch;
try {
const { data } = await ghRequest(token, 'GET', `/repos/${fullRepo}/git/ref/heads/${encodePath(from)}`);
await ghRequest(token, 'POST', `/repos/${fullRepo}/git/refs`, { ref: `refs/heads/${branch}`, sha: data.object.sha });
headSha = data.object.sha;
} catch (e2) {
if (e2.status === 409 || e2.status === 404) repoEmpty = true;
else throw e2;
}
} else {
throw e;
}
}

// مخزن خالی: اولین فایل با Contents API ساخته می‌شود تا کامیت اولیه ایجاد شود
let bootstrapped = null;
if (repoEmpty) {
const first = files.find(f => f.text !== undefined) || files[0];
if (!first) throw new Error('مخزن خالی است و فایلی برای ساخت کامیت اولیه وجود ندارد');
const content = first.text !== undefined ? utf8ToBase64(first.text) : first.b64;
const { data } = await ghRequest(token, 'PUT', `/repos/${fullRepo}/contents/${encodePath(first.path)}`, {
message, content, branch
});
headSha = data.commit.sha;
bootstrapped = first.path;
files = files.filter(f => f !== first);
if (!files.length && !deletePaths.length) {
return {
ok: true, repo: fullRepo, branch, commit_sha: headSha,
commit_url: data.commit.html_url || `https://github.com/${fullRepo}/commit/${headSha}`,
files_pushed: 1, repo_url: `https://github.com/${fullRepo}`
};
}
}

const { data: headCommit } = await ghRequest(token, 'GET', `/repos/${fullRepo}/git/commits/${headSha}`);
let baseTree = headCommit.tree.sha;

// ساخت درخت (Tree) — فایل‌های متنی inline، باینری‌ها به‌صورت blob؛ در بخش‌های چندمگابایتی
const entries = [];
let binaryCount = 0;
for (const f of files) {
if (f.text !== undefined) {
entries.push({ path: f.path, mode: f.mode || '100644', type: 'blob', content: f.text });
} else if (f.b64 !== undefined) {
binaryCount++;
if (binaryCount > 300) throw new Error('تعداد فایل‌های باینری بیش از حد است (حداکثر ۳۰۰)');
const { data: blob } = await ghRequest(token, 'POST', `/repos/${fullRepo}/git/blobs`, { content: f.b64, encoding: 'base64' });
entries.push({ path: f.path, mode: f.mode || '100644', type: 'blob', sha: blob.sha });
}
}
for (const p of deletePaths) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });

const CHUNK_CHARS = 4 * 1024 * 1024;
let chunk = [], chunkChars = 0;
const flush = async () => {
if (!chunk.length) return;
const { data: tree } = await ghRequest(token, 'POST', `/repos/${fullRepo}/git/trees`, { base_tree: baseTree, tree: chunk });
baseTree = tree.sha;
chunk = []; chunkChars = 0;
};
for (const e of entries) {
const size = (e.content ? e.content.length : 0) + e.path.length + 100;
if (chunkChars + size > CHUNK_CHARS && chunk.length) await flush();
chunk.push(e); chunkChars += size;
}
await flush();

if (baseTree === headCommit.tree.sha) {
return { ok: true, repo: fullRepo, branch, note: 'هیچ تغییری نسبت به نسخه فعلی نبود؛ کامیتی ساخته نشد.', commit_sha: headSha };
}

const { data: commit } = await ghRequest(token, 'POST', `/repos/${fullRepo}/git/commits`, {
message, tree: baseTree, parents: [headSha]
});
await ghRequest(token, 'PATCH', `/repos/${fullRepo}/git/refs/heads/${encodePath(branch)}`, { sha: commit.sha, force: false });

return {
ok: true,
repo: fullRepo,
branch,
commit_sha: commit.sha,
commit_url: `https://github.com/${fullRepo}/commit/${commit.sha}`,
repo_url: `https://github.com/${fullRepo}/tree/${encodeURIComponent(branch)}`,
files_pushed: files.length + (bootstrapped ? 1 : 0),
files_deleted: deletePaths.length,
note: bootstrapped ? `مخزن خالی بود؛ «${bootstrapped}» کامیت اولیه را ساخت و بقیه در کامیت دوم پوش شد.` : undefined
};
}

// ---------- فضای کار (Workspace): فایل‌های ارسالی کاربر برای ویرایش و پوش ----------
function wsKey(chatId, projectId = null) { return projectId ? `ws:${chatId}:project:${projectId}` : `ws:${chatId}`; }

async function getWorkspace(chatId, env) {
const project = await getActiveProject(chatId, env);
const raw = await env.STATS.get(wsKey(chatId, project?.id || null));
if (!raw) return { name: '', files: [] };
try { return JSON.parse(raw); } catch (e) { return { name: '', files: [] }; }
}

async function putWorkspace(chatId, ws, env) {
const total = ws.files.reduce((a, f) => a + (f.size || 0), 0);
if (total > WS_MAX_TOTAL_BYTES) throw new Error(`حجم فضای کار بیش از ${formatSizeClient(WS_MAX_TOTAL_BYTES)} است`);
ws.updated_at = new Date().toISOString();
// فضای کار ۷ روز نگه داشته می‌شود
const project = await getActiveProject(chatId, env);
await env.STATS.put(wsKey(chatId, project?.id || null), JSON.stringify(ws), { expirationTtl: 7 * 24 * 3600 });
}

function bytesToWsFile(path, bytes) {
let text;
try {
text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
if (text.includes('\u0000')) text = undefined;
} catch (e) { text = undefined; }
return text !== undefined
? { path, size: bytes.byteLength, text }
: { path, size: bytes.byteLength, b64: arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
}

async function saveZipToWorkspace(chatId, buffer, fileName, env) {
const all = await extractZip(buffer, { all: true });
const realFiles = all.filter(f => !f.name.endsWith('/'));
const root = realFiles.length && realFiles.every(f => f.name.includes('/') && f.name.split('/')[0] === realFiles[0].name.split('/')[0])
? realFiles[0].name.split('/')[0] + '/' : '';
const files = [];
let skipped = 0, bytes = 0;
for (const f of realFiles) {
if (!f.content) { skipped++; continue; }
const path = cleanRepoPath(root && f.name.startsWith(root) ? f.name.slice(root.length) : f.name);
if (!path) continue;
files.push(bytesToWsFile(path, f.content));
bytes += f.content.byteLength;
}
await putWorkspace(chatId, { name: fileName.replace(/\.zip$/i, ''), files }, env);
return { count: files.length, skipped, bytes };
}

async function addFilesToWorkspace(chatId, newFiles, env, name) {
const ws = await getWorkspace(chatId, env);
if (name) ws.name = name;
for (const nf of newFiles) {
nf.path = cleanRepoPath(nf.path);
const i = ws.files.findIndex(f => f.path === nf.path);
if (i >= 0) ws.files[i] = nf; else ws.files.push(nf);
}
await putWorkspace(chatId, ws, env);
return ws;
}

// ---------- تعریف ابزارها برای مدل ----------
const AGENT_TOOLS = [
{ type: 'function', function: {
name: 'github_whoami',
description: 'نام کاربری گیت‌هاب متصل و دسترسی‌های توکن را برمی‌گرداند. برای بررسی اتصال استفاده کن.',
parameters: { type: 'object', properties: {} } } },
{ type: 'function', function: {
name: 'github_list_repos',
description: 'فهرست مخزن‌های کاربر (به ترتیب آخرین به‌روزرسانی). با query می‌شود بر اساس اسم فیلتر کرد.',
parameters: { type: 'object', properties: { query: { type: 'string', description: 'بخشی از اسم مخزن (اختیاری)' } } } } },
{ type: 'function', function: {
name: 'github_get_repo',
description: 'اطلاعات یک مخزن: وجود دارد یا نه، خصوصی/عمومی، برنچ پیش‌فرض، خالی بودن، فهرست برنچ‌ها.',
parameters: { type: 'object', properties: { repo: { type: 'string', description: 'name یا owner/name' } }, required: ['repo'] } } },
{ type: 'function', function: {
name: 'github_create_repo',
description: 'ساخت مخزن جدید. پیش‌فرض خصوصی. اگر org داده شود در آن سازمان ساخته می‌شود.',
parameters: { type: 'object', properties: {
name: { type: 'string' },
private: { type: 'boolean', description: 'پیش‌فرض true' },
description: { type: 'string' },
org: { type: 'string', description: 'نام سازمان (اختیاری)' }
}, required: ['name'] } } },
{ type: 'function', function: {
name: 'github_list_files',
description: 'فهرست کامل فایل‌های یک مخزن در یک برنچ (درخت بازگشتی).',
parameters: { type: 'object', properties: {
repo: { type: 'string' }, branch: { type: 'string', description: 'پیش‌فرض: برنچ پیش‌فرض مخزن' },
path_prefix: { type: 'string', description: 'فقط فایل‌های زیر این مسیر (اختیاری)' }
}, required: ['repo'] } } },
{ type: 'function', function: {
name: 'github_read_file',
description: 'خواندن محتوای یک فایل از مخزن.',
parameters: { type: 'object', properties: {
repo: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' }
}, required: ['repo', 'path'] } } },
{ type: 'function', function: {
name: 'github_push',
description: 'ساخت یک کامیت و پوش آن به یک برنچ. می‌تواند فایل‌های فضای کار (from_workspace) و/یا فایل‌های مشخص (files) را بفرستد و فایل‌هایی را حذف کند. اگر برنچ وجود نداشته باشد از base_branch ساخته می‌شود. مخزن خالی هم پشتیبانی می‌شود. مخزن باید از قبل وجود داشته باشد.',
parameters: { type: 'object', properties: {
repo: { type: 'string' },
message: { type: 'string', description: 'پیام کامیت' },
branch: { type: 'string', description: 'پیش‌فرض: برنچ پیش‌فرض مخزن' },
base_branch: { type: 'string', description: 'اگر branch وجود ندارد، از این ساخته شود' },
from_workspace: { type: 'boolean', description: 'همه فایل‌های فضای کار پوش شوند' },
workspace_paths: { type: 'array', items: { type: 'string' }, description: 'فقط این فایل‌های فضای کار (اختیاری)' },
target_dir: { type: 'string', description: 'فایل‌های فضای کار داخل این پوشه مخزن قرار بگیرند (اختیاری)' },
files: { type: 'array', description: 'فایل‌هایی که مستقیم نوشته/جایگزین می‌شوند', items: { type: 'object', properties: {
path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
delete_paths: { type: 'array', items: { type: 'string' }, description: 'مسیر فایل‌هایی که حذف شوند' }
}, required: ['repo', 'message'] } } },
{ type: 'function', function: {
name: 'github_create_branch',
description: 'ساخت برنچ جدید از یک برنچ دیگر.',
parameters: { type: 'object', properties: {
repo: { type: 'string' }, branch: { type: 'string' }, from: { type: 'string', description: 'پیش‌فرض: برنچ پیش‌فرض' }
}, required: ['repo', 'branch'] } } },
{ type: 'function', function: {
name: 'github_create_pull_request',
description: 'ساخت Pull Request.',
parameters: { type: 'object', properties: {
repo: { type: 'string' }, head: { type: 'string', description: 'برنچ تغییرات' },
base: { type: 'string', description: 'پیش‌فرض: برنچ پیش‌فرض' }, title: { type: 'string' }, body: { type: 'string' }
}, required: ['repo', 'head', 'title'] } } },
{ type: 'function', function: {
name: 'cloudflare_list_zones',
description: 'فهرست Zoneهای Cloudflare که توکن دسترسی دارد؛ می‌تواند با نام دامنه فیلتر کند.',
parameters: { type: 'object', properties: { name: { type: 'string' } } } } },
{ type: 'function', function: {
name: 'cloudflare_list_dns_records',
description: 'فهرست DNS recordهای یک zone. zone_id را از cloudflare_list_zones بردار.',
parameters: { type: 'object', properties: { zone_id: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' } }, required: ['zone_id'] } } },
{ type: 'function', function: {
name: 'cloudflare_create_dns_record',
description: 'ایجاد یک DNS record پس از preview و تأیید صریح کاربر. فقط A, AAAA, CNAME, TXT و MX پشتیبانی می‌شود.',
parameters: { type: 'object', properties: {
zone_id: { type: 'string' }, type: { type: 'string', enum: ['A', 'AAAA', 'CNAME', 'TXT', 'MX'] },
name: { type: 'string' }, content: { type: 'string' }, ttl: { type: 'integer' }, proxied: { type: 'boolean' }, priority: { type: 'integer' }
}, required: ['zone_id', 'type', 'name', 'content'] } } },
{ type: 'function', function: {
name: 'cloudflare_update_dns_record',
description: 'تغییر محتوا، TTL یا حالت proxied یک DNS record مشخص. تغییر فقط پس از نمایش مقدار فعلی/جدید و تأیید انجام می‌شود.',
parameters: { type: 'object', properties: { zone_id: { type: 'string' }, record_id: { type: 'string' }, content: { type: 'string' }, ttl: { type: 'integer' }, proxied: { type: 'boolean' } }, required: ['zone_id', 'record_id'] } } },
{ type: 'function', function: {
name: 'cloudflare_delete_dns_record',
description: 'حذف دائمی DNS record مشخص. مقدار فعلی در preview نشان داده می‌شود و اجرا نیازمند تأیید است.',
parameters: { type: 'object', properties: { zone_id: { type: 'string' }, record_id: { type: 'string' } }, required: ['zone_id', 'record_id'] } } },
{ type: 'function', function: {
name: 'cloudflare_list_workers',
description: 'فهرست Worker scriptها در Cloudflare account مشخص؛ account_id را از داشبورد کاربر بگیر.',
parameters: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] } } },
{ type: 'function', function: {
name: 'cloudflare_get_worker',
description: 'خواندن تنظیمات observability/logpush یک Worker، بدون دریافت source code یا secret values.',
parameters: { type: 'object', properties: { account_id: { type: 'string' }, script_name: { type: 'string' } }, required: ['account_id', 'script_name'] } } },
{ type: 'function', function: {
name: 'workspace_list_files',
description: 'فهرست فایل‌های فضای کار (فایل‌ها/ZIPهایی که کاربر در چت فرستاده).',
parameters: { type: 'object', properties: {} } } },
{ type: 'function', function: {
name: 'workspace_read_file',
description: 'خواندن یک فایل متنی از فضای کار.',
parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
{ type: 'function', function: {
name: 'workspace_write_file',
description: 'ساخت یا بازنویسی کامل یک فایل متنی در فضای کار (مثلاً اصلاح باگ، ساخت README یا .gitignore قبل از پوش).',
parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
{ type: 'function', function: {
name: 'workspace_edit_file',
description: 'ویرایش بخشی از یک فایل متنی فضای کار با جایگزینی دقیق متن (old_text باید دقیقاً و فقط یک بار در فایل باشد).',
parameters: { type: 'object', properties: {
path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }
}, required: ['path', 'old_text', 'new_text'] } } },
{ type: 'function', function: {
name: 'workspace_delete_file',
description: 'حذف یک فایل از فضای کار.',
parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
{ type: 'function', function: {
name: 'web_search',
description: 'جستجوی ساده وب (DuckDuckGo) برای اطلاعات عمومی.',
parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }
];

// متن کوتاه پیشرفت کار برای هر ابزار
function toolLabel(name, a) {
switch (name) {
case 'github_whoami': return 'بررسی اتصال گیت‌هاب';
case 'github_list_repos': return 'گرفتن فهرست مخزن‌ها';
case 'github_get_repo': return `بررسی مخزن ${a.repo || ''}`;
case 'github_create_repo': return `ساخت مخزن ${a.name || ''} (${a.private === false ? 'عمومی' : 'خصوصی'})`;
case 'github_list_files': return `دیدن فایل‌های ${a.repo || ''}`;
case 'github_read_file': return `خواندن ${a.path || ''}`;
case 'github_push': return `کامیت و پوش به ${a.repo || ''}${a.branch ? ` (${a.branch})` : ''}`;
case 'github_create_branch': return `ساخت برنچ ${a.branch || ''}`;
case 'github_create_pull_request': return `ساخت Pull Request`;
case 'cloudflare_list_zones': return 'فهرست Zoneهای Cloudflare';
case 'cloudflare_list_dns_records': return 'فهرست رکوردهای DNS';
case 'cloudflare_create_dns_record': return `ساخت رکورد DNS ${a.type || ''} ${a.name || ''}`;
case 'cloudflare_update_dns_record': return `ویرایش رکورد DNS ${a.record_id || ''}`;
case 'cloudflare_delete_dns_record': return `حذف رکورد DNS ${a.record_id || ''}`;
case 'cloudflare_list_workers': return `فهرست Workerهای اکانت ${a.account_id || ''}`;
case 'cloudflare_get_worker': return `بررسی Worker ${a.script_name || ''}`;
case 'workspace_list_files': return 'دیدن فایل‌های فضای کار';
case 'workspace_read_file': return `خواندن ${a.path || ''}`;
case 'workspace_write_file': return `نوشتن ${a.path || ''}`;
case 'workspace_edit_file': return `ویرایش ${a.path || ''}`;
case 'workspace_delete_file': return `حذف ${a.path || ''} از فضای کار`;
case 'web_search': return `جستجو: ${a.query || ''}`;
default: return name;
}
}

async function buildAgentActionDetails(name, args, chatId, env) {
const lines = [];
if (name === 'cloudflare_create_dns_record') {
lines.push(`Zone ID: ${args.zone_id || 'نامشخص'}`);
lines.push(`عملیات: ایجاد ${args.type || 'نوع نامشخص'} — ${args.name || 'نامشخص'} → ${args.content || 'نامشخص'}`);
lines.push(`TTL: ${args.ttl || 1} ثانیه (۱ یعنی خودکار) | Proxied: ${args.proxied === true ? 'بله' : 'خیر'}`);
} else if (name === 'cloudflare_update_dns_record' || name === 'cloudflare_delete_dns_record') {
lines.push(`Zone ID: ${args.zone_id || 'نامشخص'} | Record ID: ${args.record_id || 'نامشخص'}`);
lines.push(name === 'cloudflare_delete_dns_record' ? 'عملیات: حذف دائمی رکورد DNS' : `عملیات: تغییر ${JSON.stringify({ content: args.content, ttl: args.ttl, proxied: args.proxied })}`);
} else if (name === 'github_create_repo') {
lines.push(`مخزن: ${args.org ? `${args.org}/` : ''}${args.name || 'نامشخص'}`);
lines.push(`دسترسی: ${args.private === false ? 'عمومی' : 'خصوصی'}`);
if (args.description) lines.push(`توضیح: ${String(args.description).substring(0, 300)}`);
} else if (name === 'github_push') {
lines.push(`مخزن: ${args.repo || 'نامشخص'} | شاخه: ${args.branch || 'شاخهٔ پیش‌فرض'}`);
lines.push(`پیام کامیت: ${args.message || 'Update files'}`);
const paths = (args.files || []).map(f => cleanRepoPath(f.path)).filter(Boolean);
if (args.from_workspace || args.workspace_paths?.length) {
const ws = await getWorkspace(chatId, env);
const selected = args.workspace_paths?.length
? ws.files.filter(f => args.workspace_paths.some(p => cleanRepoPath(p) === cleanRepoPath(f.path)))
: ws.files;
const dir = cleanRepoPath(args.target_dir || '').replace(/\/$/, '');
for (const f of selected) paths.push(dir ? `${dir}/${cleanRepoPath(f.path)}` : cleanRepoPath(f.path));
}
const uniquePaths = [...new Set(paths)];
lines.push(`فایل‌های افزوده/به‌روزشده: ${uniquePaths.length}${uniquePaths.length ? `\n${uniquePaths.slice(0, 15).map(p => `• ${p}`).join('\n')}` : ''}${uniquePaths.length > 15 ? `\n… و ${uniquePaths.length - 15} فایل دیگر` : ''}`);
const deletes = (args.delete_paths || []).map(cleanRepoPath).filter(Boolean);
if (deletes.length) lines.push(`⚠️ فایل‌های حذف‌شونده: ${deletes.slice(0, 15).join(', ')}${deletes.length > 15 ? ` و ${deletes.length - 15} مورد دیگر` : ''}`);
} else if (name === 'github_create_branch') {
lines.push(`مخزن: ${args.repo || 'نامشخص'} | شاخهٔ جدید: ${args.branch || 'نامشخص'} | مبنا: ${args.from || 'شاخهٔ پیش‌فرض'}`);
} else if (name === 'github_create_pull_request') {
lines.push(`مخزن: ${args.repo || 'نامشخص'} | ${args.head || 'head نامشخص'} → ${args.base || 'base پیش‌فرض'}`);
lines.push(`عنوان: ${args.title || 'بدون عنوان'}`);
} else if (name === 'workspace_write_file') {
lines.push(`فایل: ${cleanRepoPath(args.path)} | ${new TextEncoder().encode(String(args.content ?? '')).length} بایت`);
lines.push('اگر فایل هم‌نام وجود داشته باشد، محتوایش جایگزین می‌شود.');
} else if (name === 'workspace_edit_file') {
lines.push(`فایل: ${cleanRepoPath(args.path)} | جایگزینی ${String(args.old_text || '').length} نویسه با ${String(args.new_text || '').length} نویسه`);
} else if (name === 'workspace_delete_file') {
lines.push(`فایل برای حذف: ${cleanRepoPath(args.path)}`);
} else {
const safeKeys = ['repo', 'branch', 'base', 'head', 'org', 'name', 'path', 'target', 'worker', 'zone', 'account_id', 'environment', 'private'];
const safe = Object.fromEntries(safeKeys.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
lines.push(`ابزار: ${name}${Object.keys(safe).length ? `\nهدف: ${JSON.stringify(safe)}` : ''}`);
}
return lines.join('\n');
}

function cloudflareSafeRecord(record) {
return { id: record.id, type: record.type, name: record.name, content: record.content, ttl: record.ttl, proxied: !!record.proxied, priority: record.priority ?? null };
}

async function prepareCloudflareActionPreview(name, args, token) {
if (name === 'cloudflare_create_dns_record') {
validateCloudflareId(args.zone_id, 'zone_id');
const type = String(args.type || '').toUpperCase();
if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX'].includes(type)) throw new Error('نوع رکورد باید یکی از A، AAAA، CNAME، TXT یا MX باشد.');
if (!String(args.name || '').trim() || String(args.name).length > 253 || !String(args.content ?? '') || String(args.content).length > 2048) throw new Error('نام یا محتوای DNS معتبر نیست.');
const ttl = args.ttl === undefined ? 1 : Number(args.ttl);
if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) throw new Error('TTL باید ۱ (خودکار) یا بین ۶۰ تا ۸۶۴۰۰ باشد.');
if (args.proxied === true && !['A', 'AAAA', 'CNAME'].includes(type)) throw new Error('Proxied فقط برای A، AAAA و CNAME قابل استفاده است.');
return { details: await buildCloudflareCreateDetails(args), recordFingerprint: null };
}
if (!['cloudflare_update_dns_record', 'cloudflare_delete_dns_record'].includes(name)) return { details: '', recordFingerprint: null };
const zoneId = validateCloudflareId(args.zone_id, 'zone_id');
const recordId = validateCloudflareId(args.record_id, 'record_id');
const data = await cloudflareApiRequest(token, 'GET', `/zones/${zoneId}/dns_records/${recordId}`);
const record = cloudflareSafeRecord(data.result || {});
if (!record.id) throw new Error('رکورد DNS موردنظر پیدا نشد.');
if (name === 'cloudflare_update_dns_record') {
if (args.content !== undefined && (!String(args.content) || String(args.content).length > 2048)) throw new Error('محتوای جدید DNS خالی یا بیش از حد بزرگ است.');
if (args.ttl !== undefined) { const ttl = Number(args.ttl); if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) throw new Error('TTL باید ۱ یا بین ۶۰ تا ۸۶۴۰۰ باشد.'); }
if (args.proxied !== undefined && typeof args.proxied !== 'boolean') throw new Error('proxied باید true یا false باشد.');
if (args.proxied === true && !['A', 'AAAA', 'CNAME'].includes(record.type)) throw new Error(`رکورد ${record.type} را نمی‌توان proxied کرد.`);
if (args.content === undefined && args.ttl === undefined && args.proxied === undefined) throw new Error('حداقل یکی از content، ttl یا proxied را مشخص کن.');
}
const details = name === 'cloudflare_delete_dns_record'
? `Zone ID: ${zoneId}\nرکوردی که حذف می‌شود: ${record.type} ${record.name} → ${record.content}\nTTL: ${record.ttl} | Proxied: ${record.proxied}\nاین حذف دائمی است.`
: `Zone ID: ${zoneId}\nرکورد فعلی: ${record.type} ${record.name} → ${record.content}\nمقدار درخواستی: ${args.content ?? record.content}\nTTL: ${args.ttl ?? record.ttl} | Proxied: ${args.proxied ?? record.proxied}`;
return { details, recordFingerprint: await textFingerprint(JSON.stringify(record)) };
}

async function buildCloudflareCreateDetails(args) {
return `Zone ID: ${args.zone_id}\nایجاد ${args.type} ${args.name} → ${args.content}\nTTL: ${args.ttl ?? 1} (۱=خودکار) | Proxied: ${args.proxied === true ? 'بله' : 'خیر'}${args.type === 'MX' ? ` | Priority: ${args.priority ?? 10}` : ''}`;
}

function validateCloudflareId(value, label = 'ID') {
const id = String(value || '');
if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error(`${label} باید یک شناسهٔ ۳۲ کاراکتری هگزادسیمال Cloudflare باشد.`);
return id;
}

// ---------- اجرای ابزارها ----------
async function executeTool(name, args, ctx) {
const { env, chatId, userId } = ctx;
const needCloudflareToken = async () => {
if (String(chatId) !== String(userId)) throw new Error('برای حفظ حریم خصوصی، ابزارهای Cloudflare فقط در گفت‌وگوی خصوصی قابل استفاده‌اند.');
if (ctx.cloudflareToken === undefined) ctx.cloudflareToken = await getCloudflareToken(userId, env);
if (!ctx.cloudflareToken) throw new Error('Cloudflare وصل نیست. در گفت‌وگوی خصوصی /cloudflare را بزن و اتصال امن را کامل کن.');
return ctx.cloudflareToken;
};
const needToken = async () => {
if (ctx.token === undefined) ctx.token = await getGithubToken(userId, env);
if (!ctx.token) {
const e = new Error('گیت‌هاب وصل نیست. به کاربر بگو توکن را با دستور /github <توکن> بفرستد (پیامش خودکار پاک می‌شود).');
e.noRetry = true;
throw e;
}
return ctx.token;
};

switch (name) {
case 'github_whoami': {
const t = await needToken();
return await githubWhoAmI(t);
}
case 'github_list_repos': {
const t = await needToken();
const { data } = await ghRequest(t, 'GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
const q = (args.query || '').toLowerCase();
return data
.filter(r => !q || r.full_name.toLowerCase().includes(q))
.slice(0, 60)
.map(r => ({ full_name: r.full_name, private: r.private, default_branch: r.default_branch, updated_at: r.updated_at, empty: r.size === 0 }));
}
case 'github_get_repo': {
const t = await needToken();
const full = await resolveRepo(t, args.repo, ctx);
try {
const { data } = await ghRequest(t, 'GET', `/repos/${full}`);
let branches = [];
try {
const b = await ghRequest(t, 'GET', `/repos/${full}/branches?per_page=50`);
branches = b.data.map(x => x.name);
} catch (e) { /* مخزن خالی */ }
return {
exists: true, full_name: data.full_name, private: data.private, default_branch: data.default_branch,
empty: branches.length === 0, branches, html_url: data.html_url,
can_push: data.permissions ? !!data.permissions.push : undefined
};
} catch (e) {
if (e.status === 404) return { exists: false, full_name: full, note: 'مخزن وجود ندارد یا توکن به آن دسترسی ندارد' };
throw e;
}
}
case 'github_create_repo': {
const t = await needToken();
const body = { name: args.name, private: args.private !== false, description: args.description || undefined, auto_init: false };
const path = args.org ? `/orgs/${encodeURIComponent(args.org)}/repos` : '/user/repos';
const { data } = await ghRequest(t, 'POST', path, body);
return { ok: true, full_name: data.full_name, private: data.private, html_url: data.html_url, default_branch: data.default_branch || 'main' };
}
case 'github_list_files': {
const t = await needToken();
const full = await resolveRepo(t, args.repo, ctx);
let branch = args.branch;
if (!branch) branch = (await ghRequest(t, 'GET', `/repos/${full}`)).data.default_branch;
try {
const { data } = await ghRequest(t, 'GET', `/repos/${full}/git/trees/${encodePath(branch)}?recursive=1`);
const prefix = cleanRepoPath(args.path_prefix || '');
const files = data.tree.filter(x => x.type === 'blob' && (!prefix || x.path.startsWith(prefix)));
return { repo: full, branch, total_files: files.length, truncated: !!data.truncated, files: files.slice(0, 400).map(x => x.path) };
} catch (e) {
if (e.status === 409) return { repo: full, branch, total_files: 0, note: 'مخزن خالی است' };
throw e;
}
}
case 'github_read_file': {
const t = await needToken();
const full = await resolveRepo(t, args.repo, ctx);
const ref = args.branch ? `?ref=${encodeURIComponent(args.branch)}` : '';
const { data } = await ghRequest(t, 'GET', `/repos/${full}/contents/${encodePath(cleanRepoPath(args.path))}${ref}`);
if (Array.isArray(data)) return { is_directory: true, entries: data.map(x => `${x.type}: ${x.path}`) };
let content = data.encoding === 'base64' ? base64ToUtf8(data.content) : (data.content || '');
if (!content && data.download_url) content = await (await fetch(data.download_url)).text();
return { path: data.path, size: data.size, content };
}
case 'github_push': {
const t = await needToken();
const full = await resolveRepo(t, args.repo, ctx);
let files = [];
if (args.from_workspace || (args.workspace_paths && args.workspace_paths.length)) {
const ws = await getWorkspace(chatId, env);
let wsFiles = ws.files;
if (args.workspace_paths && args.workspace_paths.length) {
const want = new Set(args.workspace_paths.map(cleanRepoPath));
wsFiles = wsFiles.filter(f => want.has(f.path));
}
if (!wsFiles.length) throw new Error('فضای کار خالی است یا فایل‌های خواسته‌شده در آن نیست');
const dir = cleanRepoPath(args.target_dir || '').replace(/\/$/, '');
files = wsFiles
.filter(f => !ZIP_SECRET_FILES.test(f.path))
.map(f => ({ path: dir ? `${dir}/${f.path}` : f.path, text: f.text, b64: f.b64 }));
}
for (const f of (args.files || [])) {
const p = cleanRepoPath(f.path);
files = files.filter(x => x.path !== p);
files.push({ path: p, text: String(f.content ?? '') });
}
return await githubPushFiles(t, full, {
branch: args.branch, baseBranch: args.base_branch, message: args.message || 'Update files',
files, deletePaths: args.delete_paths || []
});
}
case 'github_create_branch': {
const t = await needToken();
const full = await resolveRepo(t, args.repo, ctx);
const from = args.from || (await ghRequest(t, 'GET', `/repos/${full}`)).data.default_branch;
const { data: ref } = await ghRequest(t, 'GET', `/repos/${full}/git/ref/heads/${encodePath(from)}`);
await ghRequest(t, 'POST', `/repos/${full}/git/refs`, { ref: `refs/heads/${args.branch}`, sha: ref.object.sha });
return { ok: true, branch: args.branch, from, url: `https://github.com/${full}/tree/${encodeURIComponent(args.branch)}` };
}
case 'github_create_pull_request': {
const t = await needToken();
const full = await resolveRepo(t, args.repo, ctx);
const base = args.base || (await ghRequest(t, 'GET', `/repos/${full}`)).data.default_branch;
const { data } = await ghRequest(t, 'POST', `/repos/${full}/pulls`, { title: args.title, head: args.head, base, body: args.body || '' });
return { ok: true, number: data.number, html_url: data.html_url };
}
case 'cloudflare_list_zones': {
const t = await needCloudflareToken();
const query = new URLSearchParams({ per_page: '50', page: '1' });
if (args.name) query.set('name', String(args.name).slice(0, 253));
const data = await cloudflareApiRequest(t, 'GET', `/zones?${query}`);
return (data.result || []).map(z => ({ id: z.id, name: z.name, status: z.status, account_name: z.account?.name || null }));
}
case 'cloudflare_list_dns_records': {
const t = await needCloudflareToken();
const zoneId = validateCloudflareId(args.zone_id, 'zone_id');
const query = new URLSearchParams({ per_page: '100', page: '1' });
if (args.name) query.set('name', String(args.name).slice(0, 253));
if (args.type) query.set('type', String(args.type).toUpperCase());
const data = await cloudflareApiRequest(t, 'GET', `/zones/${zoneId}/dns_records?${query}`);
return (data.result || []).map(cloudflareSafeRecord);
}
case 'cloudflare_create_dns_record': {
const t = await needCloudflareToken();
const zoneId = validateCloudflareId(args.zone_id, 'zone_id');
const type = String(args.type || '').toUpperCase();
if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX'].includes(type)) throw new Error('نوع رکورد باید یکی از A، AAAA، CNAME، TXT یا MX باشد.');
const name = String(args.name || '').trim();
const content = String(args.content ?? '');
if (!name || name.length > 253 || /[\r\n\u0000]/.test(name)) throw new Error('نام DNS معتبر نیست.');
if (!content || content.length > 2048 || /[\u0000]/.test(content)) throw new Error('محتوای DNS خالی یا بیش از حد بزرگ است.');
const ttl = args.ttl === undefined ? 1 : Number(args.ttl);
if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) throw new Error('TTL باید ۱ (خودکار) یا بین ۶۰ تا ۸۶۴۰۰ باشد.');
const proxied = args.proxied === true;
if (proxied && !['A', 'AAAA', 'CNAME'].includes(type)) throw new Error('Proxied فقط برای A، AAAA و CNAME قابل استفاده است.');
const body = { type, name, content, ttl, proxied };
if (type === 'MX') body.priority = Number.isInteger(args.priority) ? Math.max(0, Math.min(65535, args.priority)) : 10;
const data = await cloudflareApiRequest(t, 'POST', `/zones/${zoneId}/dns_records`, body);
return { ok: true, record: cloudflareSafeRecord(data.result || {}) };
}
case 'cloudflare_update_dns_record': {
const t = await needCloudflareToken();
const zoneId = validateCloudflareId(args.zone_id, 'zone_id');
const recordId = validateCloudflareId(args.record_id, 'record_id');
const body = {};
if (args.content !== undefined) {
const content = String(args.content);
if (!content || content.length > 2048 || /[\u0000]/.test(content)) throw new Error('محتوای DNS معتبر نیست.');
body.content = content;
}
if (args.ttl !== undefined) {
const ttl = Number(args.ttl);
if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) throw new Error('TTL باید ۱ یا بین ۶۰ تا ۸۶۴۰۰ باشد.');
body.ttl = ttl;
}
if (args.proxied !== undefined) {
if (typeof args.proxied !== 'boolean') throw new Error('proxied باید true یا false باشد.');
body.proxied = args.proxied;
}
if (!Object.keys(body).length) throw new Error('حداقل یکی از content، ttl یا proxied را مشخص کن.');
const data = await cloudflareApiRequest(t, 'PATCH', `/zones/${zoneId}/dns_records/${recordId}`, body);
return { ok: true, record: cloudflareSafeRecord(data.result || {}) };
}
case 'cloudflare_delete_dns_record': {
const t = await needCloudflareToken();
const zoneId = validateCloudflareId(args.zone_id, 'zone_id');
const recordId = validateCloudflareId(args.record_id, 'record_id');
const data = await cloudflareApiRequest(t, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
return { ok: true, deleted_id: data.result?.id || recordId };
}
case 'cloudflare_list_workers': {
const t = await needCloudflareToken();
const accountId = validateCloudflareId(args.account_id, 'account_id');
const data = await cloudflareApiRequest(t, 'GET', `/accounts/${accountId}/workers/scripts?per_page=100`);
return (data.result || []).slice(0, 100).map(w => ({ id: w.id, created_on: w.created_on, modified_on: w.modified_on, compatibility_date: w.compatibility_date, usage_model: w.usage_model, etag: w.etag }));
}
case 'cloudflare_get_worker': {
const t = await needCloudflareToken();
const accountId = validateCloudflareId(args.account_id, 'account_id');
const scriptName = String(args.script_name || '');
if (!/^[A-Za-z0-9_-]{1,128}$/.test(scriptName)) throw new Error('نام Worker معتبر نیست.');
const data = await cloudflareApiRequest(t, 'GET', `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/script-settings`);
const result = data.result || {};
return { logpush: result.logpush, observability: result.observability ? {
enabled: result.observability.enabled,
head_sampling_rate: result.observability.head_sampling_rate,
logs: result.observability.logs ? { enabled: result.observability.logs.enabled, invocation_logs: result.observability.logs.invocation_logs, persist: result.observability.logs.persist } : undefined,
traces: result.observability.traces ? { enabled: result.observability.traces.enabled, head_sampling_rate: result.observability.traces.head_sampling_rate } : undefined
} : undefined, tags: result.tags };
}
case 'workspace_list_files': {
const ws = await getWorkspace(chatId, env);
return {
name: ws.name, total_files: ws.files.length,
total_size: formatSizeClient(ws.files.reduce((a, f) => a + (f.size || 0), 0)),
files: ws.files.slice(0, 400).map(f => `${f.path} (${formatSizeClient(f.size || 0)}${f.b64 !== undefined ? ', باینری' : ''})`)
};
}
case 'workspace_read_file': {
const ws = await getWorkspace(chatId, env);
const f = ws.files.find(x => x.path === cleanRepoPath(args.path));
if (!f) throw new Error('این فایل در فضای کار نیست');
if (f.text === undefined) return { path: f.path, binary: true, size: f.size };
return { path: f.path, content: f.text };
}
case 'workspace_write_file': {
const ws = await addFilesToWorkspace(chatId, [{ path: args.path, size: new TextEncoder().encode(String(args.content ?? '')).length, text: String(args.content ?? '') }], env, null);
return { ok: true, path: cleanRepoPath(args.path), total_files: ws.files.length };
}
case 'workspace_edit_file': {
const ws = await getWorkspace(chatId, env);
const f = ws.files.find(x => x.path === cleanRepoPath(args.path));
if (!f || f.text === undefined) throw new Error('فایل متنی در فضای کار پیدا نشد');
const count = f.text.split(args.old_text).length - 1;
if (count === 0) throw new Error('old_text در فایل پیدا نشد؛ اول فایل را بخوان و متن دقیق را بده');
if (count > 1) throw new Error(`old_text ${count} بار در فایل هست؛ متن طولانی‌تر و یکتا بده`);
f.text = f.text.replace(args.old_text, () => args.new_text);
f.size = new TextEncoder().encode(f.text).length;
await putWorkspace(chatId, ws, env);
return { ok: true, path: f.path };
}
case 'workspace_delete_file': {
const ws = await getWorkspace(chatId, env);
const before = ws.files.length;
ws.files = ws.files.filter(x => x.path !== cleanRepoPath(args.path));
await putWorkspace(chatId, ws, env);
return { ok: before !== ws.files.length };
}
case 'web_search': {
await incrementStat('total_search', env);
return { result: await webSearch(args.query || '') };
}
default:
throw new Error('ابزار ناشناخته: ' + name);
}
}

// ---------- پیام وضعیت (پیشرفت کار، مثل گزارش قدم‌به‌قدم) ----------
function createStatus(chatId, env) {
const lines = [];
let messageId = null;
const render = () => lines.map(l => `${l.state === 'run' ? '⏳' : l.state === 'ok' ? '✅' : '⚠️'} ${l.text}`).join('\n');
const push = async () => {
const text = render().substring(0, 3900);
try {
if (!messageId) {
const r = await sendMessage(chatId, text, env);
const d = await r.json().catch(() => ({}));
messageId = d.result?.message_id || null;
} else {
await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: chatId, message_id: messageId, text })
});
}
} catch (e) { /* پیام وضعیت مهم نیست */ }
};
return {
async start(text) { lines.push({ text, state: 'run' }); await push(); return lines.length - 1; },
async finish(i, ok, extra) {
if (!lines[i]) return;
lines[i].state = ok ? 'ok' : 'err';
if (extra) lines[i].text += ` — ${extra}`;
await push();
},
get used() { return lines.length > 0; }
};
}

function stringifyToolResult(result) {
let s = typeof result === 'string' ? result : JSON.stringify(result);
if (s.length > TOOL_RESULT_MAX_CHARS) s = s.substring(0, TOOL_RESULT_MAX_CHARS) + '... [خروجی کوتاه شد]';
return s;
}

// ---------- حلقه اصلی ایجنت ----------
async function runAgent(chatId, userId, userContent, env, settings, opts = {}) {
await sendChatAction(chatId, 'typing', env);
const history = await getHistory(chatId, env, settings);

// زمینه: وضعیت اتصال گیت‌هاب و فضای کار (بدون افشای توکن)
const token = await getGithubToken(userId, env);
let cloudflareToken = null;
try { cloudflareToken = await getCloudflareToken(userId, env); } catch (e) { logSafeError('cloudflare_credential_read', e); }
const activeProject = await getActiveProject(chatId, env);
const linkedRepo = activeProject ? await getProjectRepo(chatId, activeProject.id, env) : null;
const ws = await getWorkspace(chatId, env);
let context = `\n\nوضعیت فعلی:\n- گیت‌هاب: ${token ? 'وصل است (توکن ذخیره شده)' : 'وصل نیست — اگر کاربر کار گیت‌هابی خواست، بگو توکن را با /github <توکن> بفرستد'}`;
context += `\n- پروژهٔ فعال: ${activeProject ? `«${activeProject.name}» (حافظه و فضای کار جداگانه)` : 'حالت پیش‌فرض ربات'}`;
if (linkedRepo) context += `\n- مخزن GitHub پروژه: ${linkedRepo.repo} (برنچ ${linkedRepo.branch})`;
context += `\n- Cloudflare: ${cloudflareToken ? 'وصل است؛ ابزارهای مشاهده و مدیریت DNS با تأیید در دسترس‌اند' : 'وصل نیست؛ برای اتصال امن در گفت‌وگوی خصوصی /cloudflare را راهنمایی کن'}`;
context += `\n- فضای کار: ${ws.files.length ? `«${ws.name || 'بدون نام'}» با ${ws.files.length} فایل` : 'خالی'}`;
context += `\n- تاریخ: ${new Date().toISOString().slice(0, 10)}`;
if (opts.isCode) context += '\n- پیام کاربر احتمالاً کد یا لاگ خطاست؛ مشکل واقعی را پیدا کن و راه‌حل بده.';

const messages = [
{ role: 'system', content: AGENT_PROMPT + context },
...history,
{ role: 'user', content: userContent }
];

const ctx = { env, chatId, userId, token: token || null, cloudflareToken: cloudflareToken || null, login: null };
const status = createStatus(chatId, env);
let finalText = '';
// با مدل شخصی کاربر، پرچم سراسری نادیده گرفته می‌شود (ممکن است مدل او ابزارها را پشتیبانی کند)
const userConn = await getUserAIConn(userId, env);
let useTools = userConn ? true : !agentToolsUnsupported;
const failures = {};

for (let step = 0; step < AGENT_MAX_STEPS; step++) {
let msg;
try {
msg = await callAI(messages, env, { userId, raw: true, tools: useTools ? AGENT_TOOLS : undefined, max_tokens: 4000, temperature: 0.5 });
} catch (e) {
// اگر سرویس از ابزارها پشتیبانی نکند، بدون ابزار ادامه بده
if (useTools && step === 0 && (e.status === 400 || e.status === 422) && /tool|function/i.test(e.message)) {
if (!userConn) agentToolsUnsupported = true;
useTools = false;
step--;
continue;
}
throw e;
}

const calls = msg.tool_calls || [];
if (!calls.length) {
finalText = msg.content || '';
break;
}

messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
for (const call of calls) {
const name = call.function?.name;
let args = {};
try { args = JSON.parse(call.function?.arguments || '{}'); } catch (e) { args = {}; }
if (typeof name !== 'string' || !AGENT_TOOLS.some(t => t.function?.name === name)) {
messages.push({ role: 'tool', tool_call_id: call.id, content: stringifyToolResult({ error: 'این ابزار در رجیستری مجاز ربات وجود ندارد و اجرا نشد.' }) });
continue;
}
if (name.startsWith('cloudflare_') && String(chatId) !== String(userId)) {
messages.push({ role: 'tool', tool_call_id: call.id, content: stringifyToolResult({ error: 'ابزارهای Cloudflare فقط در گفت‌وگوی خصوصی قابل استفاده‌اند.' }) });
continue;
}
const canPreviewMutation = name.startsWith('github_') ? !!token : name.startsWith('cloudflare_') ? !!cloudflareToken : true;
if (agentToolNeedsApproval(name) && canPreviewMutation) {
try {
const currentProject = await getActiveProject(chatId, env);
const tokenFingerprint = name.startsWith('github_') ? await textFingerprint(token) : null;
const cloudflareTokenFingerprint = name.startsWith('cloudflare_') ? await textFingerprint(cloudflareToken) : null;
const cfPreview = name.startsWith('cloudflare_') ? await prepareCloudflareActionPreview(name, args, cloudflareToken) : null;
const details = cfPreview?.details || await buildAgentActionDetails(name, args, chatId, env);
const bindsWorkspace = name.startsWith('workspace_') || (name === 'github_push' && (args.from_workspace || args.workspace_paths?.length));
const currentWorkspace = bindsWorkspace ? await getWorkspace(chatId, env) : null;
await requestActionConfirmation(chatId, userId, env, {
kind: 'agent_tool',
payload: {
toolName: name, args, activeProjectId: currentProject?.id || null,
githubTokenFingerprint: tokenFingerprint,
cloudflareTokenFingerprint,
cloudflareRecordFingerprint: cfPreview?.recordFingerprint || null,
workspaceFingerprint: currentWorkspace ? await projectFilesFingerprint(currentWorkspace.files || []) : null,
requestText: String(opts.historyText || userContent).substring(0, MEMORY_MAX_CHARS_PER_MSG)
},
title: toolLabel(name, args),
details: details || 'این ابزار تغییری در داده‌ها یا حساب متصل ایجاد می‌کند.'
});
} catch (approvalError) {
logSafeError('action_approval_create', approvalError);
await sendMessage(chatId, `⛔ عملیات اجرا نشد؛ نتوانستم پیش‌نمایش تأیید را امن ذخیره کنم. دوباره تلاش کن.`, env);
}
return;
}
const idx = await status.start(toolLabel(name, args));
await sendChatAction(chatId, 'typing', env);
let result;
try {
result = await executeTool(name, args, ctx);
await status.finish(idx, true);
} catch (e) {
const key = name + ':' + (call.function?.arguments || '');
failures[key] = (failures[key] || 0) + 1;
const safeMessage = userSafeErrorMessage(e, name.startsWith('cloudflare_') ? 'cloudflare' : name.startsWith('github_') ? 'github' : 'general');
logSafeError('agent_tool', e);
result = { error: safeMessage, hint: failures[key] > 1 ? 'این کار دوبار با همین ورودی شکست خورده؛ تکرارش نکن، راه دیگری امتحان کن یا مشکل را به کاربر بگو.' : undefined };
await status.finish(idx, false, safeMessage.substring(0, 120));
}
messages.push({ role: 'tool', tool_call_id: call.id, content: stringifyToolResult(result) });
}
}

// اگر به سقف قدم‌ها رسید، یک جمع‌بندی بدون ابزار بگیر
if (!finalText) {
messages.push({ role: 'user', content: 'به سقف تعداد قدم‌ها رسیدی. بدون ابزار، کوتاه بگو تا اینجا چه کار شد، چه چیزی مانده و کاربر چه کند.' });
try {
finalText = await callAI(messages, env, { userId, max_tokens: 1500 });
} catch (e) {
finalText = 'کار طولانی شد و نیمه‌کاره ماند. بگو ادامه بدم.';
}
}

await addHistory(chatId, [
{ role: 'user', content: opts.historyText || userContent },
{ role: 'assistant', content: finalText }
], env, settings);

await sendLongMessage(chatId, finalText, env);
return finalText;
}


// =============== توابع کمکی ===============

function jsonResponse(data, status = 200) {
return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isTextFile(ext, mime) {
if (ext && TEXT_EXTENSIONS.has(ext)) return true;
if (mime && (mime.startsWith('text/') || mime.includes('json') ||
mime.includes('javascript') || mime.includes('xml') || mime.includes('yaml'))) return true;
return false;
}

function formatSizeClient(bytes) {
if (bytes < 1024) return bytes + ' B';
if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function arrayBufferToBase64(buffer) {
const bytes = new Uint8Array(buffer);
let binary = '';
const CHUNK = 0x8000;
for (let i = 0; i < bytes.length; i += CHUNK) {
binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
}
return btoa(binary);
}

function detectLanguage(code) {
if (/^\s*#include\s*<.+>/m.test(code)) return 'C/C++';
if (/<\?php/.test(code)) return 'PHP';
if (/public\s+(class|static\s+void\s+main)/.test(code)) return 'Java';
if (/def\s+\w+\s*\(.*\)\s*:/.test(code) || /^\s*import\s+\w+/m.test(code)) return 'Python';
if (/<html[\s>]|<div[\s>]|<!DOCTYPE/i.test(code)) return 'HTML';
if (/function\s+\w+\s*\(|=>|const\s+\w+\s*=|let\s+\w+\s*=/.test(code)) return 'JavaScript';
return null;
}

// تحلیل محلی ساده (fallback وقتی AI تنظیم نیست)
function analyzeCode(code, defaultLanguage) {
const language = detectLanguage(code) || defaultLanguage || 'نامشخص';
const lines = code.split('\n');
const issues = [];

const closers = { '(': ')', '[': ']', '{': '}' };
const openers = Object.keys(closers);
const closerSet = new Set(Object.values(closers));
const stack = [];
let unbalanced = false;

for (const ch of code) {
if (openers.includes(ch)) stack.push(closers[ch]);
else if (closerSet.has(ch)) {
if (stack.pop() !== ch) { unbalanced = true; break; }
}
}
if (unbalanced || stack.length > 0) {
issues.push('پرانتز / آکولاد / براکت نامتعادل یا بسته‌نشده پیدا شد.');
}

const todoCount = (code.match(/TODO|FIXME/gi) || []).length;
if (todoCount > 0) issues.push(`${todoCount} مورد TODO/FIXME در کد یافت شد.`);

const longLines = lines.filter(l => l.length > 120).length;
if (longLines > 0) issues.push(`${longLines} خط طولانی‌تر از ۱۲۰ کاراکتر وجود دارد.`);

let report = `🔍 نتیجه تحلیل کد:\n\n`;
report += `زبان تشخیص داده‌شده: ${language}\n`;
report += `تعداد خطوط: ${lines.length}\n`;
report += `تعداد کاراکتر: ${code.length}\n\n`;
report += issues.length > 0
? 'مشکلات یافت‌شده:\n' + issues.map(i => '• ' + i).join('\n')
: '✅ مشکل ساختاری مشخصی پیدا نشد.';

return report;
}

async function saveUser(userId, username, chatId, env) {
await env.DB.prepare(
`INSERT OR IGNORE INTO users (id, username, chat_id) VALUES (?, ?, ?)`
).bind(userId, username, chatId).run();
}

async function incrementStat(statName, env) {
const current = await env.STATS.get(statName);
const newValue = (parseInt(current) || 0) + 1;
await env.STATS.put(statName, newValue.toString());
}

async function sendMessage(chatId, text, env, markup = null, parseMode = null) {
const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
// markup: آرایه ردیف‌ها = دکمه شیشه‌ای | شیء = reply_markup کامل (مثلاً کیبورد ثابت)
const reply_markup = !markup ? null : (Array.isArray(markup) ? { inline_keyboard: markup } : markup);
return await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: chatId,
text: text,
...(parseMode ? { parse_mode: parseMode } : {}),
...(reply_markup ? { reply_markup } : {})
})
});
}

// ارسال پیام‌های طولانی با فرمت زیبا (کد داخل بلوک) — تلگرام: حداکثر ۴۰۹۶ کاراکتر
async function sendLongMessage(chatId, text, env) {
if (!text) return;
for (const chunk of splitMessage(String(text), 3500)) {
await sendFormatted(chatId, chunk, env);
}
}

// تقسیم متن روی مرز خط؛ بلوک کد نیمه‌کاره بسته و در پیام بعدی دوباره باز می‌شود
function splitMessage(text, max = 3500) {
if (text.length <= max) return [text];
const lines = text.split('\n').flatMap(l => l.length > max ? (l.match(new RegExp(`.{1,${max}}`, 'g')) || [l]) : [l]);
const chunks = [];
let cur = '';
let inFence = false;
let header = '```';
const flush = () => { if (cur.trim()) chunks.push(inFence ? cur + '\n```' : cur); };

for (const line of lines) {
if (cur.length + line.length + 1 > max) {
flush();
cur = inFence ? header : '';
}
cur = cur ? cur + '\n' + line : line;
const t = line.trim();
if (t.startsWith('```') && ((t.match(/```/g) || []).length % 2 === 1)) {
if (inFence) inFence = false;
else { inFence = true; header = t; }
}
}
if (cur.trim()) chunks.push(cur);
return chunks;
}

function escapeTg(s) {
return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// تبدیل Markdown ساده به HTML تلگرام
function mdToTelegramHtml(text) {
const blocks = [];
const inline = [];
let t = text.replace(/```[\w+#.-]*[ \t]*\n?([\s\S]*?)```/g, (_, code) => {
blocks.push(code.replace(/\n$/, ''));
return `\u0000B${blocks.length - 1}\u0000`;
});
t = t.replace(/`([^`\n]+)`/g, (_, c) => {
inline.push(c);
return `\u0000I${inline.length - 1}\u0000`;
});
t = escapeTg(t);
t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
t = t.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
t = t.replace(/\u0000I(\d+)\u0000/g, (_, i) => `<code>${escapeTg(inline[i])}</code>`);
t = t.replace(/\u0000B(\d+)\u0000/g, (_, i) => `<pre><code>${escapeTg(blocks[i])}</code></pre>`);
return t;
}

// ارسال با HTML؛ اگر تلگرام نپذیرفت، متن ساده ارسال می‌شود
async function sendFormatted(chatId, text, env) {
const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
try {
const res = await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: chatId, text: mdToTelegramHtml(text), parse_mode: 'HTML' })
});
if (res.ok) return res;
} catch (e) { /* fallback */ }
return sendMessage(chatId, text, env);
}

async function sendChatAction(chatId, action, env) {
const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`;
await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: chatId, action: action })
}).catch(() => {});
}

async function getTelegramFile(fileId, env) {
const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
const res = await fetch(url);
const data = await res.json();
return data.result || {};
}

async function downloadTelegramFile(filePath, env) {
const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
const res = await fetch(url);
if (!res.ok) throw new Error('دانلود فایل از تلگرام ناموفق بود');
return await res.arrayBuffer();
}

// =============== توابع API پنل ===============

async function getStats(env) {
return jsonResponse(await getStatsData(env));
}

async function getStatsData(env) {
const totalMessages = await env.STATS.get('total_messages') || '0';
const totalCode = await env.STATS.get('total_code') || '0';
const totalSearch = await env.STATS.get('total_search') || '0';
const totalFiles = await env.STATS.get('total_files') || '0';
const totalUsersRow = await env.DB.prepare('SELECT COUNT(*) as total FROM users').first();
return {
total_users: totalUsersRow?.total || 0,
total_messages: totalMessages,
total_code: totalCode,
total_search: totalSearch,
total_files: totalFiles
};
}

async function getUsers(env) {
return jsonResponse({ users: await getUsersData(env) });
}

async function getUsersData(env) {
const { results } = await env.DB.prepare(
'SELECT * FROM users ORDER BY created_at DESC LIMIT 100'
).all();
return results;
}

async function getUserDetail(userId, env) {
const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
return jsonResponse({
user: user || { id: userId, username: 'کاربر' }
});
}

async function deleteUser(userId, env) {
await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
return jsonResponse({ message: 'کاربر حذف شد' });
}

async function broadcastMessage(message, type, env) {
if (!message) return jsonResponse({ message: 'متن پیام خالی است' }, 400);

const stmt = (type && type !== 'all')
? env.DB.prepare('SELECT chat_id FROM users WHERE preferred_language = ?').bind(type)
: env.DB.prepare('SELECT chat_id FROM users');
const { results: users } = await stmt.all();

let sent = 0, failed = 0;
for (const user of users) {
try {
const r = await sendMessage(user.chat_id, message, env);
if (r.ok) sent++; else failed++;
} catch (error) {
failed++;
}
}
return jsonResponse({ message: `ارسال شد: ${sent}، ناموفق: ${failed}`, sent, failed });
}

async function getSettings(env) {
const s = await getSettingsData(env);
return jsonResponse({ ...s, ai_api_key: maskApiKey(s.ai_api_key) });
}

async function getSettingsData(env) {
const settings = await env.STATS.get('settings');
if (!settings) return { ...DEFAULT_SETTINGS };
return { ...DEFAULT_SETTINGS, ...JSON.parse(settings) };
}

// ذخیره تنظیمات با merge — کلید API ماسک‌شده یا خالی یعنی «تغییر نکن»
async function saveSettings(newSettings, env) {
const current = await getSettingsData(env);
if (!newSettings.ai_api_key || newSettings.ai_api_key.includes('••••')) {
newSettings.ai_api_key = current.ai_api_key || '';
}
const merged = { ...current, ...newSettings };
await env.STATS.put('settings', JSON.stringify(merged));
return jsonResponse({ message: 'تنظیمات ذخیره شد' });
}

async function getFilesList(env) {
const files = [];
const list = await env.FILES.list();
for (const key of list.keys) {
const metadata = await env.FILES.get(key.name);
if (metadata) files.push(JSON.parse(metadata));
}
return jsonResponse({ files });
}

async function deleteFile(fileKey, env) {
await env.FILES.delete(fileKey);
return jsonResponse({ message: 'فایل حذف شد' });
}

async function getSystemStatus(env) {
return jsonResponse({
status: 'healthy',
ai_base_url: DEFAULT_AI_BASE_URL,
ai_model: DEFAULT_AI_MODEL,
timestamp: new Date().toISOString()
});
}

async function setupWebhook(url, env) {
const workerUrl = `${url.origin}/webhook`;
let apiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(workerUrl)}`;
if (env.WEBHOOK_SECRET) apiUrl += `&secret_token=${encodeURIComponent(env.WEBHOOK_SECRET)}`;
const response = await fetch(apiUrl);
const data = await response.json();
return new Response(JSON.stringify(data, null, 2), {
headers: { 'Content-Type': 'application/json' }
});
}
