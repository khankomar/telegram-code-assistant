# معماری پیشنهادی: ایجنت متصل به سرویس‌های کاربر

## هدف

ربات فعلی به‌جای محدودماندن به دیباگ و GitHub، بتواند درخواست‌هایی مانند «Workerهای Cloudflare من را فهرست کن»، «علت خطای deploy را بررسی کن» یا «این نسخه را منتشر کن» بفهمد و در حساب همان کاربر اجرا کند. این گسترش باید افزایشی باشد: حافظه و workspace پروژه‌ها، اتصال مدل شخصی، منوی تلگرام و قابلیت‌های فعلی حفظ می‌شوند.

## وضعیت فعلی کد

هستهٔ ایجنت در `worker.js` از `AGENT_TOOLS` برای معرفی ابزارها به مدل و از `executeTool()` برای اجرای آن‌ها استفاده می‌کند. `runAgent()` حلقهٔ برنامه‌ریزی و فراخوانی ابزارها را اجرا می‌کند؛ بنابراین می‌توان اتصال‌های تازه را به‌صورت provider/adapter به همین مسیر افزود، ولی مجوز و تأیید نباید به تصمیم خود مدل واگذار شود.

اطلاعات کاربران و تاریخچه در D1 است و `STATS` در KV وضعیت‌هایی از جمله workspace، پروژه و توکن GitHub را نگه می‌دارد. در نسخهٔ فعلی، توکن GitHub هر کاربر با کلید `gh_token:<userId>` به‌صورت متن در KV ذخیره می‌شود و مهلت ۳۰روزه دارد؛ پیام حاوی توکن هم از چت حذف می‌شود. برای اتصال سرویس‌های بیشتر، این روش باید پیش از گسترش به اعتبارنامه‌های متعدد اصلاح شود.

## اجزای معماری

**۱. هستهٔ مکالمه و planner.** پیام کاربر را به یک برنامهٔ کوچک و قابل توضیح تبدیل می‌کند: هدف، حساب/منبع هدف، ابزارهای لازم و نتیجهٔ مورد انتظار. اگر حساب یا منبع مبهم باشد، قبل از اقدام سؤال می‌پرسد. متن مخزن، لاگ، خروجی وب و هر دادهٔ برگشتی «دادهٔ غیرقابل‌اعتماد» است؛ نمی‌تواند دستورهای سیستمی یا مجوزهای ابزار را عوض کند.

**۲. رجیستری ابزارها و adapterهای سرویس.** ابزارها با نام‌های صریح و JSON schema محدود تعریف می‌شوند؛ برای نمونه `cloudflare.accounts.list`, `cloudflare.workers.list`, `cloudflare.workers.inspect` و بعدتر `cloudflare.workers.deploy`. هر ابزار metadata دارد: provider، نوع اثر (خواندن/نوشتن/حذف)، permission لازم، محدودهٔ منابع و سطح ریسک. adapter درخواست API را می‌سازد و پاسخ را محدود و پاک‌سازی می‌کند. مدل هرگز URL دلخواه، shell آزاد یا توکن خام دریافت نمی‌کند.

**۳. policy/permission engine.** پیش از هر اجرا بررسی می‌کند که اتصال متعلق به همان Telegram user باشد، provider و حساب موردنظر وصل باشند، scope واقعی توکن کافی باشد، منبع هدف داخل محدودهٔ مجاز قرار گیرد و سطح ریسک اجازهٔ اجرا بدهد. در گروه‌های تلگرام، اتصال حساب و تأیید عملیات فقط در گفت‌وگوی خصوصی همان کاربر انجام شود تا اعضای دیگر از دسترسی او استفاده نکنند.

**۴. اجرای کنترل‌شده، تأیید و audit.** کارهای read-only کم‌خطر را می‌توان مستقیم اجرا کرد. هر نوشتن یا تغییر حساب، مانند deploy یا تغییر DNS، ابتدا پیش‌نمایش می‌سازد. پیش‌نمایش باید سرویس، حساب، Worker/Zone، تغییرات، پیامد و scope لازم را نشان دهد. دکمهٔ تأیید یک‌بارمصرف و کوتاه‌عمر به همان کاربر، همان منبع و hash همان payload متصل می‌شود؛ تغییر ورودی بعد از تأیید، تأیید قبلی را بی‌اعتبار می‌کند. حذف، انتشار عمومی یا تغییرات بسیار حساس می‌توانند تأیید جداگانهٔ دوم بخواهند. نتیجهٔ API پس از اجرا دوباره خوانده و با هدف مقایسه می‌شود.

## اتصال حساب‌ها

### Cloudflare

