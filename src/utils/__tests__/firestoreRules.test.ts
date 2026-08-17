import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
  RulesTestEnvironment, RulesTestContext,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs,
  query, where, serverTimestamp, Timestamp, deleteField, writeBatch,
} from 'firebase/firestore';

/**
 * 🔴 اختبارات قواعد Firestore — الحدّ الذي يفصل محلاً عن محل.
 *
 * كان المشروع يملك ٩٥٠ اختباراً لمنطقٍ نقيّ، و**صفراً** لهذا الملف. و`firestore.rules`
 * هو الشيء الوحيد الذي يمنع تاجراً من قراءة زبائن تاجرٍ آخر، وموظفاً من رؤية أرباح
 * مالكه. ٢٩٠ سطراً من شروط متشابكة (`isEmployeeOf`، `employeeBranch`، `diff().hasOnly`)
 * كانت مُتحقَّقاً منها **بالقراءة فقط**.
 *
 * وصار هذا أعجل بعد نشر قواعد مرساة التجربة: أي تعديل عليها بلا اختبار مخاطرةٌ مباشرة
 * على تجارٍ يعملون الآن.
 *
 * ⚙️ يعمل على **محاكي Firestore** لا على قاعدة الإنتاج — لا يلمس بيانات أحد.
 *    التشغيل: `npm run test:rules` (يحتاج Java، وقد وُجد JDK على هذا الجهاز).
 */

const PROJECT = 'ratib-rules-test';
const OWNER = 'ownerA';
const OTHER = 'ownerB';
const EMP = 'empA';        // موظف عند OWNER، فرع main
const EMP2 = 'empB';       // موظف عند OWNER، فرع branch_2
const ADMIN = 'YmRTHjZcMmcybuIhNZqFAp7u2H43';

let env: RulesTestEnvironment;
let owner: RulesTestContext, other: RulesTestContext, emp: RulesTestContext, emp2: RulesTestContext, admin: RulesTestContext, anon: RulesTestContext;

const db = (c: RulesTestContext) => c.firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: {
      rules: readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
  owner = env.authenticatedContext(OWNER);
  other = env.authenticatedContext(OTHER);
  emp = env.authenticatedContext(EMP);
  emp2 = env.authenticatedContext(EMP2);
  admin = env.authenticatedContext(ADMIN);
  anon = env.unauthenticatedContext();
});

afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  // بذر الحالة بتجاوز القواعد — هكذا تُبنى الأرضية التي تُختبر عليها
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'users', OWNER), { storeName: 'محل أ', createdAt: '2026-01-01' });
    await setDoc(doc(d, 'users', OTHER), { storeName: 'محل ب' });
    await setDoc(doc(d, 'users', OWNER, 'employees', EMP), { id: EMP, name: 'موظف', disabled: false, branchId: 'main' });
    await setDoc(doc(d, 'users', OWNER, 'employees', EMP2), { id: EMP2, name: 'موظف٢', disabled: false, branchId: 'branch_2' });
    await setDoc(doc(d, 'employeeIndex', EMP), { ownerUid: OWNER, disabled: false, name: 'موظف', branchId: 'main' });
    await setDoc(doc(d, 'employeeIndex', EMP2), { ownerUid: OWNER, disabled: false, name: 'موظف٢', branchId: 'branch_2' });
    await setDoc(doc(d, 'users', OWNER, 'products', 'p1'), { id: 'p1', name: 'مادة', quantity: 100, branchStock: { main: 60, branch_2: 40 }, sellPrice: 1000 });
    await setDoc(doc(d, 'users', OWNER, 'product_costs', 'p1'), { id: 'p1', buyPrice: 700 });
    await setDoc(doc(d, 'users', OWNER, 'customers', 'c1'), { id: 'c1', name: 'زبون', balance: 50000 });
    await setDoc(doc(d, 'users', OWNER, 'invoices', 'i_emp'), { id: 'i_emp', createdByUid: EMP, branchId: 'main', finalAmount: 1000 });
    await setDoc(doc(d, 'users', OWNER, 'invoices', 'i_owner'), { id: 'i_owner', createdByUid: OWNER, branchId: 'main', finalAmount: 5000 });
    await setDoc(doc(d, 'users', OWNER, 'public', 'info'), { storeName: 'محل أ', licenseActive: false });
  });
});

