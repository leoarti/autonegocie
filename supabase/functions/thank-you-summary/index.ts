import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

// Splits que representam pagamento efetivo. Só estes entram no total pago
// e na lista de "Meios Utilizados" do comprovante. Splits pending/failed/
// cancelled/expired existem no banco (regeneração de QR, tentativas
// canceladas) mas não devem aparecer inflando o valor.
function isPaidSplit(s: { status?: string | null }): boolean {
  return s.status === 'concluded' || s.status === 'boleto_linked'
}

function sumPaidCents(splits: Array<{ status?: string | null; display_amount_cents?: number | null; amount_cents?: number | null }>): number {
  return splits
    .filter(isPaidSplit)
    .reduce((sum, s) => sum + (s.display_amount_cents ?? s.amount_cents ?? 0), 0)
}

// Prioridade para escolher o split representativo de cada método:
// concluded > analyzing > pending > (demais). Evita mostrar um QR pendente
// gerado depois do pagamento efetivo.
const STATUS_PRIORITY: Record<string, number> = {
  concluded: 0,
  boleto_linked: 0,
  analyzing: 1,
  pending: 2,
  processing: 2,
  failed: 3,
  cancelled: 3,
  canceled: 3,
  expired: 3,
}

function bestSplitByMethod<T extends { method?: string | null; status?: string | null; created_at?: string | null }>(splits: T[]): T[] {
  const best = new Map<string, T>()
  for (const s of splits) {
    const method = s.method ?? ''
    const current = best.get(method)
    if (!current) {
      best.set(method, s)
      continue
    }
    const currentPrio = STATUS_PRIORITY[current.status ?? ''] ?? 99
    const candidatePrio = STATUS_PRIORITY[s.status ?? ''] ?? 99
    if (candidatePrio < currentPrio) {
      best.set(method, s)
    } else if (candidatePrio === currentPrio) {
      // desempate: mais recente ganha
      const currentTs = current.created_at ? Date.parse(current.created_at) : 0
      const candidateTs = s.created_at ? Date.parse(s.created_at) : 0
      if (candidateTs > currentTs) best.set(method, s)
    }
  }
  return Array.from(best.values())
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const token = url.searchParams.get('pl')
    const chargeIdParam = url.searchParams.get('chargeId') || url.searchParams.get('charge')
    const methodParam = url.searchParams.get('method')
    const amountParam = url.searchParams.get('amount')
    const payerNameParam = url.searchParams.get('payerName')
    const paidAtParam = url.searchParams.get('paidAt')
    
    console.log('[thank-you-summary] Token:', token, 'ChargeId:', chargeIdParam)
    
    // Se não tem token mas tem chargeId, buscar diretamente pela charge
    if (!token && chargeIdParam) {
      console.log('[thank-you-summary] No token, fetching charge directly by ID:', chargeIdParam)
      
      const { data: charge, error: chargeError } = await supabase
        .from('charges')
        .select('*')
        .eq('id', chargeIdParam)
        .maybeSingle()
      
      if (chargeError || !charge) {
        console.error('[thank-you-summary] Charge not found:', chargeError)
        // Fallback para dados passados via query params
        if (amountParam && methodParam) {
          console.log('[thank-you-summary] Using fallback query params data')
          return new Response(JSON.stringify({
            paid: true,
            charge: {
              id: chargeIdParam,
              type: 'pontual',
              total_amount_cents: parseInt(amountParam) || 0,
              total_paid_cents: parseInt(amountParam) || 0,
              currency: 'BRL',
              paid: true,
              paid_at: paidAtParam || new Date().toISOString()
            },
            splits: [{
              id: 'fallback-pix',
              method: methodParam?.toUpperCase() || 'PIX',
              amount_cents: parseInt(amountParam) || 0,
              status: 'CONCLUDED',
              processed_at: paidAtParam || new Date().toISOString()
            }],
            transactions: [],
            recurrence: { next_dates: [] },
            company: { name: null, email: null, phone: null },
            ui: { support_email: "faleconosco@autonegocie.com" }
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ error: 'Charge not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      
      // Buscar dados da empresa
      let company = null
      if (charge.company_id) {
        const { data: companyData } = await supabase
          .from('companies')
          .select('name, email, phone')
          .eq('id', charge.company_id)
          .maybeSingle()
        company = companyData
      }
      
      // Buscar splits da charge (se existirem)
      const { data: splits } = await supabase
        .from('payment_splits')
        .select('*')
        .eq('charge_id', chargeIdParam)
        .order('created_at', { ascending: false })

      // Verificar se pagamento está confirmado via metadata ou status
      const isPaidByMetadata = charge.metadata?.pix_paid_at || charge.status === 'completed'
      const paidAt = charge.metadata?.pix_paid_at || charge.completed_at || paidAtParam || new Date().toISOString()

      // Se não há splits, criar um "virtual" baseado nos dados da charge
      const rawSplits = splits && splits.length > 0 ? splits : [{
        id: 'virtual-pix',
        method: methodParam?.toUpperCase() || 'PIX',
        amount_cents: charge.amount,
        status: 'concluded',
        processed_at: paidAt
      }]

      // Só splits efetivamente pagos entram no comprovante
      const finalSplits = rawSplits.filter(isPaidSplit)
      const totalPaidCents = sumPaidCents(rawSplits)

      return new Response(JSON.stringify({
        paid: true,
        charge: {
          id: charge.id,
          type: charge.recurrence_type || 'pontual',
          total_amount_cents: charge.amount,
          total_paid_cents: totalPaidCents,
          currency: 'BRL',
          paid: true,
          paid_at: paidAt
        },
      splits: finalSplits.map(s => ({
        id: s.id,
        method: s.method?.toUpperCase() || 'PIX',
        amount_cents: s.display_amount_cents || s.amount_cents,
        original_amount_cents: s.amount_cents,
        status: (s.status || 'CONCLUDED').toUpperCase(),
        processed_at: s.processed_at || paidAt
      })),
        transactions: [],
        recurrence: { next_dates: [] },
        company: {
          name: company?.name || null,
          email: company?.email || null,
          phone: company?.phone || null
        },
        ui: { support_email: "faleconosco@autonegocie.com" }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    if (!token) {
      // Fallback final: se tem dados via query params, usar
      if (amountParam && methodParam) {
        console.log('[thank-you-summary] No token, using query params fallback')
        return new Response(JSON.stringify({
          paid: true,
          charge: {
            id: 'fallback',
            type: 'pontual',
            total_amount_cents: parseInt(amountParam) || 0,
            total_paid_cents: parseInt(amountParam) || 0,
            currency: 'BRL',
            paid: true,
            paid_at: paidAtParam || new Date().toISOString()
          },
          splits: [{
            id: 'fallback-split',
            method: methodParam?.toUpperCase() || 'PIX',
            amount_cents: parseInt(amountParam) || 0,
            status: 'CONCLUDED',
            processed_at: paidAtParam || new Date().toISOString()
          }],
          transactions: [],
          recurrence: { next_dates: [] },
          company: { name: null, email: null, phone: null },
          ui: { support_email: "faleconosco@autonegocie.com" }
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      
      return new Response(JSON.stringify({ error: 'Missing payment link token' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Buscar payment_link pelo id (consistente com public-payment-link)
    let paymentLink = null
    
    // Tentativa 1: buscar por payment_links.id
    const { data: linkById, error: linkByIdError } = await supabase
      .from('payment_links')
      .select('*')
      .eq('id', token)
      .maybeSingle()

    if (linkById) {
      paymentLink = linkById
      console.log('[thank-you-summary] Payment Link found by id:', paymentLink.id)
    } else {
      // Tentativa 2: token pode ser charge_id — buscar payment_link vinculado
      console.log('[thank-you-summary] Not found by id, trying charge_id fallback:', token)
      const { data: linkByCharge } = await supabase
        .from('payment_links')
        .select('*')
        .eq('charge_id', token)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (linkByCharge) {
        paymentLink = linkByCharge
        console.log('[thank-you-summary] Payment Link found by charge_id:', paymentLink.id)
      }
    }

    if (!paymentLink) {
      // Tentativa 3: tratar token como chargeId e buscar direto (reutiliza lógica existente)
      console.log('[thank-you-summary] No payment link found, treating token as chargeId')
      const { data: charge, error: chargeError } = await supabase
        .from('charges')
        .select('*')
        .eq('id', token)
        .maybeSingle()

      if (charge) {
        // Buscar dados da empresa
        let company = null
        if (charge.company_id) {
          const { data: companyData } = await supabase
            .from('companies')
            .select('name, email, phone')
            .eq('id', charge.company_id)
            .maybeSingle()
          company = companyData
        }

        // Buscar splits
        const { data: splits } = await supabase
          .from('payment_splits')
          .select('*')
          .eq('charge_id', token)
          .order('created_at', { ascending: false })

        const rawSplits = splits && splits.length > 0 ? splits : [{
          id: 'virtual',
          method: 'CREDIT_CARD',
          amount_cents: charge.amount,
          status: 'analyzing',
          processed_at: new Date().toISOString()
        }]

        // Reduzir para um por método priorizando concluded>analyzing>pending
        const bestSplits = bestSplitByMethod(rawSplits)
        const isPaid = bestSplits.length > 0 && bestSplits.every(s => isPaidSplit(s))
        const analyzingSplit = bestSplits.find(s => s.status === 'analyzing')
        const totalPaidCents = sumPaidCents(rawSplits)
        // Lista para exibição: só pagos/em análise (nunca pending/failed antigos)
        const finalSplits = bestSplits.filter(s => isPaidSplit(s) || s.status === 'analyzing')

        return new Response(JSON.stringify({
          paid: isPaid,
          analyzing: !isPaid && !!analyzingSplit,
          processing: !isPaid && !analyzingSplit,
          message: isPaid ? 'Pagamento confirmado' : 'Pagamento em análise',
          charge: {
            id: charge.id,
            type: charge.recurrence_type || 'pontual',
            total_amount_cents: charge.amount,
            total_paid_cents: totalPaidCents,
            currency: 'BRL',
            paid: isPaid,
            analyzing: !isPaid && !!analyzingSplit,
            paid_at: finalSplits[0]?.processed_at || new Date().toISOString()
          },
          splits: finalSplits.map(s => ({
            id: s.id,
            method: s.method?.toUpperCase() || 'CREDIT_CARD',
            amount_cents: s.display_amount_cents || s.amount_cents,
            original_amount_cents: s.amount_cents,
            status: (s.status || 'ANALYZING').toUpperCase(),
            processed_at: s.processed_at
          })),
          company: {
            name: company?.name || null,
            email: company?.email || null,
            phone: company?.phone || null
          },
          ui: { support_email: "faleconosco@autonegocie.com" }
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({ error: 'Invalid or expired link' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Buscar TODOS os splits relacionados a este payment_link, ordenados por created_at DESC
    const { data: allSplits, error: splitsError } = await supabase
      .from('payment_splits')
      .select('*')
      .eq('payment_link_id', paymentLink.id)
      .order('created_at', { ascending: false })

    console.log('[thank-you-summary] Total splits found:', allSplits?.length || 0)

    if (splitsError) {
      console.error('Error fetching splits:', splitsError)
      return new Response(JSON.stringify({ error: 'Error fetching payment data' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Escolher o melhor split por método (concluded > analyzing > pending > demais).
    // Antes o código pegava o "mais recente por método", o que fazia um QR pending
    // gerado após o pagamento sobrepor o split concluded original.
    let splits = allSplits ? bestSplitByMethod(allSplits) : [];

    console.log('[thank-you-summary] Best split by method:', splits?.map(s => ({ id: s.id, method: s.method, status: s.status })))

    // Fallback: buscar por charge_id se não houver splits por payment_link_id
    let finalSplits = splits
    let chargeId = paymentLink.charge_id

    if (!finalSplits || finalSplits.length === 0) {
      console.log('[thank-you-summary] No splits by payment_link_id, trying fallback by charge_id:', chargeId)
      
      if (chargeId) {
        const { data: splitsByCharge, error: chargeError } = await supabase
          .from('payment_splits')
          .select('*')
          .eq('charge_id', chargeId)
          .order('created_at', { ascending: false })

        if (!chargeError && splitsByCharge && splitsByCharge.length > 0) {
          finalSplits = bestSplitByMethod(splitsByCharge);
          console.log('[thank-you-summary] Fallback successful! Best splits by charge_id:', finalSplits.length)
        }
      }

      // Se ainda não houver splits, buscar charge_id diretamente das execuções
      if ((!finalSplits || finalSplits.length === 0) && !chargeId) {
        const { data: executions } = await supabase
          .from('charge_executions')
          .select('charge_id')
          .eq('payment_link_id', paymentLink.id)
          .limit(1)

        if (executions && executions.length > 0) {
          chargeId = executions[0].charge_id
          console.log('[thank-you-summary] Found charge_id from executions:', chargeId)
        }
      }
    } else {
      chargeId = finalSplits[0].charge_id || chargeId
    }

    let charge = null
    if (chargeId) {
      const { data: chargeData, error: chargeError } = await supabase
        .from('charges')
        .select('*')
        .eq('id', chargeId)
        .single()

      if (!chargeError && chargeData) {
        charge = chargeData
      }
    }

    // Buscar dados da empresa cobradora
    let company = null
    const companyId = charge?.company_id || paymentLink.company_id
    if (companyId) {
      const { data: companyData, error: companyError } = await supabase
        .from('companies')
        .select('name, email, phone')
        .eq('id', companyId)
        .single()

      if (!companyError && companyData) {
        company = companyData
        console.log('[thank-you-summary] Company found:', company?.name)
      }
    }

    // ✅ CORREÇÃO: Usar APENAS status como fonte da verdade
    // pre_payment_key ou transaction_id NÃO garantem que o pagamento foi concluído
    // O status 'concluded' é o único indicador válido de pagamento aprovado
    const isPaid = finalSplits && finalSplits.length > 0 && finalSplits.every(s => 
      s.status === 'concluded' || s.status === 'boleto_linked'
    );
    
    // Verificar se algum split está em análise
    const analyzingSplit = finalSplits?.find(s => s.status === 'analyzing');
    
    // Verificar se algum split falhou/expirou/cancelou
    const failedSplit = finalSplits?.find(s => 
      s.status === 'failed' || 
      s.status === 'expired' || 
      s.status === 'canceled' ||
      s.status === 'cancelled'
    );
    
    console.log('[thank-you-summary] isPaid:', isPaid, '- analyzingSplit:', analyzingSplit?.method, '- failedSplit:', failedSplit?.method, '- splits checked:', finalSplits?.map(s => ({ 
      method: s.method, 
      status: s.status
    })))

    if (!isPaid) {
      // Se tem split com falha, retornar estado de erro
      if (failedSplit) {
        const methodLabel = failedSplit.method === 'credit_card' ? 'Cartão de Crédito' : 
                           failedSplit.method === 'pix' ? 'PIX' : failedSplit.method;
        
        return new Response(JSON.stringify({
          paid: false,
          processing: false,
          failed: true,
          failedMethod: failedSplit.method,
          failedMethodLabel: methodLabel,
          message: `Pagamento via ${methodLabel} não foi aprovado`
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      
      // ✅ NOVO: Se tem split em análise (sem falha), retornar estado de análise
      if (analyzingSplit) {
        console.log('[thank-you-summary] Pagamento em análise detectado');
        
        // Calcular valores confirmados vs em análise
        const confirmedSplits = finalSplits.filter(s => s.status === 'concluded');
        const analyzingSplits = finalSplits.filter(s => s.status === 'analyzing');
        const totalConfirmedCents = confirmedSplits.reduce((sum, s) => sum + (s.display_amount_cents || s.amount_cents || 0), 0);
        const totalAnalyzingCents = analyzingSplits.reduce((sum, s) => sum + (s.display_amount_cents || s.amount_cents || 0), 0);
        
        return new Response(JSON.stringify({
          paid: false,
          analyzing: true,
          processing: false,
          failed: false,
          message: 'Seu pagamento foi recebido e está em análise. Assim que ele for confirmado, você será notificado no email cadastrado.',
          charge: {
            id: charge?.id || paymentLink.id,
            type: charge?.recurrence_type || 'pontual',
            total_amount_cents: charge?.amount || paymentLink.amount,
            total_confirmed_cents: totalConfirmedCents,
            total_analyzing_cents: totalAnalyzingCents,
            currency: 'BRL',
            paid: false,
            analyzing: true,
            submitted_at: new Date().toISOString()
          },
          splits: finalSplits.map(split => ({
            id: split.id,
            method: split.method,
            amount_cents: split.display_amount_cents || split.amount_cents,
            original_amount_cents: split.amount_cents,
            status: split.status.toUpperCase(),
            processed_at: split.processed_at
          })),
          company: {
            name: company?.name || null,
            email: company?.email || null,
            phone: company?.phone || null
          },
          ui: {
            support_email: "faleconosco@autonegocie.com"
          }
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      
      // Sem falha e sem análise, mas ainda não concluído = processando
      return new Response(JSON.stringify({
        paid: false,
        processing: true,
        failed: false,
        message: "Pagamento em processamento"
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Buscar transações relacionadas aos splits
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .in('id', finalSplits.map(s => s.transaction_id).filter(Boolean))
      .order('created_at', { ascending: false })

    // Buscar próximas execuções se for recorrente
    let nextDates: string[] = []
    if (charge && charge.recurrence_type !== 'pontual' && chargeId) {
      const { data: executions } = await supabase
        .from('charge_executions')
        .select('scheduled_for')
        .eq('charge_id', chargeId)
        .eq('status', 'SCHEDULED')
        .gt('scheduled_for', new Date().toISOString())
        .order('scheduled_for', { ascending: true })
        .limit(3)

      if (executions) {
        nextDates = executions.map(e => e.scheduled_for).filter(Boolean)
      }
    }

    // Só splits pagos entram no total do comprovante (ignora pending/failed/cancelled)
    const totalPaidCents = sumPaidCents(finalSplits ?? [])
    // Lista para exibição segue o mesmo filtro
    const displaySplits = (finalSplits ?? []).filter(isPaidSplit)
    console.log('[thank-you-summary] Total paid cents:', totalPaidCents, '| paid splits:', displaySplits.length)

    // Montar resposta
    const response = {
      paid: true,
      charge: {
        id: charge?.id || paymentLink.id,
        type: charge?.recurrence_type || 'pontual',
        total_amount_cents: charge?.amount || paymentLink.amount,
        total_paid_cents: totalPaidCents,
        currency: 'BRL',
        paid: true,
        paid_at: finalSplits[0]?.processed_at || new Date().toISOString()
      },
      splits: displaySplits.map(split => ({
        id: split.id,
        method: split.method,
        // Valor exibido usa display_amount_cents (com juros/taxa) quando disponível
        amount_cents: split.display_amount_cents || split.amount_cents,
        original_amount_cents: split.amount_cents,
        status: split.status.toUpperCase(),
        processed_at: split.processed_at
      })),
      transactions: (transactions || []).map(tx => ({
        id: tx.id,
        created_at: tx.created_at,
        amount_cents: tx.amount_in_cents,
        method: tx.status?.includes('PIX') ? 'PIX' : tx.status?.includes('CARD') ? 'CARD' : 'QUITA',
        transaction_id: tx.transaction_id
      })),
      recurrence: {
        next_dates: nextDates
      },
      company: {
        name: company?.name || null,
        email: company?.email || null,
        phone: company?.phone || null
      },
      ui: {
        return_url: paymentLink.ui_snapshot?.return_url || null,
        support_email: "faleconosco@autonegocie.com"
      }
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Error in thank-you-summary:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})