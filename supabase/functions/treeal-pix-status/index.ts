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

interface StatusRequest {
  payment_split_id?: string;
  mp_payment_id?: string;
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
    const body: StatusRequest = await req.json();
    const { payment_split_id, mp_payment_id } = body;

    let txid = mp_payment_id;

    if (payment_split_id && !txid) {
      const { data: split, error } = await supabase
        .from("payment_splits")
        .select("mp_payment_id, status, pix_paid_at")
        .eq("id", payment_split_id)
        .single();

      if (error || !split) {
        return new Response(
          JSON.stringify({ error: "Split não encontrado" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (split.status === "concluded" || split.pix_paid_at) {
        return new Response(
          JSON.stringify({
            success: true,
            status: "CONCLUIDA",
            internal_status: "concluded",
            pix_paid: true,
            pix_paid_at: split.pix_paid_at,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      txid = split.mp_payment_id;
    }

    if (!txid) {
      return new Response(
        JSON.stringify({ error: "txid (mp_payment_id) não fornecido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log("Checking Treeal COB status for txid:", txid);

    const creds = buildMtlsCredentials(config.certBase64, config.certPassword);
    const accessToken = await getAccessToken(creds, config.clientId, config.clientSecret);

    const cobResponse = await fetchMtls(
      `${TREEAL_CASHIN_URL}/cob/${txid}`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${accessToken}` },
      },
      creds,
    );

    if (!cobResponse.ok) {
      const errorText = await cobResponse.text();
      console.error("Treeal COB status error:", cobResponse.status, errorText);
      return new Response(
        JSON.stringify({ error: "Erro ao consultar status na Treeal", details: errorText }),
        { status: cobResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const cobData = await cobResponse.json();
    const treealStatus: string = cobData.status || "ATIVA";
    const internalStatus = mapTreealStatus(treealStatus);
    const isPaid = treealStatus === "CONCLUIDA";

    console.log("Treeal COB status:", treealStatus, "→ internal:", internalStatus);

    if (payment_split_id) {
      const updateData: Record<string, unknown> = {
        mp_status: treealStatus,
        status: internalStatus,
      };

      if (isPaid) {
        updateData.pix_paid_at = new Date().toISOString();
        updateData.processed_at = new Date().toISOString();
      }

      await supabase.from("payment_splits").update(updateData).eq("id", payment_split_id);

      if (isPaid) {
        const { data: splitData } = await supabase
          .from("payment_splits")
          .select("charge_id")
          .eq("id", payment_split_id)
          .single();

        if (splitData?.charge_id) {
          await cancelPendingSiblings(supabase, splitData.charge_id, payment_split_id, "pix");
          await tryCompleteCharge(supabase, splitData.charge_id);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        mp_payment_id: txid,
        status: treealStatus,
        internal_status: internalStatus,
        pix_paid: isPaid,
        pix_paid_at: isPaid ? new Date().toISOString() : null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error checking PIX status (Treeal):", error);
    return new Response(
      JSON.stringify({ error: "Erro interno ao consultar status PIX", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
