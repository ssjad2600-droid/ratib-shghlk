import { Product, ExpiryBatch } from '../types';

/**
 * محرّك الصلاحية — «بضاعة يفسدها الوقت» لا «صلاحية طعام» فقط.
 *
 * 🔴 الفكرة المركزية التي تجعله يخدم كل الأعمال بقاعدة واحدة:
 * لا رقم ثابت للتنبيه، بل **نسبة من عمر المادة نفسها**. عمر المادة معروف مجاناً من
 * تاريخَين نملكهما أصلاً: يوم الاستلام ويوم الانتهاء.
 *
 * رقم ثابت (٣٠ يوماً مثلاً) يصمت حيث يجب أن يصرخ ويصرخ حيث لا داعي:
 *   خبز (٥ أيام)   ⇒ لا ينبّه أبداً · دواء (٣ سنوات) ⇒ ينبّه بعد فوات الأوان
 * أما النسبة فتُنتج تلقائياً: خبز ⇒ يومان · حليب ⇒ ١٣ يوماً · دواء ⇒ ٦ أشهر.
 * قاعدة واحدة خدمت الأربعة، بلا «وضع بقالة» و«وضع صيدلية» يربكان المستخدم.
 *
 * 🔴 ومبدأ لا يُكسر: هذا السجل **لا يحسب مخزوناً أبداً**. المخزون يبقى مصدره الوحيد
 * (quantity / branchStock). الشحنة تُوثّق تاريخاً فقط، فيستحيل ظهور رقمين متعارضين.
 * والشطب يمرّ عبر «تسوية المخزون» القائمة — طريق واحد لكل شيء.
 */

/** نسبة العمر المتبقّية التي عندها يُنبَّه — مشتقّة من طبيعة البضاعة لا من رأي المستخدم. */
const ALERT_RATIO = 0.15;
/** حدّان يمنعان الطرفين المتطرّفين: الخبز لا ينبّه أصلاً، والدواء ينبّه قبل سنة بلا فائدة. */
const MIN_ALERT_DAYS = 2;
const MAX_ALERT_DAYS = 180;

const MS_DAY = 86_400_000;

/** تحويل مفتاح يوم (YYYY-MM-DD) إلى تاريخ محلي عند منتصف الليل — لا UTC. */
export function parseDayKey(key: string): Date | null {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

/** فرق الأيام بين مفتاحَي يوم (موجب = الثاني أحدث). */
export function daysBetweenKeys(fromKey: string, toKey: string): number | null {
  const a = parseDayKey(fromKey);
  const b = parseDayKey(toKey);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / MS_DAY);
}

/** عمر المادة بالأيام: من الاستلام إلى الانتهاء. غياب تاريخ الاستلام ⇒ غير معروف. */
export function shelfLifeDays(batch: Pick<ExpiryBatch, 'receivedDate' | 'expiryDate'>): number | null {
  const life = daysBetweenKeys(batch.receivedDate, batch.expiryDate);
  return life !== null && life > 0 ? life : null;
}

export interface AlertSource {
  days: number;
  /** من أين جاء الرقم — يُعرض للمستخدم ليفهم لماذا نُبّه ولا يشكّ في البرنامج */
  origin: 'product' | 'category' | 'auto' | 'default';
}

/**
 * كم يوماً قبل الانتهاء يبدأ التنبيه لهذه الشحنة.
 * الأولوية: تجاوز المادة ← تجاوز الفئة ← الحساب التلقائي من العمر ← افتراضي احتياطي.
 */
export function alertDaysFor(
  batch: Pick<ExpiryBatch, 'receivedDate' | 'expiryDate'>,
  product?: Pick<Product, 'expiryAlertDays' | 'category'> | null,
  categoryAlertDays?: Record<string, number>,
): AlertSource {
  const perProduct = product?.expiryAlertDays;
  if (typeof perProduct === 'number' && perProduct > 0) return { days: perProduct, origin: 'product' };

  const cat = product?.category?.trim();
  const perCategory = cat ? categoryAlertDays?.[cat] : undefined;
  if (typeof perCategory === 'number' && perCategory > 0) return { days: perCategory, origin: 'category' };

  const life = shelfLifeDays(batch);
  if (life !== null) {
    const auto = Math.round(life * ALERT_RATIO);
    return { days: Math.min(MAX_ALERT_DAYS, Math.max(MIN_ALERT_DAYS, auto)), origin: 'auto' };
  }

  // بلا تاريخ استلام لا يُعرف العمر — نستعمل ٣٠ يوماً كاحتياط معلن لا كقاعدة
  return { days: 30, origin: 'default' };
}

/** حالات العرض الأربع — بترتيب الخطورة. */
export type ExpiryStage = 'expired' | 'act' | 'watch' | 'ok';

