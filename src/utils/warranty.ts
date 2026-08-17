import { Invoice } from '../types';
import { localDateKey } from './dateLocal';

/**
 * الضمان والأرقام التسلسلية (Serial / IMEI) — مصدر موحّد للحساب والبحث.
 * التصميم: السيريال ومدة الضمان لقطة على **سطر الفاتورة** لحظة البيع، فلا يوجد مخزون موازٍ
 * بالوحدة ولا مصدرا حقيقة متعارضان مع product.quantity (أخطر عيوب أنظمة السيريال).
 */

/** توحيد شكل السيريال للمطابقة: أحرف كبيرة، بلا مسافات/شرطات، وأرقام لاتينية. */
export const normalizeSerial = (raw: string): string => {
  const arDigits = '٠١٢٣٤٥٦٧٨٩';
  return String(raw ?? '')
    .replace(/[٠-٩]/g, (d) => String(arDigits.indexOf(d)))
    .replace(/[\s\-_/\\.]/g, '')
    .toUpperCase()
    .trim();
};

/** تحليل 'yyyy-mm-dd' (أو أي صيغة مخزَّنة) إلى Date محلي بلا انزياح UTC. */
const parseLocalDate = (dateStr: string): Date | null => {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

export interface WarrantyStatus {
  hasWarranty: boolean;   // هل سُجّلت مدة ضمان أصلاً؟
  active: boolean;        // هل الضمان ما زال سارياً اليوم؟
  expiryKey: string;      // 'yyyy-mm-dd' لتاريخ انتهاء الضمان ('' إن لا ضمان)
  daysLeft: number;       // أيام متبقية (سالب = منقضٍ منذ كذا يوماً)
  monthsCovered: number;
}

/**
 * حالة الضمان لبيع مؤرَّخ saleDate بمدة months.
 * الحساب بالتقويم (إضافة أشهر) لا بعدد أيام تقريبي — فـ«١٢ شهر» تنتهي بنفس اليوم من العام التالي.
 */
export function warrantyStatus(saleDate: string, months?: number, today?: string): WarrantyStatus {
  const empty: WarrantyStatus = { hasWarranty: false, active: false, expiryKey: '', daysLeft: 0, monthsCovered: 0 };
  if (!months || months <= 0) return empty;
  const start = parseLocalDate(saleDate);
  if (!start) return empty;

  const expiry = new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
  // تصحيح انزلاق الشهر (٣١ يناير + شهر ⇒ ٣ مارس): نرجع لآخر يوم في الشهر المقصود
  if (expiry.getDate() !== start.getDate()) expiry.setDate(0);

  // «اليوم» وسيط اختياري كما في planStatus وisDueWithin — يجعل انتهاء الضمان قابلاً
  // للاختبار حتمياً بدل الاعتماد على ساعة الجهاز.
  const now = (today ? parseLocalDate(today) : null) ?? new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round((expiry.getTime() - todayMid.getTime()) / 86_400_000);

  return {
    hasWarranty: true,
    active: daysLeft >= 0,
    expiryKey: localDateKey(expiry),
    daysLeft,
    monthsCovered: months,
  };
}

export interface SerialHit {
  serial: string;          // السيريال كما أُدخل (للعرض)
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  saleDate: string;
  productName: string;
  unitPrice: number;
  soldByName: string;      // مَن باعه (مالك/موظف)
  warranty: WarrantyStatus;
}

/**
 * البحث عن سيريال داخل كل الفواتير. يُرجع كل المطابقات (الأحدث أولاً) —
 * وجود أكثر من مطابقة يعني تكرار إدخال أو محاولة احتيال، فيُنبَّه المستخدم.
 */
export function findSerial(invoices: Invoice[], query: string, today?: string): SerialHit[] {
  const q = normalizeSerial(query);
  if (!q) return [];
  const hits: SerialHit[] = [];
  for (const inv of invoices) {
    for (const item of inv.items ?? []) {
      for (const s of item.serials ?? []) {
        if (normalizeSerial(s) !== q) continue;
        hits.push({
          serial: s,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customerName: inv.customerName,
          saleDate: inv.date,
          productName: item.unitLabel ? `${item.name} - ${item.unitLabel}` : item.name,
          unitPrice: item.price,
          soldByName: inv.createdByName?.trim() || 'صاحب المحل',
          warranty: warrantyStatus(inv.date, item.warrantyMonths, today),
        });
      }
    }
  }
  return hits.sort((a, b) => b.saleDate.localeCompare(a.saleDate));
}

type ItemsOnly = { items?: Array<{ serials?: string[] }> };

/** مفاتيح السيريالات المُوحَّدة داخل فاتورة (أو أي مجموعة سطور). */
export function serialKeysOf(source: ItemsOnly | Array<{ serials?: string[] }>): Set<string> {
  const items = Array.isArray(source) ? source : (source.items ?? []);
  const out = new Set<string>();
  for (const item of items) {
    for (const s of item.serials ?? []) {
      const k = normalizeSerial(s);
      if (k) out.add(k);
    }
  }
  return out;
}

/**
 * 🔴 السيريالات التي **اختفت** من الفاتورة — يجب حذف مرآتها.
 *
 * مرآة الضمان (`warranty_index`) كانت تُكتب ولا تُحذف أبداً. فالزبون يُرجع الجهاز ويأخذ
 * نقوده، ثم يعود بعد شهرين فيبحث **الموظف** في المرآة فيجد «الضمان فعّال» ويستبدل الجهاز
 * مجاناً — بينما يبحث **المالك** في الفواتير فلا يجد شيئاً. جوابان متناقضان لنفس الجهاز،
 * والخسارة تقع لأن الموظف على الكاونتر يجيب أولاً.
 *
 * يُستعمل في المسارات الثلاثة التي تُنقص سيريالاً: الحذف، والإرجاع، وتعديل الفاتورة.
 */
export function removedSerialKeys(
  before: ItemsOnly | Array<{ serials?: string[] }>,
  after: ItemsOnly | Array<{ serials?: string[] }> | null,
): string[] {
  const kept = after ? serialKeysOf(after) : new Set<string>();
  return [...serialKeysOf(before)].filter(k => !kept.has(k));
}

/** كل السيريالات المسجَّلة (لكشف التكرار عند الإدخال). Map: سيريال مُوحَّد → عدد مرات البيع. */
export function serialSaleCounts(invoices: Invoice[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const inv of invoices) {
    for (const item of inv.items ?? []) {
      for (const s of item.serials ?? []) {
        const k = normalizeSerial(s);
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  return counts;
}
