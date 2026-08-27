import { readFileSync } from 'node:fs';

/**
 * بذر محاكي فايربيس بحسابٍ تجريبي ومحلٍّ جاهز — لفحص الشاشات بيدٍ بشرية.
 *
 * 🔴 لماذا وُجد؟ لأن كل شاشة في البرنامج خلف تسجيل دخول، فبقيت الواجهة تُفحص
 * بقراءة الشيفرة وقياس أصنافٍ محقونة — لا بضغطة زرّ ولا بحقلٍ مُلئ. وهذا يفتحها
 * كلّها بحسابٍ محليّ، بلا لمس بياناتٍ حقيقية ولا معرفة كلمة مرور أحد.
 *
 * ⚠️ يعمل على المحاكي وحده: يخاطب `127.0.0.1:9099` و`127.0.0.1:8080` مباشرةً
 *   عبر واجهتَيهما REST. فلا سبيل لأن يمسّ الإنتاج ولو بالخطأ.
 *
 * التشغيل:
 *   نافذة ١:  npm run emulators
 *   نافذة ٢:  npm run dev:emulator
 *   ثم:       npm run seed:emulator
 */

/**
 * 🔴 معرّف المشروع يُقرأ من `.env` — **لا يُثبَّت هنا**.
 *
 * المحاكي يفصل البيانات بالمشروع. وأول كتابةٍ لهذا السكربت ثبّتت
 * `ratib-dev-local` بينما التطبيق يتصل بمعرّف `.env` — فبذرتُ في فضاءٍ
 * والتطبيق يقرأ من آخر. والنتيجة لوحةٌ صفريّة رغم أن البيانات مكتوبة، بلا
 * خطأ ولا رسالة. قِيس من مسار الطلبات: `projects/ratib-shghlk-e419f/…`.
 */
function projectIdFromEnv() {
  const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const line = envFile.split('\n').find(l => l.trim().startsWith('VITE_FIREBASE_PROJECT_ID'));
  const id = line?.split('=')[1]?.trim().replace(/^["']|["']$/g, '');
  if (!id) throw new Error('VITE_FIREBASE_PROJECT_ID غير موجود في .env');
  return id;
}

const PROJECT = projectIdFromEnv();
const AUTH = 'http://127.0.0.1:9099';
const FS = 'http://127.0.0.1:8080';
const EMAIL = 'owner@test.local';
const PASSWORD = 'test1234';

const base = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;

/** يحوّل قيمة JS إلى تمثيل Firestore REST. */
const val = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v)
    ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } };
  if (typeof v === 'object') return { mapValue: { fields: fields(v) } };
  return { stringValue: String(v) };
};
const fields = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, val(v)]));

/**
 * 🔴 `Bearer owner` — رمزٌ يقبله **المحاكي وحده** فيتجاوز قواعد الأمان.
 *
 * البذر يكتب في شجرة المالك قبل أن يسجّل أحدٌ دخوله، والقواعد ترفض ذلك بحقّ
 * (جرّبتُه: `PERMISSION_DENIED`). وهذا الرمز هو الطريق المُعتمَد للبذر — ولا
 * وجود له في الإنتاج: خادم فايرستور الحقيقي يرفضه.
 */