برای سرویس عمومی با کاربران متعدد، هدف بلندمدت OAuth client متعلق به برنامه است: کاربر در Cloudflare consent می‌دهد و scopeها را می‌بیند. OAuth clientهای Cloudflare از Authorization Code پشتیبانی می‌کنند؛ برای public کردن client تأیید مالکیت دامنه لازم است، پس باید دامنه و سیاست حریم خصوصی آماده باشد. [1] [2] نسخهٔ MVP حاضر هنوز OAuth نیست؛ از API Token محدود per-user از طریق فرم HTTPS یک‌بارمصرف استفاده می‌کند.

در MVP، permissionهای API Token بر اساس endpointهای واقعی تنظیم می‌شوند و خود Cloudflare هر درخواست را با permissionهای token اعمال می‌کند. نسخهٔ بعدی می‌تواند این مسیر را به OAuth و consent per-scope ارتقا دهد.

اگر یک endpoint موردنیاز با OAuth سازگار نبود، مسیر پشتیبان یک API Token محدود به همان Account/Zone و permissionهای دقیق است، نه Global API Key. توکن فقط در فرم HTTPS کوتاه‌عمر وارد شود، همان‌جا اعتبارسنجی و رمزگذاری شود و هرگز در چت تلگرام فرستاده نشود. Cloudflare اجازه می‌دهد token را به resourceهای مشخص و permissionهای Read/Edit محدود و برای آن expiration بگذارد؛ بعضی سرویس‌ها ممکن است با Account API token سازگار نباشند، پس سازگاری باید بر اساس API انتخابی بررسی شود. [3] [4]

### GitHub و سرویس‌های بعدی

اتصال فعلی GitHub را می‌توان موقتاً حفظ کرد تا رفتار قدیمی نشکند، اما مسیر هدف بهتر است GitHub App باشد: برنامه permissionهای مشخص می‌گیرد و کاربر نصب را فقط برای مخزن‌های موردنظر انجام می‌دهد. توکن user-access در GitHub App فقط اشتراک دسترسی‌های خود برنامه و کاربر را دارد؛ توکن‌های منقضی‌شونده معمولاً ۸ ساعت اعتبار دارند و با refresh token تمدید می‌شوند. این از PAT بلندمدت و گسترده مناسب‌تر است. [5] [6]

بعد از پایدارشدن Cloudflare، providerهای دیگر مانند Vercel/Netlify برای deploy و Supabase برای مدیریت پروژه/داده را می‌توان جداگانه افزود. هر اتصال مستقل است؛ ربات نباید با وصل‌کردن یک سرویس، خودکار به سرویس‌های دیگر دسترسی بگیرد.

## ذخیره‌سازی و جداول پیشنهادی

برای metadata و وضعیت پایدار، D1 موجود استفاده می‌شود. پیاده‌سازی MVP جدول `user_integrations` را برای ciphertext، IV، metadata و key version دارد و `cloudflare_connect_sessions` state hash کوتاه‌عمر و یک‌بارمصرف را به user/chat bind می‌کند. ردیف‌های `action_approvals` مالک، payload و زمان انقضا را نگه می‌دارند. جدول audit مستقل در مرحلهٔ بعد قابل افزودن است؛ token خام در آن ثبت نمی‌شود.

توکن‌های per-user را به شکل ciphertext با AES-GCM در D1 ذخیره می‌کنیم؛ کلید رمزگذاری ریشه فقط در Worker Secret است، نه در D1/KV یا prompt مدل. برای هر رکورد nonce یکتا و AAD شامل provider/user/connection به کار می‌رود و `key_version` چرخش کلید را ممکن می‌کند. KV برای cache و state کوتاه‌عمر مناسب است، نه مخزن بلندمدتِ توکن خام. اتصال‌های موجود GitHub باید با مهاجرت lazy یا مرحله‌ای از KV قدیمی خوانده، رمزگذاری و در D1 ذخیره شوند؛ پس از تأیید صحت نسخهٔ جدید، کلید قدیمی KV حذف شود. Worker Secrets نیز برای کلیدهای خود برنامه مثل OAuth client secret هستند، نه برای نگهداری یک secret جداگانه برای هر کاربر.

## فرمان‌ها و نمونهٔ تجربهٔ کاربر

فرمان افزایشی MVP: `/cloudflare` برای اتصال/وضعیت و `/cloudflare off` برای قطع است. پس از `/cloudflare` در گفت‌وگوی خصوصی، کاربر API Token محدود را در فرم HTTPS وارد می‌کند و سپس درخواست اتصال را در تلگرام تأیید می‌کند. کاربر می‌تواند Zoneها/DNS را بخواند، DNS را با preview و approval تغییر دهد، و Workerها و metadata/تنظیمات مشاهده‌پذیری را بخواند. deploy، تغییر bindings/secrets و حذف Worker در MVP نیستند.

## ترتیب اجرا

