import { createClient, functionUrl } from '../db';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface StatusRequest {
  payment_split_id?: string;
  mp_payment_id?: string;
}

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

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const abacateApiKey = process.env.ABACATEPAY_API_KEY;

    if (!abacateApiKey) {
      return new Response(
        JSON.stringify({ error: "AbacatePay não configurado" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: StatusRequest = await req.json();
    const { payment_split_id, mp_payment_id } = body;

    let paymentId = mp_payment_id;

    // If we have payment_split_id, fetch the mp_payment_id from DB
    if (payment_split_id && !paymentId) {
      const { data: split, error } = await supabase
        .from("payment_splits")
        .select("mp_payment_id, status, pix_paid_at")
        .eq("id", payment_split_id)
        .single();

      if (error || !split) {
        return new Response(
          JSON.stringify({ error: "Split não encontrado" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // If already concluded, return immediately
      if (split.status === "concluded" || split.pix_paid_at) {
        return new Response(
          JSON.stringify({
            success: true,
            status: "concluded",
            internal_status: "concluded",
            pix_paid: true,
            pix_paid_at: split.pix_paid_at,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      paymentId = split.mp_payment_id;
    }

    if (!paymentId) {
      return new Response(
        JSON.stringify({ error: "Payment ID não fornecido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Checking status for AbacatePay payment:", paymentId);

    // Fetch status from AbacatePay
    const abacateResponse = await fetch(
      `https://api.abacatepay.com/v1/pixQrCode/check?id=${paymentId}`,
      {
        headers: {
          "Authorization": `Bearer ${abacateApiKey}`,
        },
      }
    );

    if (!abacateResponse.ok) {
      const errorData = await abacateResponse.text();
      console.error("AbacatePay status error:", errorData);
      return new Response(
        JSON.stringify({ error: "Erro ao consultar status", details: errorData }),
        { status: abacateResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const abacateData = await abacateResponse.json();
    const abacateStatus = abacateData?.data?.status || "PENDING";
    console.log("AbacatePay status:", abacateStatus);

    const internalStatus = mapAbacateStatusToInternal(abacateStatus);
    const isPaid = abacateStatus === "PAID";

    // Update payment_split if we have the ID
    if (payment_split_id) {
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
        .eq("id", payment_split_id);

      if (updateError) {
        console.error("Error updating split:", updateError);
      }

      // If paid, check if all splits are concluded and update charge status
      if (isPaid) {
        const { data: splitData } = await supabase
          .from("payment_splits")
          .select("charge_id")
          .eq("id", payment_split_id)
          .single();

        if (splitData?.charge_id) {
          const { data: allSplits } = await supabase
            .from("payment_splits")
            .select("id, status")
            .eq("charge_id", splitData.charge_id);

          const allConcluded = allSplits?.every(s =>
            s.id === payment_split_id ? true : s.status === "concluded"
          );

          if (allConcluded) {
            const { error: chargeError } = await supabase
              .from("charges")
              .update({
                status: "completed",
                completed_at: new Date().toISOString(),
                metadata: { pix_paid_at: new Date().toISOString() },
              })
              .eq("id", splitData.charge_id);

            if (chargeError) {
              console.error("Error updating charge status:", chargeError);
            } else {
              console.log("Charge status updated to completed:", splitData.charge_id);
            }
          }
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        mp_payment_id: paymentId,
        status: abacateStatus,
        internal_status: internalStatus,
        pix_paid: isPaid,
        pix_paid_at: isPaid ? new Date().toISOString() : null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error checking PIX status:", error);
    return new Response(
      JSON.stringify({ error: "Erro interno", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

}
