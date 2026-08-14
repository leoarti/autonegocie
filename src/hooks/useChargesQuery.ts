import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { startOfMonth, endOfDay } from 'date-fns';

const PAGE_SIZE = 50;

const CHARGES_SELECT = `
  id,
  payer_name,
  payer_email,
  payer_phone,
  payer_document,
  amount,
  description,
  status,
  recurrence_type,
  has_boleto_link,
  created_at,
  next_charge_date,
  checkout_url,
  checkout_link_id,
  payment_method,
  pix_amount,
  card_amount,
  fee_amount,
  fee_percentage,
  pre_payment_key,
  boleto_linha_digitavel,
  boleto_admin_linha_digitavel,
  boleto_pix_cartao_linha_digitavel,
  creditor_document,
  creditor_name,
  company_id,
  metadata,
  status_locked_at,
  company:companies(id, name),
  executions:charge_executions(
    id,
    execution_date,
    status,
    payment_link_url
  ),
  splits:payment_splits(
    id,
    method,
    amount_cents,
    display_amount_cents,
    status,
    pix_paid_at,
    pre_payment_key,
    transaction_id,
    processed_at,
    order_index,
    installments,
    created_at
  )
`;

export interface ChargeFilters {
  status: string;
  payment_method: string;
  date_from: Date | undefined;
  date_to: Date | undefined;
  payer_document: string;
  company_id: string;
}

const DEFAULT_FILTERS: ChargeFilters = {
  status: 'all',
  payment_method: 'all',
  date_from: startOfMonth(new Date()),
  date_to: undefined,
  payer_document: '',
  company_id: 'all',
};

function deduplicateSplits(charges: any[]) {
  return charges.map(charge => {
    if (charge.splits && charge.splits.length > 0) {
      const splitsByMethod = new Map<string, any>();
      charge.splits.forEach((split: any) => {
        const existing = splitsByMethod.get(split.method);
        if (!existing) {
          splitsByMethod.set(split.method, split);
        } else {
          const existingHasKey = !!existing.pre_payment_key;
          const newHasKey = !!split.pre_payment_key;
          if (newHasKey && !existingHasKey) {
            splitsByMethod.set(split.method, split);
          } else if (!newHasKey && existingHasKey) {
            // manter o existente que já tem pre_payment_key
          } else if (new Date(split.created_at) > new Date(existing.created_at)) {
            splitsByMethod.set(split.method, split);
          }
        }
      });
      charge.splits = Array.from(splitsByMethod.values()).sort((a: any, b: any) => a.order_index - b.order_index);
    }
    return charge;
  });
}

async function fetchChargesPage(
  filters: ChargeFilters,
  page: number,
  isAdmin: boolean,
) {
  let query = supabase
    .from('charges')
    .select(CHARGES_SELECT, { count: 'exact' });

  // Server-side date filters (default = current month)
  const dateFrom = filters.date_from ?? startOfMonth(new Date());
  query = query.gte('created_at', dateFrom.toISOString());

  if (filters.date_to) {
    query = query.lte('created_at', endOfDay(filters.date_to).toISOString());
  }

  // Server-side status filter
  if (filters.status !== 'all') {
    query = query.eq('status', filters.status as any);
  }

  // Server-side payment method filter
  if (filters.payment_method !== 'all') {
    query = query.eq('payment_method', filters.payment_method);
  }

  // Server-side document filter
  if (filters.payer_document) {
    const cleanDoc = filters.payer_document.replace(/\D/g, '');
    if (cleanDoc) {
      query = query.ilike('payer_document', `%${cleanDoc}%`);
    }
  }

  // Server-side company filter (admin only)
  if (isAdmin && filters.company_id !== 'all') {
    query = query.eq('company_id', filters.company_id);
  }

  // Pagination + ordering
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  query = query
    .order('created_at', { ascending: false })
    .range(from, to);

  const { data, error, count } = await query;

  if (error) throw error;

  const processed = deduplicateSplits(data || []);

  return {
    charges: processed,
    totalCount: count ?? 0,
    hasMore: (data?.length ?? 0) === PAGE_SIZE,
  };
}

export function useChargesQuery(filters: ChargeFilters, page: number) {
  const { isAdmin, profile } = useAuth();

  return useQuery({
    queryKey: ['charges', {
      dateFrom: filters.date_from?.toISOString(),
      dateTo: filters.date_to?.toISOString(),
      status: filters.status,
      paymentMethod: filters.payment_method,
      payerDocument: filters.payer_document,
      companyId: filters.company_id,
      page,
      companyIdProfile: profile?.company_id,
    }],
    queryFn: () => fetchChargesPage(filters, page, isAdmin),
    enabled: !!profile?.company_id,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

export { DEFAULT_FILTERS, PAGE_SIZE, deduplicateSplits, CHARGES_SELECT };
