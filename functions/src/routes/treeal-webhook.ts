// @ts-nocheck
import { createClient, functionUrl } from '../db';
import { corsHeaders } from '../shared/cors';
import { mapTreealStatus } from '../shared/treeal-auth';
import {
  cancelPendingSiblings,
  tryCompleteCharge,
} from '../shared/charge-completion';

/**
 * Treeal PIX webhook — BACEN PIX standard payload.
 *
 * Configure this URL in Treeal's portal:
 * https://SEU_SERVIDOR/treeal-webhook
 */
export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return new Response("OK", { status: 200, headers: { ...corsHeaders, "Content-Type": "text/plain" } });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const payload = await req.json();
    console.log("Treeal webhook received:", JSON.stringify(payload));

    const pixList: Array<Record<string, unknown>> = payload?.pix ?? [];

    if (pixList.length === 0) {
      console.log("Webhook payload has no pix entries, ignoring");
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    for (const pixEntry of pixList) {
      const txid = pixEntry?.txid as string | undefined;
      const horario = (pixEntry?.horario as string) ?? new Date().toISOString();

      if (!txid) {
        console.log("PIX entry without txid, skipping:", pixEntry);
        continue;
      }

      console.log("Processing Treeal PIX — txid:", txid);

      const { data: splits, error: findError } = await supabase
        .from("payment_splits")
        .select("id, charge_id, status")
        .eq("mp_payment_id", txid)
        .limit(1);

      if (findError || !splits || splits.length === 0) {
        console.log("No payment_split found for txid:", txid);
        continue;
      }

      const split = splits[0];

      if (split.status === "concluded") {
        console.log("Split already concluded, skipping:", split.id);
        continue;
      }

      await supabase
        .from("payment_splits")
        .update({
          status: "concluded",
          mp_status: "CONCLUIDA",
          pix_paid_at: horario,
          processed_at: new Date().toISOString(),
        })
        .eq("id", split.id);

      console.log("Split", split.id, "marked as concluded via Treeal webhook");

      if (split.charge_id) {
        await cancelPendingSiblings(supabase, split.charge_id, split.id, "pix");
        await tryCompleteCharge(supabase, split.charge_id);
      }
    }

    return new Response("OK", { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error("Treeal webhook error:", error);
    return new Response("OK", { status: 200, headers: corsHeaders });
  }

}