// ============================================================
describe('🔴 العزل بين المحلات — الحدّ الأهم في المنتج', () => {
  it('تاجرٌ لا يقرأ بروفايل تاجرٍ آخر', async () => {
    await assertFails(getDoc(doc(db(other), 'users', OWNER)));
  });

  it('ولا زبائنه', async () => {
    await assertFails(getDoc(doc(db(other), 'users', OWNER, 'customers', 'c1')));
  });

  it('ولا يسرد فواتيره', async () => {
    await assertFails(getDocs(collection(db(other), 'users', OWNER, 'invoices')));
  });

  it('ولا يكتب في شجرته', async () => {
    await assertFails(setDoc(doc(db(other), 'users', OWNER, 'customers', 'hack'), { name: 'x', balance: 0 }));
  });

  it('وغير المسجّل لا يقرأ شيئاً', async () => {
    await assertFails(getDoc(doc(db(anon), 'users', OWNER)));
    await assertFails(getDoc(doc(db(anon), 'users', OWNER, 'products', 'p1')));
  });

  it('والمالك يقرأ شجرته كاملة', async () => {
    await assertSucceeds(getDoc(doc(db(owner), 'users', OWNER)));
    await assertSucceeds(getDocs(collection(db(owner), 'users', OWNER, 'invoices')));
  });
});

// ============================================================
describe('🔴 الموظف لا يرى هامش الربح', () => {
  it('product_costs محجوبة عنه تماماً', async () => {
    await assertFails(getDoc(doc(db(emp), 'users', OWNER, 'product_costs', 'p1')));
    await assertFails(getDocs(collection(db(emp), 'users', OWNER, 'product_costs')));
  });

  it('ويقرأ المنتجات (بلا تكلفة فيها)', async () => {
    await assertSucceeds(getDoc(doc(db(emp), 'users', OWNER, 'products', 'p1')));
  });

  it('ولا يقرأ أرصدة الزبائن', async () => {
    await assertFails(getDoc(doc(db(emp), 'users', OWNER, 'customers', 'c1')));
    await assertFails(getDocs(collection(db(emp), 'users', OWNER, 'customers')));
  });

  it('ولا المصاريف ولا الحركات المالية', async () => {
    await assertFails(getDocs(collection(db(emp), 'users', OWNER, 'expenses')));
    await assertFails(getDocs(collection(db(emp), 'users', OWNER, 'financial_transactions')));
  });

  it('ولا بروفايل المالك', async () => {
    await assertFails(getDoc(doc(db(emp), 'users', OWNER)));
  });

  it('لكنه يقرأ معلومات المحل العامة', async () => {
    await assertSucceeds(getDoc(doc(db(emp), 'users', OWNER, 'public', 'info')));
  });
});

