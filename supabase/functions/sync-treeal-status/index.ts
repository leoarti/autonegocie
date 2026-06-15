// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  buildMtlsCredentials,
  fetchMtls,
  getAccessToken,
  loadTreealConfig,
  mapTreealStatus,
  TREEAL_CASHIN_URL,
} from "../_shared/treeal-auth.ts";
import {
  cancelPendingSiblings,
  tryCompleteCharge,
} from "../_shared/charge-completion.ts";

/**
 * sync-treeal-status
 * Batch sync for Treeal PIX payments — equivalent of sync-mercadopago-status.
 *
 * Finds all PIX splits with status='pending', mp_payment_id IS NOT NULL,
 * where the mp_payment_id is a 32-char hex UUID (Treeal format, NOT AbacatePay
 * which uses "pix_char_*" prefix). Queries Treeal's COB API for each.
 *
 * Should be invoked on a cron schedule (e.g., every 5 minutes).
 */

// Treeal txids are 32-char hex (UUID without dashes). AbacatePay IDs start with "pix_char_".
function isTreealTxid(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const config = loadTreealConfig();
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Find pending PIX splits with mp_payment_id, created in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: pendingSplits, error: fetchError } = await supabase
      .from("payment_splits")
      .select("id, mp_payment_id, charge_id")
      .eq("method", "pix")
      .eq("status", "pending")
      .not("mp_payment_id", "is", null)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: true })
      .limit(50);

    if (fetchError) {
      console.error("[sync-treeal-status] Error fetching pending splits:", fetchError);
      return new Response(
        JSON.stringify({ error: "Erro ao buscar splits pendentes" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Filter only Treeal txids (exclude AbacatePay)
    const treealSplits = (pendingSplits || []).filter(
      (s) => s.mp_payment_id && isTreealTxid(s.mp_payment_id),
    );

    if (treealSplits.length === 0) {
      console.log("[sync-treeal-status] No pending Treeal PIX splits to sync");
      return new Response(
        JSON.stringify({ success: true, synced: 0, message: "Nenhum PIX Treeal pendente" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[sync-treeal-status] Syncing ${treealSplits.length} pending Treeal PIX payments`);

    // 2. Authenticate once for the batch
    const creds = buildMtlsCredentials(config.certBase64, config.certPassword);
    const accessToken = await getAccessToken(creds, config.clientId, config.clientSecret);

    let synced = 0;
    let concluded = 0;
    let failed = 0;
    const errors: string[] = [];
    const concludedChargeIds = new Set<string>();

    // 3. Check each split against Treeal API
    for (const split of treealSplits) {
      try {
        const cobResponse = await fetchMtls(
          `${TREEAL_CASHIN_URL}/cob/${split.mp_payment_id}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${accessToken}` },
          },
          creds,
        );

        if (!cobResponse.ok) {
          const errorText = await cobResponse.text();
          console.error(`[sync-treeal-status] Split ${split.id}: API error ${cobResponse.status}`, errorText);
          errors.push(`Split ${split.id}: API error ${cobResponse.status}`);
          continue;
        }

        const cobData = (await cobResponse.json()) as Record<string, unknown>;
        const treealStatus = (cobData.status as string) || "ATIVA";
        const internalStatus = mapTreealStatus(treealStatus);
        const isPaid = treealStatus === "CONCLUIDA";

        const updateData: Record<string, unknown> = {
          mp_status: treealStatus,
          status: internalStatus,
        };

        if (isPaid) {
          updateData.pix_paid_at = new Date().toISOString();
          updateData.processed_at = new Date().toISOString();
          concluded++;
          if (split.charge_id) concludedChargeIds.add(split.charge_id);
        } else if (internalStatus === "failed") {
          failed++;
        }

        await supabase.from("payment_splits").update(updateData).eq("id", split.id);
        synced++;

        if (isPaid && split.charge_id) {
          await cancelPendingSiblings(supabase, split.charge_id, split.id, "pix");
        }

        console.log(`[sync-treeal-status] Split ${split.id}: ${treealStatus} → ${internalStatus}`);

        // Rate limit: 100ms between API calls
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`[sync-treeal-status] Error syncing split ${split.id}:`, error);
        errors.push(`Split ${split.id}: ${String(error)}`);
      }
    }

    // 4. Try to complete each charge whose split foi concluded neste batch
    for (const chargeId of concludedChargeIds) {
      await tryCompleteCharge(supabase, chargeId);
    }

    // 5. Varrer charges PIX pending para fechar as órfãs (concluded antigo + irmão pending)
    const { data: orphanedCharges } = await supabase
      .from("charges")
      .select("id")
      .eq("status", "pending")
      .in("payment_method", ["pix", "cartao_pix"]);

    if (orphanedCharges && orphanedCharges.length > 0) {
      console.log(
        `[sync-treeal-status] Checking ${orphanedCharges.length} potentially orphaned charges`,
      );

      for (const charge of orphanedCharges) {
        await tryCompleteCharge(supabase, charge.id);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        synced,
        concluded,
        failed,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[sync-treeal-status] Fatal error:", error);
    return new Response(
      JSON.stringify({ error: "Erro interno", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});