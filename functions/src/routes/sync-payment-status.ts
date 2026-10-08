import { callRoute, createClient } from '../db';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mapeamento de statusCode da API Cappta para status interno (charge-level)
const statusCodeMap: Record<number, string> = {
  1: "pre_authorized",       // Received
  2: "cancelled",            // Canceled
  3: "boleto_linked",        // BarcodeAssigned
  4: "processing",           // Settled
  5: "payment_denied",       // PaymentDenied
  6: "approved",             // PaymentValidated
  7: "awaiting_validation",  // AwaitingPayerValidation
  8: "validating",           // ValidatingPayment
  9: "completed",            // Paid
  50: "failed",              // MissingRegistryBankslipCNPJ
};

// Mapeamento de statusCode da API Cappta para status de split (split-level)
// Alinhado com conclude-card-payment para consistência
const splitStatusCodeMap: Record<number, string> = {
  1: "analyzing",            // Received
  2: "cancelled",            // Canceled
  3: "boleto_linked",        // BarcodeAssigned
  4: "validating",           // Settled
  5: "failed",               // PaymentDenied
  6: "approved",             // PaymentValidated
  7: "awaiting_validation",  // AwaitingPayerValidation
  8: "validating",           // ValidatingPayment
  9: "concluded",            // Paid
  50: "failed",              // MissingRegistryBankslipCNPJ
};

// Status considerados terminais (não devem ser re-verificados após 5 tentativas)
const TERMINAL_STATUSES = ["failed", "cancelled", "payment_denied"];

// Período de verificação: últimos 90 dias
const SYNC_DAYS_WINDOW = 90;

// Máximo de tentativas de re-verificação para status terminais
const MAX_SYNC_ATTEMPTS = 5;

/**
 * Deriva o status do charge a partir dos status de TODOS os splits.
 * Mesma lógica usada no sync-card-status para consistência.
 */
