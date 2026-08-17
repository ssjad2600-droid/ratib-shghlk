/**
 * أسطر النقل: دمج المكرَّر وفحص الكفاية على **المجموع**.
 *
 * 🔴 العلّة: قارئ الباركود يدمج المادة المكرَّرة، والاختيار اليدوي من القائمة لا يمنعها.
 * فيكتب التاجر «حليب ٦٠» و«حليب ٦٠» ورصيده ١٠٠، فيقع ضرران:
 *
 *  ١) **فحص الكفاية يمرّ**، لأنه يقارن كل سطر وحده بالرصيد نفسه: ٦٠ ≤ ١٠٠ مرّتين.
 *     فيخرج ١٢٠ من رصيد ١٠٠ ⟵ **رصيد سالب صامت بلا أي تحذير** — وهو الحالة التي
 *     تعتبرها الشاشة نفسها «خللاً يحتاج تصحيحاً» وتعرض له زرّ إصلاح.
 *
 *  ٢) **السجل يكذب**: `fromBefore`/`toBefore` يُلتقطان من لقطةٍ واحدة، فيُسجَّل للسطرين
 *     رصيدٌ سابق واحد. ومراجعة الحركة بعد شهر تعطي أرقاماً مستحيلة.
 *
 * ⚖️ وما **ليس** ضرراً هنا، بعد القياس لا الظنّ: المخزون نفسه لا يضيع.
 *   · قِسْتُ تحديثين بـ`increment` على وثيقة واحدة داخل دفعة واحدة: **يتراكمان** (٥+٣ ⟵ ٨).
 *   · وظننتُ أن المنتج القديم بلا خريطة فروع يفقد كمية، لأن `transferUpdate` يُرجع له
 *     `branchStock` **مطلقاً** فيمحو التحديثُ الثاني الأول. فقِسْتُها: **لا تقع**.
 *     `useBranchStockMigration` يُرحّل كل منتج بلا خريطة فور بدء جلسة المالك، فلا يصل
 *     منتجٌ إلى شاشة النقل وهو بلا خريطة. المسار المطلق موجود في الكود ولا يُبلغ عملياً.
 *
 * الدمج يُغلق الضررين، ويجعل الفحص على الكمية الحقيقية الخارجة من المصدر.
 */

export interface TransferLineInput {
  productId: string;
  quantity: number;
}

/**
 * يدمج أسطر المادة الواحدة في سطر واحد بمجموع كمياتها.
 *
 * يحفظ ترتيب أول ظهور — كي لا تقفز الأسطر أمام عين التاجر عند الحفظ،
 * ويُسقط ما لا مادة له أو كميته ليست موجبة.
 */
export function mergeTransferLines<T extends TransferLineInput>(lines: T[]): TransferLineInput[] {
  const order: string[] = [];
  const totals = new Map<string, number>();

  for (const line of lines) {
    const id = (line.productId || '').trim();
    const qty = Number(line.quantity);
    if (!id || !Number.isFinite(qty) || qty <= 0) continue;
    if (!totals.has(id)) order.push(id);
    totals.set(id, (totals.get(id) ?? 0) + qty);
  }

  return order.map(productId => ({ productId, quantity: totals.get(productId) ?? 0 }));
}

/** هل في الأسطر مادة مكرَّرة؟ (لإخبار التاجر بما جرى بدل أن يتغيّر الحفظ صامتاً) */
export function duplicateCount(lines: TransferLineInput[]): number {
  const seen = new Set<string>();
  let dups = 0;
  for (const line of lines) {
    const id = (line.productId || '').trim();
    if (!id) continue;
    if (seen.has(id)) dups++;
    else seen.add(id);
  }
  return dups;
}

export interface Shortage {
  productId: string;
  requested: number;
  available: number;
}

/**
 * ما تتجاوز كميته رصيد المصدر — **بعد الدمج**، فالفحص على ما يخرج فعلاً.
 * لا يمنع النقل: قد تكون البضاعة انتقلت في الواقع والبرنامج متأخّر عنها.
 */
export function shortagesOf(
  merged: TransferLineInput[],
  availableOf: (productId: string) => number | null,
): Shortage[] {
  const out: Shortage[] = [];
  for (const line of merged) {
    const available = availableOf(line.productId);
    if (available === null) continue; // مادة مجهولة — ليست نقصاً بل غياباً
    if (line.quantity > available) {
      out.push({ productId: line.productId, requested: line.quantity, available });
    }
  }
  return out;
}