export const STAGE_LABEL: Record<ExpiryStage, string> = {
  expired: 'منتهية',
  act: 'صرّفها الآن',
  watch: 'راقبها',
  ok: 'سليمة',
};

export interface ExpiryStatus {
  stage: ExpiryStage;
  daysLeft: number;          // سالب = انتهت منذ كذا يوماً
  lifeDays: number | null;   // عمر المادة الكامل (لعرض «بقي ١٢ من أصل ٩٠»)
  alert: AlertSource;
}

/**
 * حالة الشحنة اليوم.
 * «صرّفها الآن» عند بلوغ حدّ التنبيه، و«راقبها» عند ضعفه — تدرّج مفهوم بلا نسب معقّدة،
 * ومع ذلك يتكيّف تلقائياً مع كل مدى عمر لأن حدّ التنبيه نفسه مشتقّ من العمر.
 */
export function expiryStatus(
  batch: Pick<ExpiryBatch, 'receivedDate' | 'expiryDate'>,
  todayKey: string,
  product?: Pick<Product, 'expiryAlertDays' | 'category'> | null,
  categoryAlertDays?: Record<string, number>,
): ExpiryStatus {
  const alert = alertDaysFor(batch, product, categoryAlertDays);
  const daysLeft = daysBetweenKeys(todayKey, batch.expiryDate) ?? 0;
  const lifeDays = shelfLifeDays(batch);

  let stage: ExpiryStage;
  if (daysLeft < 0) stage = 'expired';
  else if (daysLeft <= alert.days) stage = 'act';
  else if (daysLeft <= alert.days * 2) stage = 'watch';
  else stage = 'ok';

  return { stage, daysLeft, lifeDays, alert };
}

/** ترتيب العرض: الأخطر أولاً، ثم الأقرب انتهاءً. */
export const STAGE_ORDER: Record<ExpiryStage, number> = { expired: 0, act: 1, watch: 2, ok: 3 };

export interface BatchRow {
  batch: ExpiryBatch;
  product?: Product;
  status: ExpiryStatus;
  /** قيمة الشحنة بسعر الشراء — الرقم الذي يُحرّك التاجر. صفر إن كانت التكلفة مجهولة. */
  value: number;
  costKnown: boolean;
  /** الكمية المتبقّية فعلاً من هذه الشحنة (مشتقّة من المخزون الحيّ لا من كمية التسجيل). */
  liveQuantity: number;
  /** بِيع من هذه الشحنة فنقصت عن كميتها المسجَّلة. */
  partiallySold: boolean;
}

/**
 * 🔴 توزيع المخزون الحيّ على شحنات المنتج — الأقدم يُستهلك أولاً.
 *
 * كمية الشحنة تُسجَّل يوم الاستلام و**لا تنقص بالبيع أبداً** (وهذا صحيح: السجل يوثّق
 * استلاماً لا مخزوناً). لكن حساب «بضاعة على الخطر» كان يضربها في التكلفة كما هي، فشحنة
 * ٥٠ علبة بِيع منها ٤٥ تبقى تُحسب ٥٠. والتوثيق يسمّي هذا «الرقم الذي يُحرّك التاجر» —
 * فيرى خطراً بمليون دينار ويخصم أسعار بضاعة لم تعد عنده.
 *
 * والمفارقة أن الشطب كان يعرف الحقيقة (`Math.min(batch.quantity, stock)`) والعرض لا.
 *
 * القسمة تفترض **بيع الأقدم أولاً** — وهو ما يجب أن يحدث فعلاً، وما تذكّر به الشاشة
 * نفسها. فالمخزون المتبقّي يُنسب للشحنات الأحدث، والأقدم تُستنزف أولاً.
 *
 * @param batches شحنات **منتج واحد في فرع واحد**، نشطة فقط
 * @param availableStock رصيد ذلك المنتج في ذلك الفرع
 */
export function liveBatchQuantities(
  batches: Pick<ExpiryBatch, 'id' | 'expiryDate' | 'quantity'>[],
  availableStock: number,
): Map<string, number> {
  const out = new Map<string, number>();
  // من الأحدث انتهاءً إلى الأقدم: ما بقي من مخزون يخصّ الأحدث لأن الأقدم بِيع أولاً
  const newestFirst = [...batches].sort((a, b) => b.expiryDate.localeCompare(a.expiryDate));
  let remaining = Math.max(0, availableStock);
  for (const b of newestFirst) {
    const registered = Math.max(0, b.quantity || 0);
    const live = Math.min(registered, remaining);
    out.set(b.id, live);
    remaining -= live;
  }
  return out;
}

/**
 * يبني صفوف العرض مرتّبة. الشحنات المشطوبة تُستبعد — أثرها انتقل إلى تسوية المخزون.
 */