// ============================================================
describe('🔴 المخزون: الموظف يخصم ولا يضخّم', () => {
  it('ينقص الكمية (بيع) ✓', async () => {
    await assertSucceeds(updateDoc(doc(db(emp), 'users', OWNER, 'products', 'p1'), {
      quantity: 95, branchStock: { main: 55, branch_2: 40 },
    }));
  });

  it('🔴 لا يضخّم المخزون', async () => {
    await assertFails(updateDoc(doc(db(emp), 'users', OWNER, 'products', 'p1'), {
      quantity: 5000, branchStock: { main: 4960, branch_2: 40 },
    }));
  });

  it('🔴 ولا يمسّ مخزون فرعٍ ليس فرعه', async () => {
    // موظف main يحاول خصم من branch_2
    await assertFails(updateDoc(doc(db(emp), 'users', OWNER, 'products', 'p1'), {
      quantity: 95, branchStock: { main: 60, branch_2: 35 },
    }));
  });

  it('وموظف الفرع الثاني يخصم من فرعه ✓', async () => {
    await assertSucceeds(updateDoc(doc(db(emp2), 'users', OWNER, 'products', 'p1'), {
      quantity: 95, branchStock: { main: 60, branch_2: 35 },
    }));
  });

  it('🔴 ولا يغيّر السعر ولا الاسم', async () => {
    await assertFails(updateDoc(doc(db(emp), 'users', OWNER, 'products', 'p1'), { sellPrice: 1 }));
    await assertFails(updateDoc(doc(db(emp), 'users', OWNER, 'products', 'p1'), { name: 'مغيَّر' }));
  });

  it('ولا يحذف منتجاً ولا ينشئه', async () => {
    await assertFails(deleteDoc(doc(db(emp), 'users', OWNER, 'products', 'p1')));
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'products', 'new'), { name: 'x', quantity: 1 }));
  });

  /**
   * 🔴 ISSUE-011 — كان `quantity: -999999999` يمرّ، فموظفٌ ناقم يُفسد الجرد بضغطة.
   *
   * ⚠️ والقيد على **حجم النقصان** لا على أرضيةٍ عند الصفر: البرنامج يحذّر من البيع
   * بأكثر من المخزون **ولا يمنعه**، فالكمية السالبة حالةٌ شرعية و`>= 0` كانت ستحجب
   * بيعاً حقيقياً. الحالتان التاليتان تحرسان الطرفين معاً.
   */
  it('🔴 نقصانٌ خرافيّ في عملية واحدة يُرفض', async () => {
    await assertFails(updateDoc(doc(db(emp), 'users', OWNER, 'products', 'p1'), {
      quantity: -999999999, branchStock: { main: -999999999, branch_2: 40 },
    }));
  });

  it('🛡️ لكن البيع بأكثر من المخزون يبقى مسموحاً — سالبٌ معقول يمرّ', async () => {
    // المخزون ١٠٠ وبِيع ١٥٠ ⟵ ‎-٥٠. حالةٌ واقعية في محلٍّ جرده غير مضبوط.
    await assertSucceeds(updateDoc(doc(db(emp), 'users', OWNER, 'products', 'p1'), {
      quantity: -50, branchStock: { main: -90, branch_2: 40 },
    }));
  });
});

// ============================================================
describe('🔴 فواتير الموظف', () => {
  it('يقرأ فاتورته هو ✓', async () => {
    await assertSucceeds(getDoc(doc(db(emp), 'users', OWNER, 'invoices', 'i_emp')));
  });

  it('🔴 ولا يقرأ فاتورة المالك', async () => {
    await assertFails(getDoc(doc(db(emp), 'users', OWNER, 'invoices', 'i_owner')));
  });

  it('🔴 ولا يسرد الفواتير بلا ترشيح بمعرّفه', async () => {
    await assertFails(getDocs(collection(db(emp), 'users', OWNER, 'invoices')));
  });

  it('والسرد المرشَّح بمعرّفه يمرّ ✓', async () => {
    await assertSucceeds(getDocs(query(
      collection(db(emp), 'users', OWNER, 'invoices'), where('createdByUid', '==', EMP),
    )));
  });

  it('🔴 ولا ينتحل فاتورةً باسم غيره', async () => {
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'invoices', 'fake'), {
      id: 'fake', createdByUid: OWNER, branchId: 'main', finalAmount: 1,
    }));
  });

  it('🔴 ولا ينسب بيعه لفرعٍ غير فرعه', async () => {
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'invoices', 'f2'), {
      id: 'f2', createdByUid: EMP, branchId: 'branch_2', finalAmount: 1,
    }));
  });

  it('🔴 ولا يضبط علم طيّ الدين (يُدار من جلسة المالك)', async () => {
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'invoices', 'f3'), {
      id: 'f3', createdByUid: EMP, branchId: 'main', finalAmount: 1, debtSyncedToBalance: true,
    }));
  });

  it('وينشئ فاتورة صحيحة في فرعه ✓', async () => {
    await assertSucceeds(setDoc(doc(db(emp), 'users', OWNER, 'invoices', 'ok'), {
      id: 'ok', createdByUid: EMP, branchId: 'main', finalAmount: 1000,
    }));
  });

  it('🔴 ولا يعدّل فاتورة محفوظة ولا يحذفها', async () => {
    await assertFails(updateDoc(doc(db(emp), 'users', OWNER, 'invoices', 'i_emp'), { finalAmount: 1 }));
    await assertFails(deleteDoc(doc(db(emp), 'users', OWNER, 'invoices', 'i_emp')));
  });
});

