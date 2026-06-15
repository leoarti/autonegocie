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

  // Accept GET requests for webhook validation
  if (req.method === "GET") {
    console.log("Webhook validation request received");
    return new Response("OK", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const abacateApiKey = Deno.env.get("ABACATEPAY_API_KEY");

    if (!abacateApiKey) {
      console.error("ABACATEPAY_API_KEY not configured");
      return new Response("Configuration error", { status: 500, headers: corsHeaders });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse webhook payload from AbacatePay
    const payload = await req.json();
    console.log("AbacatePay webhook received:", JSON.stringify(payload, null, 2));

    // Extract payment ID from the webhook payload
    // AbacatePay webhook format may vary - handle flexibly
    const paymentId = payload?.data?.id || payload?.id || payload?.pixQrCodeId;
    if (!paymentId) {
      console.log("No payment ID in webhook payload, ignoring");
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    // Find the payment_split by mp_payment_id (legacy column, stores AbacatePay ID)
    const { data: splits, error: findError } = await supabase
      .from("payment_splits")
      .select("id, charge_id, payment_link_id, status, method")
      .eq("mp_payment_id", String(paymentId))
      .limit(1);

    if (findError) {
      console.error("Error finding split:", findError);
      return new Response("Database error", { status: 500, headers: corsHeaders });
    }

    if (!splits || splits.length === 0) {
      console.log("No payment_split found for payment_id:", paymentId);
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    const split = splits[0];
    console.log("Found split:", split.id, "current status:", split.status);

    // Get current status from AbacatePay API for accuracy
    const abacateResponse = await fetch(
      `https://api.abacatepay.com/v1/pixQrCode/check?id=${paymentId}`,
      {
        headers: { "Authorization": `Bearer ${abacateApiKey}` },
      }
    );

    if (!abacateResponse.ok) {
      const errText = await abacateResponse.text();
      console.error("Error checking AbacatePay status:", errText);
      return new Response("Error checking status", { status: 500, headers: corsHeaders });
    }

    const abacateData = await abacateResponse.json();
    const abacateStatus = abacateData?.data?.status || "PENDING";
    const internalStatus = mapAbacateStatusToInternal(abacateStatus);
    const isPaid = abacateStatus === "PAID";

    // Update the payment_split
    const updateData: Record<string, unknown> = {
      mp_status: abacateStatus,
      status: internalStatus,
    };

    if (isPaid) {
      updateData.pix_paid_at = new Date().toISOString();
      updateData.processed_at = new Date().toISOString();
    }

    const { error: updateError } = await supabase
      .from("payment_splits")
      .update(updateData)
      .eq("id", split.id);

    if (updateError) {
      console.error("Error updating split:", updateError);
      return new Response("Database update error", { status: 500, headers: corsHeaders });
    }

    console.log("Updated split", split.id, "to status:", internalStatus);

    if (isPaid && split.charge_id) {
      await cancelPendingSiblings(supabase, split.charge_id, split.id, "pix");
      await tryCompleteCharge(supabase, split.charge_id);
    }

    return new Response("OK", { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response("Internal error", { status: 500, headers: corsHeaders });
  }
});
