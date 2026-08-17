import { formatCurrency, toArabicDigits, toLatinDigits } from './arabicFormatters';

/**
 * تطبيع رقم هاتف عراقي إلى صيغة wa.me الدولية (أرقام فقط، بلا + أو 00 أو صفر بادئ).
 * يتعامل مع الأرقام العربية-الهندية وصيغ الإدخال الشائعة:
 *   07901234567  → 9647901234567   (صفر بادئ محلي)
 *   +9647901234567 / 009647... → 9647901234567
 *   7901234567   → 9647901234567   (بلا صفر بادئ)
 * يُرجع '' إذا تعذّر تكوين رقم معقول (لا نفتح واتساب برقم فاسد).
 */
export function toWhatsappNumber(raw: string): string {
  // toLatinDigits يغطّي العربية-الهندية والفارسية معاً — نفس التطبيع المستعمل في كل
  // البرنامج، بدل نسخة محلية تعرف العربية وحدها.
  let d = toLatinDigits(raw).replace(/[^0-9]/g, '');
  if (!d) return '';

  if (d.startsWith('00964')) d = d.slice(2);            // 00964... → 964...
  else if (d.startsWith('964')) { /* صيغة دولية سليمة */ }
  else if (d.startsWith('0')) d = '964' + d.slice(1);   // 07XX... → 9647XX...
  else if (d[0] === '7' && d.length >= 9 && d.length <= 10) d = '964' + d; // 7XXXXXXXXX

  // رقم عراقي دولي سليم = 964 + 10 أرقام (يبدأ الجوّال بـ 7) = 13 خانة
  return d.length >= 11 && d.length <= 14 ? d : '';
}

/** هل يمكن بناء رابط واتساب صالح من هذا الرقم؟ */
export function canWhatsapp(raw: string): boolean {
  return toWhatsappNumber(raw) !== '';
}

interface DebtReminderParams {
  customerName: string;
  phone: string;
  balance: number;
  storeName: string;
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  dueDate?: string;
}

/**
 * يبني رابط wa.me برسالة تذكير دين عربية مهذّبة جاهزة للإرسال (المالك يضغط إرسال بنفسه).
 * يُرجع '' إذا كان الرقم غير صالح.
 */
export function buildDebtReminderUrl({
  customerName, phone, balance, storeName, currency, exchangeRate, dueDate,
}: DebtReminderParams): string {
  const num = toWhatsappNumber(phone);
  if (!num) return '';

  const amount = formatCurrency(balance, currency, exchangeRate);
  const store = storeName?.trim() || 'محلّنا';
  const name = customerName?.trim() || 'الزبون العزيز';

  const lines = [
    `السلام عليكم ${name} 🌷`,
    '',
    `نودّ تذكيركم بلطف بأنّ بذمّتكم مبلغ ${amount} لـ ${store}.`,
  ];
  if (dueDate && dueDate.trim()) {
    lines.push(`تاريخ الاستحقاق: ${dueDate.trim()}`);
  }
  lines.push('', 'نرجو تسديده في أقرب وقت ممكن، وشكراً لثقتكم وتعاملكم معنا 🌹');

  return `https://wa.me/${num}?text=${encodeURIComponent(lines.join('\n'))}`;
}

interface StatementParams {
  customerName: string;
  balance: number;
  storeName?: string;
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  dueDate?: string;
}

/**
 * نصّ **كشف الحساب** — يغطّي الحالات الثلاث: عليه دَين، أو له أمانة، أو حسابه مصفّى.
 *
 * 🔴 لماذا هنا لا داخل الشاشة؟ كانت شاشة الزبائن تبني نصّها بنفسها بينما «الديون»
 * و«الأقساط» تستعملان `buildDebtReminderUrl`. فالزبون الواحد يستلم صياغتين مختلفتين
 * حسب الشاشة التي ضغط منها التاجر — ازدواج مصدرٍ في الكلام كالازدواج في الأرقام،
 * وأثره على انطباع الاحتراف مباشر لأنّ الزبون هو من يقرأه.
 *
 * الكشف والتذكير فعلان مختلفان (إخبارٌ مقابل مطالبة)، لكنهما الآن في ملف واحد بنبرة
 * واحدة: تحية، ثم الرقم، ثم شكر.
 */
export function buildStatementText({
  customerName, balance, storeName, currency, exchangeRate, dueDate,
}: StatementParams): string {
  const store = storeName?.trim() || 'محلّنا';
  const name = customerName?.trim() || 'الزبون العزيز';
  const lines = [`السلام عليكم ${name} 🌷`, '', `كشف حسابكم لدى ${store}:`, ''];

  if (balance > 0) {
    lines.push(`🔴 المبلغ المستحق عليكم: *${formatCurrency(balance, currency, exchangeRate)}*`);
    if (dueDate?.trim()) lines.push(`📅 موعد السداد: ${toArabicDigits(dueDate.trim())}`);
  } else if (balance < 0) {
    lines.push(`🟢 لكم عندنا أمانة: *${formatCurrency(Math.abs(balance), currency, exchangeRate)}*`);
    lines.push('سنسلّمكم المبلغ في أقرب وقت.');
  } else {
    lines.push('✅ حسابكم مصفّى بالكامل — لا يوجد أي مبلغ مستحق.');
  }

  lines.push('', 'شكراً لثقتكم وتعاملكم معنا 🌹');
  return lines.join('\n');
}

/** رابط wa.me لكشف الحساب. يُرجع '' إذا كان الرقم غير صالح. */
export function buildStatementUrl(phone: string, params: StatementParams): string {
  const num = toWhatsappNumber(phone);
  if (!num) return '';
  return `https://wa.me/${num}?text=${encodeURIComponent(buildStatementText(params))}`;
}