// ============================================================
describe('🔴 سجل التدقيق — الموظف لا يطمس أثره', () => {
  it('يكتب أثره ✓', async () => {
    await assertSucceeds(setDoc(doc(db(emp), 'users', OWNER, 'audit_logs', 'a1'), {
      id: 'a1', actorUid: EMP, action: 'create', entity: 'invoice', entityId: 'x', summary: 's', createdAt: 1,
    }));
  });

  it('🔴 ولا ينتحل فاعلاً آخر', async () => {
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'audit_logs', 'a2'), {
      id: 'a2', actorUid: OWNER, action: 'delete', entity: 'invoice', entityId: 'x', summary: 's', createdAt: 1,
    }));
  });

  it('🔴 ولا يقرأ السجل ولا يعدّله ولا يحذفه — جوهر الحماية', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', OWNER, 'audit_logs', 'a3'), { id: 'a3', actorUid: EMP, createdAt: 1 });
    });
    await assertFails(getDoc(doc(db(emp), 'users', OWNER, 'audit_logs', 'a3')));
    await assertFails(updateDoc(doc(db(emp), 'users', OWNER, 'audit_logs', 'a3'), { summary: 'طُمس' }));
    await assertFails(deleteDoc(doc(db(emp), 'users', OWNER, 'audit_logs', 'a3')));
  });
});

// ============================================================
describe('🔴 الموظف المعطَّل يُمنع خادمياً', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'users', OWNER, 'employees', EMP), { disabled: true });
    });
  });

  it('لا يُنشئ فاتورة', async () => {
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'invoices', 'x'), {
      id: 'x', createdByUid: EMP, branchId: 'main', finalAmount: 1,
    }));
  });

  it('ولا يخصم مخزوناً', async () => {
    await assertFails(updateDoc(doc(db(emp), 'users', OWNER, 'products', 'p1'), {
      quantity: 95, branchStock: { main: 55, branch_2: 40 },
    }));
  });

  it('ولا يقرأ المنتجات', async () => {
    await assertFails(getDoc(doc(db(emp), 'users', OWNER, 'products', 'p1')));
  });

  /**
   * 🎯 الحقيقة الأمنية في `employees` لا في `employeeIndex` — وهذا ما يجعل ذرّية
   * ISSUE-004 ضرورية: تعطيلٌ يصل الفهرس ولا يصل هنا لا يمنع شيئاً.
   */
  it('🎯 والتعطيل في الفهرس وحده **لا يمنعه** — سبب ذرّية ISSUE-004', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const d = ctx.firestore();
      await updateDoc(doc(d, 'users', OWNER, 'employees', EMP), { disabled: false }); // القواعد تقرأ هذه
      await updateDoc(doc(d, 'employeeIndex', EMP), { disabled: true });              // والواجهة تقرأ هذه
    });
    await assertSucceeds(setDoc(doc(db(emp), 'users', OWNER, 'invoices', 'ghost'), {
      id: 'ghost', createdByUid: EMP, branchId: 'main', finalAmount: 1,
    }));
  });
});

