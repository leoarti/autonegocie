import { createClient, functionUrl } from '../db';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface CreatePixRequest {
  payment_split_id?: string;
  charge_id?: string;
  amount_cents: number;
  payer_name: string;
  payer_email: string;
  payer_document: string;
  description?: string;
}

interface AbacatePayCreateResponse {
  data: {
    id: string;
    brCode: string;
    brCodeBase64: string;
    status: string;
    expiresAt: string;
    amount: number;
  };
  error?: string;
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
      console.error("ABACATEPAY_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "AbacatePay não configurado" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: CreatePixRequest = await req.json();

    console.log("Creating PIX payment (AbacatePay):", JSON.stringify(body, null, 2));

    const {
      payment_split_id,
      charge_id,
      amount_cents,
      payer_name,
      payer_email,
      payer_document,
      description,
    } = body;

    if (!amount_cents || amount_cents <= 0) {
      return new Response(
        JSON.stringify({ error: "Valor inválido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!payer_name || !payer_email || !payer_document) {
      return new Response(
        JSON.stringify({ error: "Dados do pagador incompletos" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if payment already exists for this split
    if (payment_split_id) {
      const { data: existingSplit } = await supabase
        .from("payment_splits")
        .select("mp_payment_id, mp_qr_code, mp_qr_code_base64, mp_status, amount_cents")
        .eq("id", payment_split_id)
        .single();

      if (existingSplit?.mp_payment_id && existingSplit?.mp_qr_code) {
        console.log("Returning existing PIX payment:", existingSplit.mp_payment_id);
        return new Response(
          JSON.stringify({
            success: true,
            payment_id: existingSplit.mp_payment_id,
            qr_code: existingSplit.mp_qr_code,
            qr_code_base64: existingSplit.mp_qr_code_base64,
            status: existingSplit.mp_status,
            amount_cents: existingSplit.amount_cents,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Clean document
    const cleanDocument = payer_document.replace(/\D/g, "");

    // Truncate description to 37 chars (AbacatePay limit)
    const pixDescription = (description || "Pagamento PIX - Autonegocie").substring(0, 37);

    // Create PIX QR Code via AbacatePay
    const abacatePayload = {
      amount: amount_cents, // AbacatePay expects amount in cents
      expiresIn: 86400, // 24 hours in seconds
      description: pixDescription,
      customer: {
        name: payer_name,
        email: payer_email,
        taxId: cleanDocument,
        cellphone: "",
      },
    };

    console.log("AbacatePay payload:", JSON.stringify(abacatePayload, null, 2));

    const abacateResponse = await fetch("https://api.abacatepay.com/v1/pixQrCode/create", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${abacateApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(abacatePayload),
    });

    const abacateData: AbacatePayCreateResponse = await abacateResponse.json();

    console.log("AbacatePay response:", JSON.stringify(abacateData, null, 2));

    if (!abacateResponse.ok || abacateData.error) {
      console.error("AbacatePay error:", abacateData);
      return new Response(
        JSON.stringify({
          error: "Erro ao criar pagamento PIX",
          details: abacateData,
        }),
        { status: abacateResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const pixData = abacateData.data;
    const qrCode = pixData.brCode;
    const qrCodeBase64 = pixData.brCodeBase64;

    if (!qrCode) {
      console.error("brCode not found in response");
      return new Response(
        JSON.stringify({ error: "QR Code não retornado pelo AbacatePay" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update payment_split with AbacatePay data (reusing mp_ columns as legacy)
    if (payment_split_id) {
      const { error: updateError } = await supabase
        .from("payment_splits")
        .update({
          mp_payment_id: pixData.id,
          mp_qr_code: qrCode,
          mp_qr_code_base64: qrCodeBase64,
          mp_status: pixData.status,
          mp_date_of_expiration: pixData.expiresAt,
        })
        .eq("id", payment_split_id);

      if (updateError) {
        console.error("Error updating payment_split:", updateError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        payment_id: pixData.id,
        qr_code: qrCode,
        qr_code_base64: qrCodeBase64,
        status: pixData.status,
        expiration: pixData.expiresAt,
        amount_cents,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error creating PIX payment:", error);
    return new Response(
      JSON.stringify({ error: "Erro interno ao criar pagamento PIX", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

}
