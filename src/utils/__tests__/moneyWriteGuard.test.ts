import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 🔴 حارس الكتابة على حقول المال.
 *
 * ظهرت هذه العلّة **أربع مرات** في أربع شاشات مختلفة قبل أن نضع هذا الحارس:
 *   · رصيد الزبون في شاشة الزبائن
 *   · متبقّي الفاتورة في تسديد الديون
 *   · متبقّي فاتورة المورد في آجل الموردين
 *   · متبقّي الفاتورة في تسديد الأقساط
 *
 * وهي لا تُصدر خطأً ولا تظهر في أي شاشة: الرقم يُكتب، والبرنامج يعمل، والانحراف يظهر
 * بعد أسابيع حين يقول الرصيد شيئاً وتقول الفاتورة شيئاً آخر. أصلحناها ثلاثاً واحدةً
 * واحدة، ثم عادت رابعةً — فلم تعد خطأً متفرّقاً بل **نمطاً** يلزمه ما يمنعه.
 *
 * القاعدة: **لا تُستبدل وثيقة مالية بأكملها من لقطة محلية.** الكتابة على حقل مالي في
 * وثيقة قائمة تكون بـ`increment` (أو ببذرة صريحة مرة واحدة عبر `invoicePaymentUpdate`).
 *
 * ⚠️ لا يفحص هذا الحارس **إنشاء** وثيقة جديدة — هناك القيمة المطلقة هي الصحيحة، ولا
 *   وثيقة سابقة تُمحى.
 */

const COMPONENTS = join(process.cwd(), 'src', 'components');

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const componentFiles = () => readdirSync(COMPONENTS).filter(n => n.endsWith('.tsx'));

