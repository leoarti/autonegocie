import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeamento statusCode Quita+ → status interno do payment_split
// IMPORTANTE: Mapeamento correto segundo documentação API Quita+
// StatusCode 2 (Canceled) = cancelled, StatusCode 3 (BarcodeAssigned) = boleto_linked
const statusCodeMap: Record<number, string> = {
  1: 'analyzing',              // Received - pré-pagamento criado
  2: 'cancelled',              // Canceled - prazo expirou ou valor diferente
  3: 'boleto_linked',          // BarcodeAssigned - boleto vinculado ao pagamento
  4: 'validating',             // Settled - analisado pelo robô
  5: 'failed',                 // PaymentDenied - risco não aprovou
  6: 'approved',               // PaymentValidated - risco aprovou
  7: 'awaiting_validation',    // AwaitingPayerValidation - aguardando PIN
  8: 'validating',             // ValidatingPayment - risco analisando
  9: 'concluded',              // Paid - boleto foi pago
  50: 'failed',                // MissingRegistryBankslipCNPJ - CNPJ não cadastrado
};

// Rate limiting: esperar 1 segundo entre chamadas à API
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log('[sync-card-status] Starting card payment status sync job');

  try {
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

    // Buscar splits de cartão que precisam de verificação:
    // 1. Status 'pending' ou 'processing' dos últimos 7 dias
    // 2. Status 'concluded' mas sem authorization_code (inconsistentes)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoffDate = sevenDaysAgo.toISOString();

    console.log('[sync-card-status] Fetching card splits since:', cutoffDate);

    // Query 1: Splits pendentes/processando com pre_payment_key
    const { data: pendingSplits, error: pendingError } = await supabase
      .from('payment_splits')
      .select('id, charge_id, payment_link_id, pre_payment_key, status, authorization_code, method')
      .eq('method', 'credit_card')
      .in('status', ['pending', 'processing', 'analyzing', 'boleto_linked', 'approved', 'awaiting_validation', 'validating'])
      .not('pre_payment_key', 'is', null)
      .gte('created_at', cutoffDate)
      .limit(30);

    if (pendingError) {
      console.error('[sync-card-status] Error fetching pending splits:', pendingError);
    }

    // Query 2: Splits "concluded" mas sem authorization_code (possíveis inconsistências)
    const { data: inconsistentSplits, error: inconsistentError } = await supabase
      .from('payment_splits')
      .select('id, charge_id, payment_link_id, pre_payment_key, status, authorization_code, method')
      .eq('method', 'credit_card')
      .eq('status', 'concluded')
      .is('authorization_code', null)
      .not('pre_payment_key', 'is', null)
      .gte('created_at', cutoffDate)
      .limit(20);

    if (inconsistentError) {
      console.error('[sync-card-status] Error fetching inconsistent splits:', inconsistentError);
    }

    // Combinar e deduplicar por ID
    const allSplits = [...(pendingSplits || []), ...(inconsistentSplits || [])];
    const uniqueSplits = allSplits.filter((split, index, self) => 
      index === self.findIndex(s => s.id === split.id)
    );

    console.log('[sync-card-status] Found', uniqueSplits.length, 'splits to check:', {
      pending: pendingSplits?.length || 0,
      inconsistent: inconsistentSplits?.length || 0
    });

    const stats = {
      checked: 0,
      updated: 0,
      errors: 0,
      concluded: 0,
      failed: 0,
      unchanged: 0,
    };
    const updatedCharges = new Set<string>(); // Track updated charge IDs for frontend merge

    for (const split of uniqueSplits) {
      if (!split.pre_payment_key) {
        console.log('[sync-card-status] Skipping split without pre_payment_key:', split.id);
        continue;
      }

      stats.checked++;

      try {
        // Rate limiting
        if (stats.checked > 1) {
          await sleep(1000);
        }

        console.log('[sync-card-status] Checking split:', split.id, 'pre_payment_key:', split.pre_payment_key);

        // Chamar API de status
        const { data: statusData, error: statusError } = await supabase.functions.invoke('quitaplus-prepayment-status', {
          body: { prePaymentKey: split.pre_payment_key }
        });

        if (statusError || !statusData?.success) {
          console.warn('[sync-card-status] Failed to get status for split:', split.id, statusError);
          stats.errors++;
          continue;
        }

        const apiStatusCode = statusData.statusCode;
        const mappedStatus = statusCodeMap[apiStatusCode] || 'pending';
        const authorizationCode = statusData.authorizationCode || null;
        const transactionId = statusData.transactionId || null;

        console.log('[sync-card-status] API response for split', split.id, ':', {
          statusCode: apiStatusCode,
          statusName: statusData.statusName,
          mappedStatus,
          currentStatus: split.status,
          authorizationCode
        });

        // Verificar se precisa atualizar
        const needsUpdate = 
          split.status !== mappedStatus || 
          (mappedStatus === 'concluded' && !split.authorization_code && authorizationCode);

        if (!needsUpdate) {
          console.log('[sync-card-status] No update needed for split:', split.id);
          stats.unchanged++;
          continue;
        }

        // Atualizar split
        const updateData: Record<string, unknown> = {
          status: mappedStatus,
        };

        if (authorizationCode) {
          updateData.authorization_code = authorizationCode;
        }
        if (transactionId) {
          updateData.transaction_id = transactionId;
        }
        if (mappedStatus === 'concluded') {
          updateData.processed_at = new Date().toISOString();
        }

        const { error: updateError } = await supabase
          .from('payment_splits')
          .update(updateData)
          .eq('id', split.id);

        if (updateError) {
          console.error('[sync-card-status] Error updating split:', split.id, updateError);
          stats.errors++;
          continue;
        }

        console.log('[sync-card-status] Updated split', split.id, 'from', split.status, 'to', mappedStatus);
        stats.updated++;

        // Track updated charge ID for frontend merge
        if (split.charge_id) {
          updatedCharges.add(split.charge_id);
        }

        if (mappedStatus === 'concluded') {
          stats.concluded++;
        } else if (mappedStatus === 'failed' || mappedStatus === 'expired' || mappedStatus === 'cancelled') {
          stats.failed++;
        }

        // Atualizar status do charge se necessário
        if (split.charge_id) {
          const { data: allChargeSplits } = await supabase
            .from('payment_splits')
            .select('status')
            .eq('charge_id', split.charge_id);

          // GUARD: Só atualizar charge se houver splits (evita marcar como failed sem pagamento iniciado)
          if (allChargeSplits && allChargeSplits.length > 0) {
            const allConcluded = allChargeSplits.every(s => s.status === 'concluded');
            const anyFailed = allChargeSplits.some(s => s.status === 'failed' || s.status === 'expired');
            const anyCancelled = allChargeSplits.some(s => s.status === 'cancelled');
            const anyConcluded = allChargeSplits.some(s => s.status === 'concluded');

            let chargeStatus = 'pending';
            if (allConcluded && allChargeSplits.length > 0) {
              chargeStatus = 'completed';
            } else if (anyCancelled && !anyConcluded) {
              chargeStatus = 'cancelled'; // Cancelado pela API
            } else if (anyFailed && !anyConcluded) {
              chargeStatus = 'failed';
            } else if (anyConcluded) {
              chargeStatus = 'processing';
            }

            // Check if status is manually locked by admin
            const { data: chargeCheck } = await supabase
              .from('charges')
              .select('status_locked_at')
              .eq('id', split.charge_id)
              .single();

            if (chargeCheck?.status_locked_at) {
              console.log('[sync-card-status] Status locked manually for charge', split.charge_id, '- skipping auto update');
            } else {
              await supabase
                .from('charges')
                .update({ status: chargeStatus })
                .eq('id', split.charge_id);
            }

            console.log('[sync-card-status] Updated charge', split.charge_id, 'status to:', chargeStatus);
          } else {
            console.log('[sync-card-status] Skipping charge update - no splits found for charge:', split.charge_id);
          }
        }

      } catch (error) {
        console.error('[sync-card-status] Error processing split:', split.id, error);
        stats.errors++;
      }
    }

    console.log('[sync-card-status] Sync completed:', stats);

    return new Response(
      JSON.stringify({
        success: true,
        stats,
        updatedChargeIds: Array.from(updatedCharges), // Return updated charge IDs for frontend merge
        message: `Verificados: ${stats.checked}, Atualizados: ${stats.updated}, Concluídos: ${stats.concluded}, Falhos: ${stats.failed}, Erros: ${stats.errors}`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[sync-card-status] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

}
