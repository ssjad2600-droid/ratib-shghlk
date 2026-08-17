import { BACKUP_COLLECTIONS } from './backupCollections';
import { toArabicDigits } from './arabicFormatters';

/**
 * تخطيط الاستعادة — منطق نقيّ مفصول عن Firestore، لأن أخطر ما في هذه الشاشة ليس
 * الكتابة بل **ما يُقال عنها**.
 *
 * 🔴 ثلاث علل يُغلقها هذا الملف:
 *
 *  ١) **الاستعادة ليست ذرّية والفشل الجزئي لا يُقال.** عشرة آلاف وثيقة = عشرون دفعة
 *     متتالية. تنقطع الشبكة عند الثامنة ⟵ ثماني دفعات كُتبت واثنتا عشرة لا، والرسالة
 *     الوحيدة «حدث خطأ أثناء تهيئة البيانات» بلا ذكر أن **جزءاً كُتب فعلاً**. فتصير
 *     قاعدة بياناته خليطاً بين نسختين لا يعرف حدوده — والاستعادة النصفية أسوأ من عدمها.
 *
 *  ٢) **بلا مؤشّر تقدّم.** الشاشة ساكنة دقائق فيظنّها معلّقة **فيضغط ثانيةً** ⟵ استعادة
 *     موازية.
 *
 *  ٣) **رسالة النجاح تناقض تحذير الشاشة نفسها**: تحذيرٌ دقيق يقول «الاستعادة تكتب فوق
 *     الحالية ولا تحذف ما أُنشئ بعدها»، ثم «تم استعادة كافة حساباتك **بالكامل** ✅»
 *     تمحوه من ذهن القارئ. الدمج ليس استعادةً كاملة، والرسالة يجب أن تقول ما جرى.
 */

export interface RestoreOp {
  collName: string;
  item: Record<string, unknown> & { id: string };
}

export interface RestorePlan {
  ops: RestoreOp[];
  /** وثائق بلا معرّف — تُعدّ وتُقال بدل التخطّي الصامت */
  skipped: Record<string, number>;
  skippedTotal: number;
  /** عدد الدفعات التي ستُكتب (٥٠٠ لكل دفعة) */
  chunks: number;
}

export const CHUNK_SIZE = 500;

/** يبني خطّة الكتابة من محتوى ملف النسخة — بلا أي اتصال. */
export function planRestore(data: Record<string, string>): RestorePlan {
  const ops: RestoreOp[] = [];
  const skipped: Record<string, number> = {};

  for (const [key, collName] of Object.entries(BACKUP_COLLECTIONS)) {
    if (!data[key]) continue;
    let items: unknown;
    try { items = JSON.parse(data[key]); } catch { continue; }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && (item as { id: string }).id) {
        ops.push({ collName, item: item as RestoreOp['item'] });
      } else {
        skipped[collName] = (skipped[collName] ?? 0) + 1;
      }
    }
  }

  const skippedTotal = Object.values(skipped).reduce((s, n) => s + n, 0);
  return { ops, skipped, skippedTotal, chunks: Math.ceil(ops.length / CHUNK_SIZE) };
}

/** يقسّم العمليات إلى دفعات بحجم Firestore الأقصى. */
export function chunkOps(ops: RestoreOp[], size: number = CHUNK_SIZE): RestoreOp[][] {
  const out: RestoreOp[][] = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */

export interface RestoreOutcome {
  /** دفعات كُتبت فعلاً */
  chunksDone: number;
  chunksTotal: number;
  /** وثائق كُتبت فعلاً */
  docsDone: number;
  docsTotal: number;
  skippedTotal: number;
  skipped: Record<string, number>;
  failed: boolean;
  /** فشلت الإعدادات وحدها (لا يُفشل الاستعادة لكنه يُقال) */
  settingsFailed: boolean;
}

/**
 * رسالة النتيجة — تقول **ما جرى** لا ما نتمنّاه.
 * والفشل الجزئي يذكر كم كُتب وكم بقي، وأن قاعدة البيانات صارت خليطاً يحتاج إعادة.
 */
export function restoreMessage(r: RestoreOutcome): { text: string; bad: boolean } {
  const n = (v: number) => toArabicDigits(v);

  if (r.failed) {
    return {
      bad: true,
      text: r.docsDone > 0
        ? `انقطعت الاستعادة بعد كتابة ${n(r.docsDone)} من ${n(r.docsTotal)} وثيقة `
          + `(${n(r.chunksDone)} دفعة من ${n(r.chunksTotal)}). `
          + '⚠️ بياناتك الآن **خليط** بين النسخة والحالي — أعد الاستعادة بنفس الملف بعد عودة الاتصال '
          + 'لتكتمل، ولا تعتمد الأرقام قبل ذلك.'
        : 'تعذّرت الاستعادة ولم تُكتب أي وثيقة — بياناتك كما كانت تماماً. تحقّق من الاتصال وأعد المحاولة.',
    };
  }

  const parts = [`اكتملت الاستعادة: كُتبت ${n(r.docsDone)} وثيقة`];
  if (r.skippedTotal > 0) {
    const detail = Object.entries(r.skipped).map(([c, v]) => `${c}: ${n(v)}`).join('، ');
    parts.push(`وتُخطّيت ${n(r.skippedTotal)} وثيقة بلا معرّف (${detail}) — الملف قديم أو ناقص`);
  }
  if (r.settingsFailed) parts.push('وتعذّرت استعادة الإعدادات (سعر الصرف والعملة) فبقيت كما هي');
  // 🔴 لا نقول «بالكامل»: الاستعادة **دمج** فوق الحالي ولا تحذف ما أُنشئ بعد النسخة
  parts.push('البيانات الأحدث من تاريخ النسخة لم تُحذف — راجع الأرصدة والكميات إن كنت قد عملت بعدها');

  return { text: parts.join('. ') + '.', bad: r.skippedTotal > 0 || r.settingsFailed };
}

/** وصفٌ لمصدر النسخة يُعرض قبل الاستعادة — الملف يحمل وسمه منذ بنائه. */
export function sourceWarning(metaSource?: string): string | null {
  return metaSource === 'cache'
    ? '⚠️ هذه النسخة بُنيت من الذاكرة المحلية للجهاز (بلا اتصال بالخادم) وقد تكون **ناقصة**. '
      + 'راجع الأعداد أدناه قبل الاستعادة.'
    : null;
}