// ============================================================
describe('🔴 مرساة التجربة (ISSUE-003 المنشورة)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', OWNER), {
        storeName: 'محل أ',
        trialStartedAt: Timestamp.fromMillis(Date.now() - 10 * 86400000),
        lastSeenAt: Timestamp.fromMillis(Date.now() - 3600000),
      }, { merge: true });
    });
  });

  it('✅ حفظ إعدادات عادي يمرّ — لا تاجر يُحجب', async () => {
    await assertSucceeds(setDoc(doc(db(owner), 'users', OWNER), { storeName: 'اسم جديد' }, { merge: true }));
    await assertSucceeds(setDoc(doc(db(owner), 'users', OWNER), { exchangeRate: 1500 }, { merge: true }));
  });

  it('✅ وإنشاء بروفايل تاجر جديد يمرّ', async () => {
    const fresh = env.authenticatedContext('brandNew');
    await assertSucceeds(setDoc(doc(fresh.firestore(), 'users', 'brandNew'), {
      createdAt: '2026-08-17', licenseStatus: 'trial',
    }));
  });

  it('🔴 تغيير المرساة يُرفض', async () => {
    await assertFails(setDoc(doc(db(owner), 'users', OWNER), { trialStartedAt: Timestamp.now() }, { merge: true }));
  });

  it('🔴 وحذفها يُرفض', async () => {
    await assertFails(setDoc(doc(db(owner), 'users', OWNER), { trialStartedAt: deleteField() }, { merge: true }));
  });

  it('🔴 وإرجاع نبضة الخادم يُرفض', async () => {
    await assertFails(setDoc(doc(db(owner), 'users', OWNER), {
      lastSeenAt: Timestamp.fromMillis(Date.now() - 90 * 86400000),
    }, { merge: true }));
  });

  it('🔴 وتقديمها للمستقبل يُرفض', async () => {
    await assertFails(setDoc(doc(db(owner), 'users', OWNER), {
      lastSeenAt: Timestamp.fromMillis(Date.now() + 365 * 86400000),
    }, { merge: true }));
  });

  it('✅ ونبضة بوقت الخادم تمرّ', async () => {
    await assertSucceeds(setDoc(doc(db(owner), 'users', OWNER), { lastSeenAt: serverTimestamp() }, { merge: true }));
  });

  it('🔴 وضبط licenseActive بلا ترخيص فعلي يُرفض', async () => {
    await assertFails(setDoc(doc(db(owner), 'users', OWNER, 'public', 'info'), { licenseActive: true }, { merge: true }));
  });
});

