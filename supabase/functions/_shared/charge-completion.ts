import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Helpers compartilhados para fechamento de charges após pagamento de splits.
 *
 * Regra de negócio (corrigida em 2026-06-15):
 *
 * Quando um split PIX é pago, todos os QRs/splits PIX irmãos que ficaram
 * pending viraram inúteis — o cliente já quitou aquela parcela. Esses
 * irmãos precisam ser marcados como `cancelled` para que não bloqueiem
 * o fechamento da charge nem confundam a UI.
 *
 * Para considerar uma charge completed: para CADA `method` presente nos
 * splits, basta UM split com status `concluded`. Isso difere de PIX puro
 * (1 método → 1 concluded basta) e pagamento combinado cartão+PIX
 * (cada método precisa ter um concluded).
 *
 * Bug histórico que isso conserta: a regra anterior exigia que TODOS os
 * splits não-failed estivessem concluded, o que travava charges PIX
 * indefinidamente quando havia múltiplos QRs gerados (regeneração ao
 * reabrir o link) e o cliente pagava um enquanto outro ainda estava ativo.
 */

/**
 * Marca como `cancelled` todos os splits irmãos do mesmo método que estão
 * `pending`, deixando intacto o split que acabou de virar concluded.
 *
 * Idempotente — pode ser chamada várias vezes sem efeito colateral.
 */
export async function cancelPendingSiblings(
  supabase: SupabaseClient,
  chargeId: string,
  paidSplitId: string,
  method = "pix",
): Promise<void> {
  const { error } = await supabase
    .from("payment_splits")
    .update({ status: "cancelled" })
    .eq("charge_id", chargeId)
    .eq("method", method)
    .eq("status", "pending")
    .neq("id", paidSplitId);

  if (error) {
    console.error(
      `[charge-completion] Falha ao cancelar splits irmãos da charge ${chargeId}:`,
      error,
    );
  }
}

/**
 * Avalia se a charge pode ser fechada e, se sim, atualiza para `completed`.
 *
 * Retorna `true` se a charge foi marcada como completed nesta chamada;
 * `false` caso a regra não tenha sido satisfeita ou a charge já estivesse
 * fechada / inexistente.
 */
export async function tryCompleteCharge(
  supabase: SupabaseClient,
  chargeId: string,
): Promise<boolean> {
  const { data: charge, error: chargeErr } = await supabase
    .from("charges")
    .select("id, status")
    .eq("id", chargeId)
    .single();

  if (chargeErr || !charge) return false;
  if (charge.status === "completed") return false;

  const { data: splits, error: splitsErr } = await supabase
    .from("payment_splits")
    .select("id, method, status")
    .eq("charge_id", chargeId);

  if (splitsErr || !splits || splits.length === 0) return false;

  const methods = Array.from(new Set(splits.map((s) => s.method)));
  const allMethodsCovered = methods.every((method) =>
    splits.some((s) => s.method === method && s.status === "concluded")
  );

  if (!allMethodsCovered) return false;

  const { error: updErr } = await supabase
    .from("charges")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", chargeId)
    .eq("status", charge.status);

  if (updErr) {
    console.error(
      `[charge-completion] Falha ao completar charge ${chargeId}:`,
      updErr,
    );
    return false;
  }

  console.log(`[charge-completion] Charge ${chargeId} marcada como completed`);
  return true;
}
