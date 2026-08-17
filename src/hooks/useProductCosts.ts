import { useMemo } from 'react';
import { useCollection } from './useCollection';
import { Product, ProductCost } from '../types';

/**
 * تكاليف الشراء المفصولة (product_costs). مصدر موحّد لقراءة/كتابة التكلفة عبر الشاشات.
 *
 * buyPriceOf يطبّق سياسة الـ fallback المتّفق عليها:
 *   costMap.get(id)  ??  product.buyPrice (موروث مضمّن)  ??  undefined
 * إرجاع undefined يعني "تكلفة غير معروفة" — يتعامل معها المستهلك (تبويب مجهول / صفر آمن)،
 * ويضمن أرقاماً مطابقة للمالك قبل الترحيل وبعده دون أي وميض.
 */
export function useProductCosts() {
  const { items, save, remove, loading } = useCollection<ProductCost>('product_costs');

  const costMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of items) m.set(c.id, c.buyPrice);
    return m;
  }, [items]);

  // تكلفة شراء الجملة — مجموعة منفصلة داخل product_costs. لا حقل موروث في وثيقة المنتج، فلا fallback.
  const wholesaleCostMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of items) if (c.wholesaleBuyPrice !== undefined) m.set(c.id, c.wholesaleBuyPrice);
    return m;
  }, [items]);

  const buyPriceOf = (product: Pick<Product, 'id' | 'buyPrice'>): number | undefined => {
    const fromMap = costMap.get(product.id);
    if (fromMap !== undefined) return fromMap;
    return product.buyPrice; // fallback موروث (قد يكون undefined = غير معروف)
  };

  // تكلفة شراء وحدة الجملة (الكرتون). undefined = غير معروفة ⇒ لا تخمين، والربح يُصنَّف "غير محتسب".
  const wholesaleBuyPriceOf = (product: Pick<Product, 'id'>): number | undefined =>
    wholesaleCostMap.get(product.id);

  return {
    costs: items,
    costMap,
    wholesaleCostMap,
    buyPriceOf,
    wholesaleBuyPriceOf,
    saveCost: save,
    removeCost: remove,
    costsLoading: loading,
  };
}