1. **پایهٔ امنیتی (در حال تکمیل):** provider/tool registry، credentialهای رمزگذاری‌شده، session یک‌بارمصرف و approvalهای payload-bound.
2. **Cloudflare API Token MVP (پیاده‌سازی‌شده):** فرم HTTPS، AES-GCM، لغو اتصال، Zone/DNS read, DNS CRUD با preview/approval، و Worker list/settings read-only.
3. **ارتقای Cloudflare:** OAuth عمومی بعد از ثبت و بررسی app، Worker deploy از ref مشخص، مدیریت bindings/secret و منابع دیگر با تأییدهای مجزا و permissionهای محدود.
4. **گسترش providerها:** GitHub App و سپس سرویس‌های منتخب کاربر، با همان قرارداد adapter و policy engine.

## تصمیم MVP برای اتصال Cloudflare

برای نسخهٔ اول، به‌جای ثبت OAuth client عمومی، کاربر یک API Token محدود و متعلق به خودش می‌سازد و آن را فقط در یک فرم HTTPS کوتاه‌عمر وارد می‌کند؛ توکن هرگز از مسیر چت تلگرام عبور نمی‌کند. این انتخاب نیاز به مالکیت دامنه و فرایند دائمی public کردن OAuth client را ندارد. فرم با state تصادفی یک‌بارمصرف به Telegram user/chat وصل است، توکن را اعتبارسنجی می‌کند و پیش از درخواست تأیید تلگرام با AES-GCM رمز می‌کند. تأیید فعلی یک‌بارمصرف است و اتصال فقط پس از تأیید همان کاربر ذخیره می‌شود.

محدودهٔ پیاده‌سازی نخست: فهرست Zoneها و DNS recordها، فهرست و مشاهدهٔ metadata مربوط به Workerها، و ایجاد/ویرایش/حذف DNS record با preview دقیق و تأیید. «حساب‌ها» با endpoint فهرست `/accounts` پیاده‌سازی نمی‌شود، چون مستند endpoint آن API Token را در روش‌های احراز خود نشان نمی‌دهد؛ برای Workerها کاربر `account_id` را از داشبورد وارد می‌کند. بارگذاری کد Worker، مدیریت secret/binding، حذف Worker و دسترسی‌های دیگر در این مرحله خارج از scope هستند.

حداقل permission برای مشاهدهٔ Zoneها `Zone Zone Read` است. مشاهدهٔ DNS record به `DNS Read` نیاز دارد؛ ساخت، ویرایش و حذف DNS record به `DNS Write` نیاز دارند. فهرست Worker scriptها به یکی از permissionهای پذیرفته‌شده مثل `Workers Scripts Read` نیاز دارد. کاربر باید Resource scope را تا حد ممکن به Zone/Account مشخص محدود کند و برای عملیات فقط‌خواندنی از توکنی با permissionهای write استفاده نکند. Cloudflare endpointها permissionهای پذیرفته‌شده را در مرجع API جداگانه فهرست می‌کنند. [7] [8] [9] [10] [11] [12]

## معیارهای پذیرش MVP

- یک کاربر نمی‌تواند اتصال، حساب، history یا approval کاربر دیگری را بخواند یا اجرا کند.
- `/cloudflare` فقط پس از فرم HTTPS معتبر، token verification و تأیید callback تلگرام اتصال را ثبت می‌کند؛ `/cloudflare off` credential را حذف می‌کند.
- بدون scope لازم، ابزار به جای تلاش، دلیل کمبود دسترسی را روشن می‌گوید.
- ابزار read-only بدون تأیید اجرا می‌شود؛ هر تغییر از preview دقیق و تأیید متصل به payload می‌گذرد.
- توکن خام در prompt، پاسخ تلگرام، لاگ، KV یا گزارش audit ظاهر نمی‌شود.
- تمام قابلیت‌های قدیمی و تست‌های فعلی رگرسیون را پاس می‌کنند.

## منابع

[1]: https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/ "Create your OAuth client"
[2]: https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/ "Authorizing an application"
[3]: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ "Create API token"
[4]: https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/ "Account API tokens"
[5]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app "Generating a user access token for a GitHub App"
[6]: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens "Permissions required for fine-grained personal access tokens"
[7]: https://developers.cloudflare.com/fundamentals/api/reference/permissions/ "API token permissions"
[8]: https://developers.cloudflare.com/api/resources/zones/methods/list/ "List Zones"
[9]: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/ "List DNS Records"
[10]: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/ "Create DNS Record"
[11]: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/ "Update DNS Record"
[12]: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/ "List Worker Scripts"
[13]: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/ "Delete DNS Record"
[14]: https://developers.cloudflare.com/api/resources/accounts/methods/list/ "List Accounts"