async function put(path, data) {
  const res = await fetch(`${base}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: fields(data) }),
  });
  if (!res.ok) throw new Error(`كتابة ${path} فشلت: ${res.status} ${await res.text()}`);
}

/**
 * يُعيد `localId` للحساب التجريبي — يُنشئه إن غاب، ويدخل به إن وُجد.
 *
 * 🔴 التسامح مقصود: أول كتابةٍ كانت تحذف كل الحسابات ثم تُنشئ، فانكسرت حين
 * تغيّر معرّف المشروع (`EMAIL_EXISTS`). والبذر يجب أن يكون **قابلاً لإعادة
 * التشغيل** مرّاتٍ بلا تنظيفٍ يدوي — وإلا صار هو نفسه عائقاً.
 */
async function ensureUser() {
  const call = (op, body) => fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:${op}?key=any`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, returnSecureToken: true }),
    },
  );

  const up = await call('signUp', { email: EMAIL, password: PASSWORD });
  if (up.ok) return (await up.json()).localId;

  const err = await up.text();
  if (!err.includes('EMAIL_EXISTS')) throw new Error(`إنشاء الحساب فشل: ${up.status} ${err}`);

  const inRes = await call('signInWithPassword', { email: EMAIL, password: PASSWORD });
  if (!inRes.ok) throw new Error(`الحساب موجود والدخول فشل: ${await inRes.text()}`);
  return (await inRes.json()).localId;
}

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  // فحص أن المحاكي يعمل قبل أي شيء — رسالةٌ واضحة خيرٌ من انهيارٍ غامض
  try {
    await fetch(`${FS}/`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error('🔴 محاكي فايرستور لا يعمل على ٨٠٨٠ — شغّل `npm run emulators` أولاً');
    process.exit(1);
  }

  const uid = await ensureUser();
  console.log(`👤 الحساب: ${EMAIL} / ${PASSWORD}`);

  const u = `users/${uid}`;
  await put(u, {
    storeName: 'محل الاختبار', ownerName: 'صاحب المحل',
    phone: '07701234567', address: 'بغداد', businessType: 'general',
    createdAt: TODAY, licenseCode: 'SEED-LOCAL',
  });
  await put(`${u}/settings/system`, {
    currency: 'IQD', exchangeRate: 1500, printFormat: 'thermal',
  });

  const products = [
    { id: 'p_rice', name: 'رز عنبر', sell: 25000, buy: 20000, qty: 40, cat: 'مواد غذائية', unit: 'كيس' },
    { id: 'p_oil', name: 'زيت دوار الشمس', sell: 15000, buy: 12000, qty: 60, cat: 'مواد غذائية', unit: 'قنينة' },
    { id: 'p_sugar', name: 'سكر', sell: 1500, buy: 1000, qty: 200, cat: 'مواد غذائية', unit: 'كيلو' },
    { id: 'p_tea', name: 'شاي ليبتون ٤٥٠غ', sell: 10000, buy: 8000, qty: 25, cat: 'مشروبات', unit: 'علبة' },
    { id: 'p_low', name: 'معجون طماطم', sell: 4000, buy: 3000, qty: 2, cat: 'مواد غذائية', unit: 'علبة' },
  ];
  for (const p of products) {
    await put(`${u}/products/${p.id}`, {
      id: p.id, name: p.name, barcode: '', sellPrice: p.sell,
      quantity: p.qty, branchStock: { main: p.qty }, lowStockThreshold: 5,
      category: p.cat, unit: p.unit, createdAt: TODAY, hasWholesale: false,
    });
    await put(`${u}/product_costs/${p.id}`, { id: p.id, buyPrice: p.buy });
  }

  const customers = [
    { id: 'c_ali', name: 'علي العامري', phone: '07801112233', balance: 30000 },
    { id: 'c_omar', name: 'عمر الحديثي', phone: '07702223344', balance: 0 },
  ];
  for (const c of customers) {
    await put(`${u}/customers/${c.id}`, {
      id: c.id, name: c.name, phone: c.phone, address: '', notes: '',
      balance: c.balance, dueDate: '', createdAt: TODAY,
    });
    await put(`${u}/customers_public/${c.id}`, { name: c.name });
  }

  await put(`${u}/suppliers/s_jumla`, {
    id: 's_jumla', name: 'مورّد الجملة', phone: '07701112233', balance: 340000,
  });

  // فاتورة نقدية وأخرى بالدين — كي تُرى الشاشتان بحالتين
  await put(`${u}/invoices/inv_seed_1`, {
    id: 'inv_seed_1', invoiceNumber: '١٠٠٢', customerName: 'زبون نقدي',
    totalAmount: 57500, discount: 0, tax: 0, finalAmount: 57500,
    paidAmount: 57500, remainingAmount: 0,
    payments: [{ method: 'كاش', amount: 57500 }],
    date: TODAY, type: 'general', branchId: 'main', createdAt: Date.now(),
    items: [
      { productId: 'p_rice', name: 'رز عنبر', quantity: 2, price: 25000 },
      { productId: 'p_sugar', name: 'سكر', quantity: 5, price: 1500 },
    ],
  });
  await put(`${u}/invoices/inv_seed_2`, {
    id: 'inv_seed_2', invoiceNumber: '١٠٠٣', customerName: 'علي العامري', customerId: 'c_ali',
    totalAmount: 45000, discount: 0, tax: 0, finalAmount: 45000,
    paidAmount: 15000, remainingAmount: 30000,
    payments: [{ method: 'كاش', amount: 15000 }],
    date: TODAY, type: 'general', branchId: 'main', createdAt: Date.now(),
    items: [{ productId: 'p_oil', name: 'زيت دوار الشمس', quantity: 3, price: 15000 }],
  });

  await put(`${u}/financial_transactions/exp_seed`, {
    id: 'exp_seed', type: 'expense', amount: 25000, category: 'إيجار',
    // 🔴 `title` مطلوب: شاشة المصاريف كانت تسقط بغيابه (كُشف بالضغط الفعلي)
    title: 'إيجار المحل', description: 'إيجار المحل',
    date: TODAY, method: 'كاش', branchId: 'main',
  });

  console.log(`🏪 محل جاهز: ${products.length} أصناف · ${customers.length} زبائن · فاتورتان · مورّد · مصروف`);
  console.log(`   «معجون طماطم» كميته ٢ — تحت حدّ الأمان عمداً ليظهر تنبيه النواقص.`);
  console.log(`\n🌐 افتح http://localhost:3000 وسجّل الدخول بـ ${EMAIL} / ${PASSWORD}`);
}

main().catch((err) => { console.error('🔴', err.message); process.exit(1); });