// ============================================================
describe('🔴 أكواد التفعيل', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'activationCodes', 'RS-AAAA-2222'), {
        used: false, usedBy: null, usedAt: null, createdAt: '2026-01-01',
      });
    });
  });

  it('المزوّد وحده يولّد كوداً', async () => {
    await assertSucceeds(setDoc(doc(db(admin), 'activationCodes', 'RS-BBBB-3333'), {
      used: false, usedBy: null, usedAt: null, createdAt: '2026-01-01',
    }));
    await assertFails(setDoc(doc(db(owner), 'activationCodes', 'RS-CCCC-4444'), { used: false }));
  });

  it('🔴 ولا أحد يسرد الأكواد إلا المزوّد', async () => {
    await assertFails(getDocs(collection(db(owner), 'activationCodes')));
    await assertSucceeds(getDocs(collection(db(admin), 'activationCodes')));
  });

  it('التفعيل بكود صحيح يمرّ ✓', async () => {
    await assertSucceeds(updateDoc(doc(db(owner), 'activationCodes', 'RS-AAAA-2222'), {
      used: true, usedBy: OWNER, usedAt: '2026-08-17',
    }));
  });

  it('🔴 ولا يُنسب الكود لغير المستعمِل', async () => {
    await assertFails(updateDoc(doc(db(owner), 'activationCodes', 'RS-AAAA-2222'), {
      used: true, usedBy: OTHER, usedAt: '2026-08-17',
    }));
  });

  it('🔴 ولا يُعاد استعمال كودٍ مستهلك', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'activationCodes', 'RS-AAAA-2222'), { used: true, usedBy: OTHER });
    });
    await assertFails(updateDoc(doc(db(owner), 'activationCodes', 'RS-AAAA-2222'), { used: true, usedBy: OWNER }));
  });

  it('🔴 ولا يُحذف كود (أثرُ بيعة)', async () => {
    await assertFails(deleteDoc(doc(db(admin), 'activationCodes', 'RS-AAAA-2222')));
  });

  /**
   * 🟠 ISSUE-012 — كانت الشروط تضبط **قيماً** ولا تحدّ **ما يُكتب**: من يفعّل كوداً
   * صحيحاً كان يُرفق أي حقول في نفس الكتابة (تخزين مجاني في مجموعة عالمية).
   */
  it('🔴 ولا يُرفق حقلٌ دخيل مع التفعيل', async () => {
    await assertFails(updateDoc(doc(db(owner), 'activationCodes', 'RS-AAAA-2222'), {
      used: true, usedBy: OWNER, usedAt: '2026-08-17',
      حمولة_دخيلة: 'ا'.repeat(500),
    }));
  });

  it('🔴 ولا يُطمس createdAt (أثر التوليد)', async () => {
    await assertFails(updateDoc(doc(db(owner), 'activationCodes', 'RS-AAAA-2222'), {
      used: true, usedBy: OWNER, usedAt: '2026-08-17', createdAt: '2020-01-01',
    }));
  });

  it('🔴 ولا يُولَّد كودٌ مستعمَلٌ سلفاً ولا بحقول غريبة', async () => {
    await assertFails(setDoc(doc(db(admin), 'activationCodes', 'RS-DDDD-5555'), {
      used: true, usedBy: ADMIN, usedAt: null, createdAt: '2026-01-01',
    }));
    await assertFails(setDoc(doc(db(admin), 'activationCodes', 'RS-EEEE-6666'), {
      used: false, usedBy: null, usedAt: null, createdAt: '2026-01-01', ملاحظة: 'x',
    }));
  });
});

// ============================================================
describe('🔴 فهرس الموظفين', () => {
  it('الموظف يقرأ فهرسه هو فقط', async () => {
    await assertSucceeds(getDoc(doc(db(emp), 'employeeIndex', EMP)));
    await assertFails(getDoc(doc(db(emp), 'employeeIndex', EMP2)));
  });

  it('🔴 ولا يُسرد الفهرس إطلاقاً (لا تعداد للمستخدمين)', async () => {
    await assertFails(getDocs(collection(db(admin), 'employeeIndex')));
    await assertFails(getDocs(collection(db(owner), 'employeeIndex')));
  });

  it('🔴 ولا يختطف مالكٌ موظفاً مسجَّلاً لمالك آخر', async () => {
    await assertFails(setDoc(doc(db(other), 'employeeIndex', EMP), { ownerUid: OTHER, disabled: false }));
  });

  it('والمالك يعدّل فهرس موظفه ✓', async () => {
    await assertSucceeds(setDoc(doc(db(owner), 'employeeIndex', EMP), { ownerUid: OWNER, disabled: true }, { merge: true }));
  });

  it('🎯 ودفعة ISSUE-004 الذرّية تمرّ كوحدة', async () => {
    const b = writeBatch(db(owner));
    b.set(doc(db(owner), 'users', OWNER, 'employees', EMP), { disabled: true }, { merge: true });
    b.set(doc(db(owner), 'employeeIndex', EMP), { ownerUid: OWNER, disabled: true }, { merge: true });
    await assertSucceeds(b.commit());
  });
});