export function buildBatchRows(
  batches: ExpiryBatch[],
  products: Product[],
  buyPriceOf: (p: Product) => number | undefined,
  todayKey: string,
  categoryAlertDays?: Record<string, number>,
  /** رصيد المنتج في فرع الشحنة — بدونه تُعرض الكمية المسجَّلة كما كانت (توافق رجعي). */
  stockOfProduct?: (productId: string, branchId?: string) => number,
): BatchRow[] {
  const byId = new Map(products.map(p => [p.id, p]));
  const active = batches.filter(b => b.status === 'active');

  /**
   * الكمية الحيّة لكل شحنة — تُحسب لكل (منتج، فرع) على حدة لأن المخزون يخصّ فرعاً.
   * بلا `stockOfProduct` نُبقي الكمية المسجَّلة كما هي (لا نخمّن نقصاً لا نعرفه).
   */
  const liveById = new Map<string, number>();
  if (stockOfProduct) {
    const groups = new Map<string, ExpiryBatch[]>();
    for (const b of active) {
      const key = `${b.productId}|${b.branchId ?? ''}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
    }
    for (const [key, list] of groups) {
      const [productId, branchId] = key.split('|');
      const allocated = liveBatchQuantities(list, stockOfProduct(productId, branchId || undefined));
      for (const [id, qty] of allocated) liveById.set(id, qty);
    }
  }

  return active
    .map(b => {
      const product = byId.get(b.productId);
      const status = expiryStatus(b, todayKey, product, categoryAlertDays);
      const cost = product ? buyPriceOf(product) : undefined;
      const registered = Math.max(0, b.quantity || 0);
      const liveQuantity = liveById.has(b.id) ? liveById.get(b.id)! : registered;
      return {
        batch: b,
        product,
        status,
        // 🔴 القيمة على الكمية **الحيّة** لا المسجَّلة — وإلا حُسبت بضاعة بِيعت خطراً قائماً
        value: cost !== undefined ? cost * liveQuantity : 0,
        costKnown: cost !== undefined,
        liveQuantity,
        partiallySold: liveQuantity < registered,
      };
    })
    .sort((a, b) => {
      const s = STAGE_ORDER[a.status.stage] - STAGE_ORDER[b.status.stage];
      return s !== 0 ? s : a.status.daysLeft - b.status.daysLeft;
    });
}

/**
 * الشحنات المنتهية منذ زمن طويل — تُطوى عن العدّادات كي لا تفقد معناها.
 * شحنة انتهت قبل سنتين ولم تُشطب كانت تبقى في «منتهية» إلى الأبد، فالعدّاد ينمو ولا ينقص.
 */
export const STALE_EXPIRED_DAYS = 60;
export const isStaleExpired = (row: Pick<BatchRow, 'status'>): boolean =>
  row.status.stage === 'expired' && row.status.daysLeft < -STALE_EXPIRED_DAYS;

/** ملخّص للوحة الرئيسية: كم مادة على الخطر وكم ديناراً. */
export function expirySummary(rows: BatchRow[]) {
  // الشحنات التي نفدت فعلاً (رصيدها صفر) لا خطر فيها — بِيعت أو شُطبت
  const live = rows.filter(r => r.liveQuantity > 0 && !isStaleExpired(r));
  const atRisk = live.filter(r => r.status.stage === 'expired' || r.status.stage === 'act');
  return {
    expiredCount: live.filter(r => r.status.stage === 'expired').length,
    actCount: live.filter(r => r.status.stage === 'act').length,
    watchCount: live.filter(r => r.status.stage === 'watch').length,
    okCount: live.filter(r => r.status.stage === 'ok').length,
    atRiskValue: atRisk.reduce((s, r) => s + r.value, 0),
    atRiskCount: atRisk.length,
    unknownCostCount: atRisk.filter(r => !r.costKnown).length,
    /** شحنات نفد رصيدها — تُعرض للعلم لا كخطر. */
    soldOutCount: rows.filter(r => r.liveQuantity <= 0).length,
    /** منتهية منذ أكثر من شهرين — مطويّة عن العدّادات. */
    staleCount: rows.filter(isStaleExpired).length,
  };
}

/**
 * الشحنة الأقدم انتهاءً لمنتج — تذكير «بِع بالأقدم أولاً» عند البيع.
 * تذكير لا إجبار: البائع أحياناً يعرف ما لا يعرفه البرنامج.
 */
export function oldestActiveBatch(batches: ExpiryBatch[], productId: string): ExpiryBatch | undefined {
  return batches
    .filter(b => b.productId === productId && b.status === 'active')
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))[0];
}

/** هل يتتبّع هذا المنتج الصلاحية؟ يتعلّمها البرنامج من فعل المستخدم لا باستجوابه. */
export const tracksExpiry = (p?: Pick<Product, 'tracksExpiry'> | null): boolean => p?.tracksExpiry === true;