function deriveChargeStatusFromSplits(splits: Array<{ status: string }>): string {
  if (!splits || splits.length === 0) return "pending";

  const statuses = splits.map(s => s.status);
  const allConcluded = statuses.every(s => s === "concluded");
  const someConcluded = statuses.some(s => s === "concluded");
  const someCancelled = statuses.some(s => s === "cancelled");
  const someFailed = statuses.some(s => s === "failed");
  const someAnalyzing = statuses.some(s => s === "analyzing");
  const someProcessing = statuses.some(s => ["validating", "approved", "awaiting_validation", "boleto_linked"].includes(s));

  if (allConcluded) return "completed";
  if (someConcluded) return "processing"; // Parcialmente pago
  if (someCancelled && !someConcluded) return "cancelled";
  if (someFailed && !someConcluded) return "failed";
  if (someAnalyzing || someProcessing) return "processing";
  return "pending";
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log("[sync-payment-status] Iniciando sincronização...");

  try {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Calcular data limite (últimos 90 dias)
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - SYNC_DAYS_WINDOW);
    const dateLimitISO = dateLimit.toISOString();

    // Calcular data limite para cobranças terminais (últimas 48h)
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoISO = twoDaysAgo.toISOString();

    console.log(`[sync-payment-status] Buscando cobranças com pre_payment_key dos últimos ${SYNC_DAYS_WINDOW} dias (desde ${dateLimitISO})`);

    // Buscar cobranças ativas (não-terminais) - incluindo payment_method para lógica de splits
    const { data: activeCharges, error: activeChargesError } = await supabase
      .from("charges")
      .select("id, pre_payment_key, status, company_id, payer_name, amount, boleto_linked_at, completed_at, sync_attempts, payment_method")
      .not("pre_payment_key", "is", null)
      .not("status", "in", '("completed","cancelled","payment_denied","failed")')
      .gte("created_at", dateLimitISO)
      .order("created_at", { ascending: false })
      .limit(25);

    if (activeChargesError) {
      console.error("[sync-payment-status] Erro ao buscar cobranças ativas:", activeChargesError);
      throw activeChargesError;
    }

    // Buscar cobranças terminais das últimas 48h com sync_attempts < 5
    const { data: terminalCharges, error: terminalChargesError } = await supabase
      .from("charges")
      .select("id, pre_payment_key, status, company_id, payer_name, amount, boleto_linked_at, completed_at, sync_attempts, payment_method")
      .not("pre_payment_key", "is", null)
      .eq("status", "failed")
      .lt("sync_attempts", MAX_SYNC_ATTEMPTS)
      .gte("created_at", twoDaysAgoISO)
      .order("created_at", { ascending: false })
      .limit(10);

    if (terminalChargesError) {
      console.error("[sync-payment-status] Erro ao buscar cobranças terminais:", terminalChargesError);
    }

    // Combinar listas sem duplicatas
    const allCharges = [...(activeCharges || [])];
    if (terminalCharges) {
      for (const tc of terminalCharges) {
        if (!allCharges.find(c => c.id === tc.id)) {
          allCharges.push(tc);
        }
      }
    }

    console.log(`[sync-payment-status] Total: ${allCharges.length} cobranças (${activeCharges?.length || 0} ativas + ${terminalCharges?.length || 0} terminais para re-verificar)`);

    if (allCharges.length === 0) {
      console.log("[sync-payment-status] Nenhuma cobrança com pre_payment_key encontrada no período");
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "Nenhuma cobrança com cartão para sincronizar no período",
          processed: 0,
          updated: 0,
          terminal_rechecked: 0,
          duration_ms: Date.now() - startTime
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // CORREÇÃO: Detectar e corrigir cobranças com status inconsistente
    const { data: inconsistentCharges } = await supabase
      .from("charges")
      .select("id, status")
      .eq("status", "pre_authorized")
      .is("pre_payment_key", null)
      .gte("created_at", dateLimitISO);

    if (inconsistentCharges && inconsistentCharges.length > 0) {
      console.log(`[sync-payment-status] ⚠️ Encontradas ${inconsistentCharges.length} cobranças com status inconsistente (pre_authorized sem pre_payment_key)`);
      
      for (const charge of inconsistentCharges) {
        const { error: fixError } = await supabase
          .from("charges")
          .update({ 
            status: "pending", 
            payment_authorized_at: null,
            updated_at: new Date().toISOString() 
          })
          .eq("id", charge.id);
        
        if (fixError) {
          console.error(`[sync-payment-status] Erro ao corrigir ${charge.id}:`, fixError);
        } else {
          console.log(`[sync-payment-status] ✅ Cobrança ${charge.id} corrigida: pre_authorized → pending`);
        }
      }
    }

    const results: Array<{
      chargeId: string;
      oldStatus: string;
      newStatus: string | null;
      apiStatusCode: number | null;
      updated: boolean;
      syncAttempts?: number;
      isCombined?: boolean;
      splitUpdated?: boolean;
      derivedFromSplits?: boolean;
      error?: string;
    }> = [];

    let terminalRechecked = 0;

    // Processar cada cobrança
    for (const charge of allCharges) {
      try {
        const isTerminalCharge = TERMINAL_STATUSES.includes(charge.status);
        const currentSyncAttempts = charge.sync_attempts || 0;
        const isCombined = charge.payment_method === "cartao_pix";
        
        if (isTerminalCharge) {
          terminalRechecked++;
          console.log(`[sync-payment-status] Re-verificando cobrança terminal ${charge.id} (${charge.payer_name}), tentativa ${currentSyncAttempts + 1}/${MAX_SYNC_ATTEMPTS}`);
        } else {
          console.log(`[sync-payment-status] Verificando charge ${charge.id} (${charge.payer_name}) [${isCombined ? 'COMBINADO' : 'SIMPLES'}]`);
        }

        // Chamar quitaplus-prepayment-status
        const statusResponse = await callRoute('quitaplus-prepayment-status', {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({ prePaymentKey: charge.pre_payment_key }),
          }
        );

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text();
          console.error(`[sync-payment-status] Erro na API para ${charge.id}:`, errorText);
          results.push({
            chargeId: charge.id,
            oldStatus: charge.status,
            newStatus: null,
            apiStatusCode: null,
            updated: false,
            isCombined,
            syncAttempts: currentSyncAttempts,
            error: `API error: ${statusResponse.status}`,
          });
          continue;
        }

        const statusData = await statusResponse.json();
        const apiStatusCode = statusData.statusCode;

        console.log(`[sync-payment-status] Charge ${charge.id}: API statusCode=${apiStatusCode}, payment_method=${charge.payment_method}`);

        // ============================================================
        // FLUXO DIFERENCIADO: combinado vs simples
        // ============================================================
        if (isCombined) {
          // PAGAMENTO COMBINADO (cartao_pix): atualizar split + derivar charge status
          const splitStatus = splitStatusCodeMap[apiStatusCode];
          if (!splitStatus) {
            console.warn(`[sync-payment-status] StatusCode ${apiStatusCode} não mapeado para split. Ignorando charge ${charge.id}.`);
            results.push({
              chargeId: charge.id,
              oldStatus: charge.status,
              newStatus: null,
              apiStatusCode,
              updated: false,
              isCombined: true,
              error: `Unmapped statusCode for split: ${apiStatusCode}`,
            });
            continue;
          }

          // a) Buscar split de cartão pelo pre_payment_key do charge
          const { data: cardSplit, error: cardSplitError } = await supabase
            .from("payment_splits")
            .select("id, status, charge_id")
            .eq("charge_id", charge.id)
            .eq("method", "credit_card")
            .maybeSingle();

          if (cardSplitError) {
            console.error(`[sync-payment-status] Erro ao buscar split de cartão para ${charge.id}:`, cardSplitError);
            results.push({
              chargeId: charge.id,
              oldStatus: charge.status,
              newStatus: null,
              apiStatusCode,
              updated: false,
              isCombined: true,
              error: `Split query error: ${cardSplitError.message}`,
            });
            continue;
          }

          if (!cardSplit) {
            console.warn(`[sync-payment-status] Nenhum split credit_card encontrado para charge ${charge.id}. Usando mapeamento direto.`);
            // Fallback: sem split, usar lógica direta (como charge simples)
            const fallbackStatus = statusCodeMap[apiStatusCode] || charge.status;
            if (fallbackStatus !== charge.status) {
              const updateData: Record<string, unknown> = {
                status: fallbackStatus,
                sync_attempts: 0,
                updated_at: new Date().toISOString(),
              };
              if (fallbackStatus === "completed" && !charge.completed_at) {
                updateData.completed_at = new Date().toISOString();
              }
              const { error: updateError } = await supabase.from("charges").update(updateData).eq("id", charge.id);
              if (!updateError) {
                console.log(`[sync-payment-status] ✅ Charge combinado ${charge.id} (sem splits): ${charge.status} → ${fallbackStatus}`);
                await supabase.from("charge_executions").insert({
                  charge_id: charge.id,
                  company_id: charge.company_id,
                  status: fallbackStatus,
                  execution_log: {
                    source: "sync-payment-status",
                    previous_status: charge.status,
                    api_status_code: apiStatusCode,
                    note: "combined_no_splits_fallback",
                    synced_at: new Date().toISOString(),
                  },
                });
              }
              results.push({
                chargeId: charge.id,
                oldStatus: charge.status,
                newStatus: fallbackStatus,
                apiStatusCode,
                updated: !updateError,
                isCombined: true,
                splitUpdated: false,
                derivedFromSplits: false,
              });
            } else {
              results.push({
                chargeId: charge.id,
                oldStatus: charge.status,
                newStatus: fallbackStatus,
                apiStatusCode,
                updated: false,
                isCombined: true,
                splitUpdated: false,
                derivedFromSplits: false,
              });
            }
            continue;
          }

          // b) Atualizar split de cartão com o status da API
          let splitUpdated = false;
          if (cardSplit.status !== splitStatus) {
            const splitUpdateData: Record<string, unknown> = {
              status: splitStatus,
            };
            if (splitStatus === "concluded" || splitStatus === "cancelled" || splitStatus === "failed") {
              splitUpdateData.processed_at = new Date().toISOString();
            }

            const { error: splitUpdateError } = await supabase
              .from("payment_splits")
              .update(splitUpdateData)
              .eq("id", cardSplit.id);

            if (splitUpdateError) {
              console.error(`[sync-payment-status] Erro ao atualizar split ${cardSplit.id}:`, splitUpdateError);
            } else {
              console.log(`[sync-payment-status] Split ${cardSplit.id} atualizado: ${cardSplit.status} → ${splitStatus}`);
              splitUpdated = true;
            }
          } else {
            console.log(`[sync-payment-status] Split ${cardSplit.id} já está em ${splitStatus}, sem alteração.`);
          }

          // c) Buscar TODOS os splits do charge para derivar status
          const { data: allSplits, error: allSplitsError } = await supabase
            .from("payment_splits")
            .select("id, status, method")
            .eq("charge_id", charge.id);

          if (allSplitsError) {
            console.error(`[sync-payment-status] Erro ao buscar todos os splits de ${charge.id}:`, allSplitsError);
            results.push({
              chargeId: charge.id,
              oldStatus: charge.status,
              newStatus: null,
              apiStatusCode,
              updated: splitUpdated,
              isCombined: true,
              splitUpdated,
              derivedFromSplits: false,
              error: `All splits query error: ${allSplitsError.message}`,
            });
            continue;
          }

          // d) Derivar o charge status a partir dos splits
          const derivedStatus = deriveChargeStatusFromSplits(allSplits || []);
          console.log(`[sync-payment-status] Charge ${charge.id}: splits=${JSON.stringify(allSplits?.map(s => ({m: s.method, s: s.status})))}, derivado=${derivedStatus}, atual=${charge.status}`);

          // e) Atualizar charge com status derivado
          if (derivedStatus !== charge.status) {
            const chargeUpdateData: Record<string, unknown> = {
              status: derivedStatus,
              sync_attempts: 0,
              updated_at: new Date().toISOString(),
            };
            if (derivedStatus === "completed" && !charge.completed_at) {
              chargeUpdateData.completed_at = new Date().toISOString();
            }
            if (derivedStatus === "boleto_linked" && !charge.boleto_linked_at) {
              chargeUpdateData.boleto_linked_at = new Date().toISOString();
            }

            const { error: chargeUpdateError } = await supabase
              .from("charges")
              .update(chargeUpdateData)
              .eq("id", charge.id);

            if (chargeUpdateError) {
              console.error(`[sync-payment-status] Erro ao atualizar charge ${charge.id}:`, chargeUpdateError);
              results.push({
                chargeId: charge.id,
                oldStatus: charge.status,
                newStatus: derivedStatus,
                apiStatusCode,
                updated: false,
                isCombined: true,
                splitUpdated,
                derivedFromSplits: true,
                error: chargeUpdateError.message,
              });
            } else {
              console.log(`[sync-payment-status] ✅ Charge combinado ${charge.id}: ${charge.status} → ${derivedStatus} (derivado dos splits)`);
              
              await supabase.from("charge_executions").insert({
                charge_id: charge.id,
                company_id: charge.company_id,
                status: derivedStatus,
                execution_log: {
                  source: "sync-payment-status",
                  previous_status: charge.status,
                  api_status_code: apiStatusCode,
                  split_status: splitStatus,
                  derived_from_splits: true,
                  splits_snapshot: allSplits?.map(s => ({ method: s.method, status: s.status })),
                  synced_at: new Date().toISOString(),
                },
              });

              results.push({
                chargeId: charge.id,
                oldStatus: charge.status,
                newStatus: derivedStatus,
                apiStatusCode,
                updated: true,
                isCombined: true,
                splitUpdated,
                derivedFromSplits: true,
                syncAttempts: 0,
              });
            }
          } else {
            // Status não mudou - incrementar sync_attempts se terminal
            if (isTerminalCharge) {
              const newSyncAttempts = currentSyncAttempts + 1;
              await supabase
                .from("charges")
                .update({ sync_attempts: newSyncAttempts, updated_at: new Date().toISOString() })
                .eq("id", charge.id);
              console.log(`[sync-payment-status] Charge combinado ${charge.id} manteve status ${charge.status}, tentativa ${newSyncAttempts}/${MAX_SYNC_ATTEMPTS}`);
            }

            results.push({
              chargeId: charge.id,
              oldStatus: charge.status,
              newStatus: derivedStatus,
              apiStatusCode,
              updated: false,
              isCombined: true,
              splitUpdated,
              derivedFromSplits: true,
              syncAttempts: isTerminalCharge ? currentSyncAttempts + 1 : currentSyncAttempts,
            });
          }
        } else {
          // ============================================================
          // PAGAMENTO SIMPLES (cartao puro): mapeamento direto (comportamento original)
          // ============================================================
          const newStatus = statusCodeMap[apiStatusCode] || charge.status;

          console.log(`[sync-payment-status] Charge ${charge.id}: API status=${apiStatusCode}, interno=${newStatus}, atual=${charge.status}`);

          if (newStatus !== charge.status) {
            const updateData: Record<string, unknown> = {
              status: newStatus,
              sync_attempts: 0,
              updated_at: new Date().toISOString(),
            };

            if (newStatus === "boleto_linked" && !charge.boleto_linked_at) {
              updateData.boleto_linked_at = new Date().toISOString();
            }
            if (newStatus === "completed" && !charge.completed_at) {
              updateData.completed_at = new Date().toISOString();
            }

            const { error: updateError } = await supabase
              .from("charges")
              .update(updateData)
              .eq("id", charge.id);

            if (updateError) {
              console.error(`[sync-payment-status] Erro ao atualizar ${charge.id}:`, updateError);
              results.push({
                chargeId: charge.id,
                oldStatus: charge.status,
                newStatus,
                apiStatusCode,
                updated: false,
                isCombined: false,
                syncAttempts: currentSyncAttempts,
                error: updateError.message,
              });
            } else {
              console.log(`[sync-payment-status] ✅ Charge ${charge.id} atualizado: ${charge.status} → ${newStatus} (sync_attempts resetado)`);

              await supabase.from("charge_executions").insert({
                charge_id: charge.id,
                company_id: charge.company_id,
                status: newStatus,
                execution_log: {
                  source: "sync-payment-status",
                  previous_status: charge.status,
                  api_status_code: apiStatusCode,
                  synced_at: new Date().toISOString(),
                  sync_attempts_before: currentSyncAttempts,
                  sync_attempts_after: 0,
                },
              });

              results.push({
                chargeId: charge.id,
                oldStatus: charge.status,
                newStatus,
                apiStatusCode,
                updated: true,
                isCombined: false,
                syncAttempts: 0,
              });
            }
          } else {
            // STATUS NÃO MUDOU - incrementar contador SE for terminal
            if (isTerminalCharge) {
              const newSyncAttempts = currentSyncAttempts + 1;
              
              const { error: incError } = await supabase
                .from("charges")
                .update({ 
                  sync_attempts: newSyncAttempts,
                  updated_at: new Date().toISOString()
                })
                .eq("id", charge.id);
              
              if (incError) {
                console.error(`[sync-payment-status] Erro ao incrementar sync_attempts para ${charge.id}:`, incError);
              } else {
                console.log(`[sync-payment-status] Charge ${charge.id} manteve status ${charge.status}, tentativa ${newSyncAttempts}/${MAX_SYNC_ATTEMPTS}`);
                
                if (newSyncAttempts >= MAX_SYNC_ATTEMPTS) {
                  console.log(`[sync-payment-status] ⚠️ Charge ${charge.id} atingiu limite de ${MAX_SYNC_ATTEMPTS} tentativas, não será mais re-verificada`);
                }
              }

              results.push({
                chargeId: charge.id,
                oldStatus: charge.status,
                newStatus,
                apiStatusCode,
                updated: false,
                isCombined: false,
                syncAttempts: newSyncAttempts,
              });
            } else {
              results.push({
                chargeId: charge.id,
                oldStatus: charge.status,
                newStatus,
                apiStatusCode,
                updated: false,
                isCombined: false,
                syncAttempts: currentSyncAttempts,
              });
            }
          }
        }

        // Rate limiting: aguardar 500ms entre chamadas
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (chargeError) {
        console.error(`[sync-payment-status] Erro ao processar ${charge.id}:`, chargeError);
        results.push({
          chargeId: charge.id,
          oldStatus: charge.status,
          newStatus: null,
          apiStatusCode: null,
          updated: false,
          error: String(chargeError),
        });
      }
    }

    const updatedCount = results.filter((r) => r.updated).length;
    const combinedCount = results.filter((r) => r.isCombined).length;
    const duration = Date.now() - startTime;

    console.log(`[sync-payment-status] Sincronização concluída: ${updatedCount}/${allCharges.length} atualizados (${combinedCount} combinados, ${terminalRechecked} terminais re-verificadas) em ${duration}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: allCharges.length,
        updated: updatedCount,
        combined_processed: combinedCount,
        terminal_rechecked: terminalRechecked,
        duration_ms: duration,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[sync-payment-status] Erro geral:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: String(error),
        duration_ms: Date.now() - startTime,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

}