// ============================================================
describe('🔴 تقارير الأخطاء', () => {
  it('المزوّد وحده يقرؤها', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'errorReports', 'e1'), { id: 'e1', uid: OWNER, message: 'x', stack: '', screen: 's', source: 'render', createdAt: 1, appVersion: '1', userAgent: 'u', online: true });
    });
    await assertSucceeds(getDoc(doc(db(admin), 'errorReports', 'e1')));
    await assertFails(getDoc(doc(db(owner), 'errorReports', 'e1')));
  });

  it('وأي مستخدم يُبلّغ عن خطأ منسوب لنفسه ✓', async () => {
    await assertSucceeds(setDoc(doc(db(owner), 'errorReports', 'e2'), {
      id: 'e2', uid: OWNER, message: 'خطأ', stack: '', screen: 's', source: 'render', createdAt: 1, appVersion: '1', userAgent: 'u', online: true,
    }));
  });

  it('🔴 ولا ينسبه لغيره ولا يُدخل حقولاً غريبة', async () => {
    await assertFails(setDoc(doc(db(owner), 'errorReports', 'e3'), {
      id: 'e3', uid: OTHER, message: 'x', stack: '', screen: 's', source: 'render', createdAt: 1, appVersion: '1', userAgent: 'u', online: true,
    }));
    await assertFails(setDoc(doc(db(owner), 'errorReports', 'e4'), {
      id: 'e4', uid: OWNER, message: 'x', stack: '', screen: 's', source: 'render', createdAt: 1, appVersion: '1', userAgent: 'u', online: true,
      حقل_دخيل: 'تخزين مجاني',
    }));
  });

  it('🔴 ولا يُطمس تقرير بعد رفعه', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'errorReports', 'e5'), { id: 'e5', uid: OWNER, message: 'x' });
    });
    await assertFails(updateDoc(doc(db(admin), 'errorReports', 'e5'), { message: 'مطموس' }));
    await assertFails(deleteDoc(doc(db(admin), 'errorReports', 'e5')));
  });
});

// ============================================================
describe('🔴 مرآتا الزبائن والضمان (ما يراه الموظف)', () => {
  it('يقرأ أسماء الزبائن ويُنشئ اسماً ✓', async () => {
    await assertSucceeds(getDocs(collection(db(emp), 'users', OWNER, 'customers_public')));
    await assertSucceeds(setDoc(doc(db(emp), 'users', OWNER, 'customers_public', 'c9'), { name: 'زبون جديد' }));
  });

  it('🔴 ولا يُهرّب حقلاً مالياً في المرآة', async () => {
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'customers_public', 'c8'), { name: 'ز', balance: 999 }));
  });

  it('ينشئ زبوناً برصيد صفر ✓ ولا ينشئه برصيد', async () => {
    await assertSucceeds(setDoc(doc(db(emp), 'users', OWNER, 'customers', 'c7'), { id: 'c7', name: 'ز', balance: 0 }));
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'customers', 'c6'), { id: 'c6', name: 'ز', balance: 500000 }));
  });

  it('ويقرأ مرآة الضمان ويكتب فيها بحقولها المحصورة ✓', async () => {
    await assertSucceeds(setDoc(doc(db(emp), 'users', OWNER, 'warranty_index', 'SN1'), {
      id: 'SN1', serial: 'SN1', productName: 'جهاز', saleDate: '2026-08-17', warrantyMonths: 12, invoiceNumber: 'E-1',
    }));
    await assertFails(setDoc(doc(db(emp), 'users', OWNER, 'warranty_index', 'SN2'), {
      id: 'SN2', serial: 'SN2', productName: 'جهاز', saleDate: '2026-08-17', invoiceNumber: 'E-2', سعر: 500000,
    }));
  });
});
