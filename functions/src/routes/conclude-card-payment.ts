import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeamento statusCode Quita+ → status interno
// IMPORTANTE: Mapeamento correto segundo documentação API Quita+
// StatusCode 3 (BarcodeAssigned) = boleto_linked (NÃO expired!)
const statusCodeMap: Record<number, string> = {
  1: 'analyzing',         // Received - pagamento recebido, em análise pela operadora
  2: 'cancelled',         // Canceled - prazo expirou ou valor diferente
  3: 'boleto_linked',     // BarcodeAssigned - boleto vinculado ao pagamento ✅ CORRIGIDO
  4: 'validating',        // Settled - analisado pelo robô
  5: 'failed',            // PaymentDenied - risco não aprovou
  6: 'approved',          // PaymentValidated - risco aprovou
  7: 'awaiting_validation', // AwaitingPayerValidation - aguardando PIN
  8: 'validating',        // ValidatingPayment - risco analisando
  9: 'concluded',         // Paid - boleto foi pago
  50: 'failed',           // MissingRegistryBankslipCNPJ - CNPJ não cadastrado
};

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('[conclude-card-payment] Starting payment conclusion process');

    const supabase = createClient(
      process.env.SUPABASE_URL ?? '',
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );

    const { payment_link_id, amount_cents, display_amount_cents, installments = 1, transaction_id, pre_payment_key } = await req.json();

    if (!payment_link_id) {
      console.error('[conclude-card-payment] Missing payment_link_id');
      return new Response(
        JSON.stringify({ error: 'payment_link_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[conclude-card-payment] Processing payment_link_id:', payment_link_id);

    // Fetch payment link
    const { data: paymentLink, error: linkError } = await supabase
      .from('payment_links')
      .select('*')
      .eq('id', payment_link_id)
      .single();

    if (linkError || !paymentLink) {
      console.error('[conclude-card-payment] Payment link not found:', linkError);
      return new Response(
        JSON.stringify({ error: 'Payment link not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[conclude-card-payment] Payment link found:', paymentLink.id);

    const totalAmount = amount_cents || paymentLink.amount;
    const chargeId = paymentLink.charge_id;

    // Buscar pre_payment_key do charge se não foi fornecido
    let prePaymentKey = pre_payment_key;
    if (!prePaymentKey && chargeId) {
      const { data: charge } = await supabase
        .from('charges')
        .select('pre_payment_key')
        .eq('id', chargeId)
        .single();
      prePaymentKey = charge?.pre_payment_key;
    }

    console.log('[conclude-card-payment] Total amount:', totalAmount, 'Charge ID:', chargeId, 'PrePaymentKey:', prePaymentKey);

    // ============================================================
    // VALIDAÇÃO CRÍTICA: Verificar status real na API Quita+ antes de concluir
    // ============================================================
    let finalStatus = 'pending';
    let authorizationCode: string | null = null;
    let realTransactionId: string | null = transaction_id || null;
    let statusFromApi = false;

    if (prePaymentKey) {
      console.log('[conclude-card-payment] Verificando status na API Quita+ para:', prePaymentKey);
      
      try {
        const { data: statusData, error: statusError } = await supabase.functions.invoke('quitaplus-prepayment-status', {
          body: { prePaymentKey }
        });

        if (!statusError && statusData?.success) {
          const apiStatusCode = statusData.statusCode;
          const mappedStatus = statusCodeMap[apiStatusCode] || 'pending';
          
          console.log('[conclude-card-payment] Status da API Quita+:', {
            statusCode: apiStatusCode,
            statusName: statusData.statusName,
            mappedStatus,
            authorizationCode: statusData.authorizationCode,
            transactionId: statusData.transactionId
          });

          finalStatus = mappedStatus;
          authorizationCode = statusData.authorizationCode || null;
          realTransactionId = statusData.transactionId || transaction_id || null;
          statusFromApi = true;

          // Se o status é 'failed', 'expired' ou 'cancelled', NÃO marcar como concluded
          if (finalStatus === 'failed' || finalStatus === 'expired' || finalStatus === 'cancelled') {
            console.log('[conclude-card-payment] Pagamento NÃO foi aprovado na API. Status:', finalStatus);
          } else if (finalStatus === 'concluded') {
            console.log('[conclude-card-payment] Pagamento CONFIRMADO como pago na API Quita+');
          }
        } else {
          console.warn('[conclude-card-payment] Não foi possível verificar status na API:', statusError);
          // Se não conseguiu verificar, manter como pending para verificação posterior
          finalStatus = 'pending';
        }
      } catch (apiError) {
        console.error('[conclude-card-payment] Erro ao consultar API Quita+:', apiError);
        // Em caso de erro na verificação, manter como pending
        finalStatus = 'pending';
      }
    } else {
      console.warn('[conclude-card-payment] Sem pre_payment_key - não é possível validar na API Quita+');
      // Sem prePaymentKey, assumir pending para segurança
      finalStatus = 'pending';
    }

    // Check for existing credit_card split
    const { data: existingSplits } = await supabase
      .from('payment_splits')
      .select('*')
      .eq('payment_link_id', payment_link_id)
      .eq('method', 'credit_card');

    let splitId: string;

    if (existingSplits && existingSplits.length > 0) {
      // Update existing split
      splitId = existingSplits[0].id;
      console.log('[conclude-card-payment] Updating existing split:', splitId, 'with status:', finalStatus);

      const { error: updateError } = await supabase
        .from('payment_splits')
        .update({
          status: finalStatus,
          transaction_id: realTransactionId,
          authorization_code: authorizationCode,
          processed_at: finalStatus === 'concluded' ? new Date().toISOString() : null,
          amount_cents: totalAmount,
          display_amount_cents: display_amount_cents || existingSplits[0].display_amount_cents || totalAmount,
          installments: installments,
          pre_payment_key: prePaymentKey || existingSplits[0].pre_payment_key,
        })
        .eq('id', splitId);

      if (updateError) {
        console.error('[conclude-card-payment] Error updating split:', updateError);
        throw updateError;
      }
    } else {
      // Create new split
      console.log('[conclude-card-payment] Creating new credit_card split with status:', finalStatus);

      const { data: newSplit, error: insertError } = await supabase
        .from('payment_splits')
        .insert({
          payment_link_id: payment_link_id,
          charge_id: chargeId,
          method: 'credit_card',
          amount_cents: totalAmount,
          display_amount_cents: display_amount_cents || totalAmount,
          status: finalStatus,
          installments: installments,
          order_index: 1,
          pre_payment_key: prePaymentKey,
          transaction_id: realTransactionId,
          authorization_code: authorizationCode,
          processed_at: finalStatus === 'concluded' ? new Date().toISOString() : null,
        })
        .select()
        .single();

      if (insertError || !newSplit) {
        console.error('[conclude-card-payment] Error creating split:', insertError);
        throw insertError;
      }

      splitId = newSplit.id;
    }

    console.log('[conclude-card-payment] Split processed:', splitId, 'Final status:', finalStatus);

    // Se pagamento foi confirmado como failed/cancelled, também remover PIX pendentes
    if (finalStatus === 'failed' || finalStatus === 'expired' || finalStatus === 'cancelled') {
      const { error: deleteError } = await supabase
        .from('payment_splits')
        .delete()
        .eq('payment_link_id', payment_link_id)
        .eq('method', 'pix')
        .eq('status', 'pending');

      if (deleteError) {
        console.warn('[conclude-card-payment] Could not delete pending PIX splits:', deleteError);
      }
    }

    // Atualizar status do charge baseado em todos os splits
    if (chargeId) {
      const { data: allSplits } = await supabase
        .from('payment_splits')
        .select('status, method')
        .eq('charge_id', chargeId);

      // GUARD: Só atualizar charge se houver splits (evita marcar como failed sem pagamento iniciado)
      if (allSplits && allSplits.length > 0) {
        const allConcluded = allSplits.every(s => s.status === 'concluded');
        const anyAnalyzing = allSplits.some(s => s.status === 'analyzing');
        const anyFailed = allSplits.some(s => s.status === 'failed' || s.status === 'expired');
        const anyCancelled = allSplits.some(s => s.status === 'cancelled');
        const anyConcluded = allSplits.some(s => s.status === 'concluded');

        let chargeStatus = 'pending';
        if (allConcluded && allSplits.length > 0) {
          chargeStatus = 'completed';
        } else if (anyCancelled && !anyConcluded) {
          chargeStatus = 'cancelled'; // Cancelado pela API Quita+
        } else if (anyFailed && !anyConcluded) {
          chargeStatus = 'failed';
        } else if (anyAnalyzing) {
          chargeStatus = 'processing'; // Em análise - aguardando confirmação
        } else if (anyConcluded) {
          chargeStatus = 'processing'; // Parcialmente pago
        }

        // Check if status is manually locked by admin
        const { data: chargeCheck } = await supabase
          .from('charges')
          .select('status_locked_at')
          .eq('id', chargeId)
          .single();

        if (chargeCheck?.status_locked_at) {
          console.log('[conclude-card-payment] Status locked manually for charge', chargeId, '- skipping auto update');
        } else {
          console.log('[conclude-card-payment] Updating charge status to:', chargeStatus);
          await supabase
            .from('charges')
            .update({ status: chargeStatus })
            .eq('id', chargeId);
        }
      } else {
        console.log('[conclude-card-payment] Skipping charge update - no splits found for charge:', chargeId);
      }
    }

    console.log('[conclude-card-payment] Payment conclusion completed. Final status:', finalStatus, 'Validated by API:', statusFromApi);

    return new Response(
      JSON.stringify({ 
        ok: true, 
        splitId, 
        status: finalStatus,
        authorizationCode,
        transactionId: realTransactionId,
        validatedByApi: statusFromApi
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[conclude-card-payment] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

}
