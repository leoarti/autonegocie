import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  cancelPendingSiblings,
  tryCompleteCharge,
} from "../_shared/charge-completion.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Map AbacatePay status to internal status
function mapAbacateStatusToInternal(status: string): string {
  switch (status) {
    case "PAID":
      return "concluded";
    case "PENDING":
      return "pending";
    case "EXPIRED":
    case "CANCELLED":
    case "REFUNDED":
      return "failed";
    default:
      return "pending";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const abacateApiKey = Deno.env.get("ABACATEPAY_API_KEY");

    if (!abacateApiKey) {
      return new Response(
        JSON.stringify({ error: "AbacatePay não configurado" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Find all pending PIX splits with mp_payment_id
    const { data: pendingSplits, error: fetchError } = await supabase
      .from("payment_splits")
      .select("id, mp_payment_id, charge_id, payment_link_id, created_at")
      .eq("method", "pix")
      .eq("status", "pending")
      .not("mp_payment_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(50);

    if (fetchError) {
      console.error("Error fetching pending splits:", fetchError);
      return new Response(
        JSON.stringify({ error: "Erro ao buscar splits pendentes" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!pendingSplits || pendingSplits.length === 0) {
      console.log("No pending PIX splits to sync");
      return new Response(
        JSON.stringify({ success: true, synced: 0, message: "Nenhum PIX pendente" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Syncing ${pendingSplits.length} pending PIX payments via AbacatePay`);

    let synced = 0;
    let approved = 0;
    let failed = 0;
    const errors: string[] = [];
    const updatedCharges = new Set<string>();

    for (const split of pendingSplits) {
      try {
        const abacateResponse = await fetch(
          `https://api.abacatepay.com/v1/pixQrCode/check?id=${split.mp_payment_id}`,
          {
            headers: {
              "Authorization": `Bearer ${abacateApiKey}`,
            },
          }
        );

        if (!abacateResponse.ok) {
          console.error(`Error fetching payment ${split.mp_payment_id}:`, abacateResponse.status);
          errors.push(`Split ${split.id}: API error ${abacateResponse.status}`);
          await abacateResponse.text(); // consume body
          continue;
        }

        const abacateData = await abacateResponse.json();
        const abacateStatus = abacateData?.data?.status || "PENDING";
        const internalStatus = mapAbacateStatusToInternal(abacateStatus);
        const isPaid = abacateStatus === "PAID";

        const updateData: Record<string, unknown> = {
          mp_status: abacateStatus,
          status: internalStatus,
        };

        if (isPaid) {
          updateData.pix_paid_at = new Date().toISOString();
          updateData.processed_at = new Date().toISOString();
          approved++;
        } else if (internalStatus === "failed") {
          failed++;
        }

        await supabase
          .from("payment_splits")
          .update(updateData)
          .eq("id", split.id);

        synced++;
        console.log(`Synced split ${split.id}: ${abacateStatus}`);

        if (isPaid && split.charge_id) {
          await cancelPendingSiblings(supabase, split.charge_id, split.id, "pix");
        }

        if (split.charge_id) {
          updatedCharges.add(split.charge_id);
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error syncing split ${split.id}:`, error);
        errors.push(`Split ${split.id}: ${String(error)}`);
      }
    }

    // Tenta fechar cada charge cujo split foi concluded neste batch
    if (approved > 0) {
      const chargeIds = [...new Set(pendingSplits.filter(s => s.charge_id).map(s => s.charge_id))];
      for (const chargeId of chargeIds) {
        await tryCompleteCharge(supabase, chargeId);
      }
    }

    // Varrer charges PIX/combinado pending para fechar as órfãs
    const { data: orphanedCharges } = await supabase
      .from("charges")
      .select("id")
      .eq("status", "pending")
      .in("payment_method", ["pix", "cartao_pix"]);

    if (orphanedCharges && orphanedCharges.length > 0) {
      console.log(`Checking ${orphanedCharges.length} potentially orphaned charges`);
      for (const charge of orphanedCharges) {
        await tryCompleteCharge(supabase, charge.id);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        synced,
        approved,
        failed,
        errors: errors.length > 0 ? errors : undefined,
        updatedChargeIds: Array.from(updatedCharges),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Sync error:", error);
    return new Response(
      JSON.stringify({ error: "Erro interno", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
