/**
 * 🔴 مصدر الحقيقة الوحيد لما تشمله النسخة الاحتياطية.
 *
 * لماذا هذا الملف موجود أصلاً: كانت القائمة مكتوبة **مرتين** — مرة في التصدير ومرة في
 * الاستعادة. فلمّا أُضيفت ميزتان جديدتان (شحنات الصلاحية ونقل البضاعة) نُسي تحديثهما،
 * فصار التاجر يستعيد نسخته وتختفي بياناته صامتةً ولا يكتشف إلا بعد أن تفسد بضاعته.
 *
 * القائمة الآن واحدة يقرأ منها التصدير والاستعادة معاً، ويحرسها اختبار آلي يفحص
 * كل المجموعات المستعملة في البرنامج ويفشل عند أي مجموعة جديدة لم تُصنَّف هنا.
 */

/** المجموعات المشمولة: مفتاح الملف ← اسم المجموعة في قاعدة البيانات. */
export const BACKUP_COLLECTIONS: Record<string, string> = {
  app_customers: 'customers',
  app_customers_public: 'customers_public', // أسماء الزبائن التي يقرؤها الموظف — لا تُولَّد تلقائياً
  app_products: 'products',
  app_product_costs: 'product_costs',
  app_invoices: 'invoices',
  app_expenses: 'financial_transactions',
  app_debt_payments: 'debt_payments',
  app_supplier_payments: 'supplier_payments',
  app_employees: 'employees',
  app_cash_closings: 'cash_closings',
  app_suppliers: 'suppliers',
  app_purchase_invoices: 'purchase_invoices',
  app_stock_adjustments: 'stock_adjustments',
  app_audit_logs: 'audit_logs',
  app_warranty_index: 'warranty_index',
  app_installment_plans: 'installment_plans',
  app_branches: 'branches',
  app_stock_transfers: 'stock_transfers',   // سجل نقل البضاعة بين المواقع
  app_expiry_batches: 'expiry_batches',     // شحنات الصلاحية
};

/**
 * مجموعات مستثناة **عمداً**، ولكل واحدة سبب مكتوب.
 * وجود السبب شرط: الاختبار يرفض أي مجموعة غير مصنَّفة، فلا يمرّ نسيان بصمت.
 */
export const EXCLUDED_COLLECTIONS: Record<string, string> = {
  public: 'مرآة لمعلومات المحل يعيد المالك بناءها تلقائياً في كل جلسة — استعادتها بلا معنى',
  cloud_backups: 'اللقطات السحابية نفسها — لا تُنسخ النسخة داخل نفسها (تضخّم لا نهائي)',
  cloud_backup_chunks: 'أجزاء اللقطات السحابية — للسبب نفسه',
};

/** كل ما يجب أن يكون مصنَّفاً (مشمولاً أو مستثنى بسبب). */
export const CLASSIFIED_COLLECTIONS = new Set([
  ...Object.values(BACKUP_COLLECTIONS),
  ...Object.keys(EXCLUDED_COLLECTIONS),
]);

/** مفتاح الإعدادات — ليس مجموعة بل وثيقة البروفايل. */
export const SETTINGS_KEY = 'app_settings';