describe('حارس: لا استبدال لوثيقة مالية من لقطة محلية', () => {
  it('المسح يرى الشاشات فعلاً (حماية من فحص فارغ يمرّ كذباً)', () => {
    const files = componentFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('InstallmentsView.tsx');
    expect(files).toContain('DebtView.tsx');
  });

  /**
   * `saveX({ ...doc, … })` حيث `save` من `useCollection` هي `setDoc` — أي استبدال
   * الوثيقة **بأكملها**. فأي تغيير حدث عليها من جهاز آخر أو شاشة أخرى بين التحميل
   * والحفظ يُمحى كلّه: أصناف، تسديدات، مرتجعات.
   */
  it('🔴 لا `saveX({ ...` — استبدال كامل لوثيقة تحمل رصيداً أو مخزوناً', () => {
    const offenders: string[] = [];
    for (const f of componentFiles()) {
      const src = stripComments(readFileSync(join(COMPONENTS, f), 'utf8'));
      // 🔴 `Product` من العائلة نفسها: المخزون مالٌ، واستبدال وثيقة المنتج من لقطة
      //   محلية يُرجع بضاعةً بيعت بين تحميل الشاشة وضغط الحفظ. أُضيفت بعد أن أفلتت
      //   منّي ثلاث علل في شاشة المنتجات لأن الحارس كان يعرف الفواتير والزبائن فقط.
      const re = /\bsave(Invoice|Customer|Supplier|Payment|Product)\s*\(\s*\{\s*\.\.\./g;
      const hits = src.match(re) ?? [];
      if (hits.length) offenders.push(`${f}: ${hits.join('، ')}`);
    }
    expect(
      offenders,
      'استبدال وثيقة بأكملها من لقطة محلية يمحو كل تغيير حدث عليها. '
      + 'استعمل batch.update بحقول صريحة مع increment (أو invoicePaymentUpdate/stockUpdateSeeded): '
      + offenders.join(' | '),
    ).toEqual([]);
  });

  /**
   * 🔴 وثيقة المنتج لا تُستبدل بـ`set` بلا دمج.
   *
   * `batch.set(ref, obj)` استبدالٌ كامل: أي حقل غائب عن `obj` يُحذف. وهكذا محا الاستيراد
   * الجماعي خريطة `branchStock` كلها فعادت بضاعة المخزن إلى المحل في السجلات — وكان
   * الملف مستورداً لتصحيح أسعار لا لنقل بضاعة.
   */
  it('🔴 الكتابة على وثيقة منتج قائم بالدمج أو بحقول صريحة', () => {
    const offenders: string[] = [];
    for (const f of componentFiles()) {
      const src = stripComments(readFileSync(join(COMPONENTS, f), 'utf8'));
      /**
       * ⚠️ لا يصلح تعبير نمطي واحد هنا: الحمولة قد تكون كائناً فيه فواصل
       * (`{ ...existing, ...fields }`) فيتوقّف أي `[^,)]` قبلها. أول صياغة لهذا الحارس
       * وقعت في هذا بالضبط ومرّت على أخطر صورة للعلّة. فنمسح بالفهرس حتى `);`.
       */
      const starts = /batch\.set\(\s*(?:productRef|doc\([^)]*'products'[^)]*\))\s*,/g;
      let m: RegExpExecArray | null;
      while ((m = starts.exec(src)) !== null) {
        const end = src.indexOf(');', m.index);
        const call = src.slice(m.index, end === -1 ? m.index + 200 : end + 2);
        const payload = call.slice(m[0].length).trim().replace(/\)\s*;?$/, '').trim();
        if (/merge:\s*true/.test(call)) continue;           // دمج صريح — سليم
        if (/branchStock/.test(payload)) continue;          // كائن حرفي يحمل الخريطة كاملةً
        /**
         * ⚠️ إنشاء منتج **جديد** بـ`set` صحيح — لا وثيقة سابقة تُمحى. نميّزه بأن الكائن
         * المُمرَّر مُعرَّف في نفس الملف ويحمل `branchStock` في تعريفه. وبلا هذا التمييز
         * كان الحارس ينبّه على مسار سليم — وحارسٌ ينبّه كذباً يُدرَّب المرء على تجاهله.
         */
        if (/^[A-Za-z_$][\w$]*$/.test(payload)) {
          const defAt = src.search(new RegExp(`\\b(?:const|let)\\s+${payload}\\b`));
          if (defAt !== -1 && /branchStock/.test(src.slice(defAt, defAt + 900))) continue;
        }
        offenders.push(`${f}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      'set بلا دمج على وثيقة منتج يمحو الحقول الغائبة — أخطرها branchStock: '
      + offenders.join(' | '),
    ).toEqual([]);
  });

  /**
   * تسديد الديون وتسديد الأقساط مساران لنفس الفعل. حين كانا منفصلين تباعدا: أحدهما
   * يحترم سقف الفاتورة والآخر لا، وأحدهما يستنتج المدفوع صحيحاً والآخر يضاعفه.
   */
  it('🔴 كل شاشة تسدّد ديناً تمرّ عبر `debtAllocation` — لا مسار ثانٍ', () => {
    const payingScreens = ['DebtView.tsx', 'InstallmentsView.tsx'];
    const missing = payingScreens.filter(f => {
      const src = readFileSync(join(COMPONENTS, f), 'utf8');
      return !src.includes("utils/debtAllocation");
    });
    expect(
      missing,
      'شاشة تسدّد ديناً بمنطق خاص بها ⇒ ستتباعد عن الأخرى مع الوقت: ' + missing.join('، '),
    ).toEqual([]);
  });

  /**
   * الحقل `method` هو ما يفصل النقد في الدرج عن المحصَّل إلكترونياً في تقفيل الصندوق.
   * غيابه يعني «كاش» (توافق رجعي)، فشاشةٌ تنسى كتابته تُضخّم نقد الدرج بصمت.
   */
  it('🔴 كل شاشة تحفظ تسديداً تكتب طريقة الدفع', () => {
    const offenders: string[] = [];
    for (const f of componentFiles()) {
      const src = stripComments(readFileSync(join(COMPONENTS, f), 'utf8'));
      if (!/savePayment\s*\(/.test(src)) continue;
      if (!/method:\s*\w/.test(src)) offenders.push(f);
    }
    expect(
      offenders,
      'تسديد بلا `method` يُحسب كاشاً في الدرج ولو سُدِّد ببطاقة، فيظهر عجز عند العدّ: '
      + offenders.join('، '),
    ).toEqual([]);
  });

  /**
   * سجل التدقيق بلا معرّف حقيقي لا يُفضي إلى شيء — فيبطل الغرض الذي وُجد لأجله.
   * `Date.now()` داخل `entityId` يعني معرّفاً مخترعاً لا يطابق أي وثيقة محفوظة.
   */
  it('🔴 معرّف سجل التدقيق ليس رقماً مخترعاً من الوقت', () => {
    const offenders: string[] = [];
    for (const f of componentFiles()) {
      const src = stripComments(readFileSync(join(COMPONENTS, f), 'utf8'));
      if (/entityId:\s*`[^`]*\$\{Date\.now\(\)\}/.test(src)) offenders.push(f);
    }
    expect(
      offenders,
      'entityId مبنيّ على Date.now() لا يطابق أي وثيقة محفوظة — استعمل معرّف الوثيقة نفسه: '
      + offenders.join('، '),
    ).toEqual([]);
  });
});
