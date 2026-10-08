// @ts-nocheck
import { createClient, functionUrl } from '../db';
import QRCode from 'qrcode';
import { corsHeaders } from '../shared/cors';
import {
  buildMtlsCredentials,
  fetchMtls,
  getAccessToken,
  loadTreealConfig,
  TREEAL_CASHIN_URL,
} from '../shared/treeal-auth';

interface CreatePixRequest {
  payment_split_id?: string;
  charge_id?: string;
  amount_cents: number;
  payer_name: string;
  payer_email: string;
  payer_document: string;
  description?: string;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const config = loadTreealConfig();

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: CreatePixRequest = await req.json();
    const { payment_split_id, charge_id, amount_cents, payer_name, payer_document, description } = body;

    if (!amount_cents || amount_cents <= 0) {
      return new Response(
        JSON.stringify({ error: "Valor inválido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!payer_name || !payer_document) {
      return new Response(
        JSON.stringify({ error: "Dados do pagador incompletos" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Não gerar novo QR se a charge já foi quitada — evita cobrar o cliente
    // duas vezes por acidente quando alguém reabre o link após o pagamento.
    if (charge_id) {
      const { data: charge } = await supabase
        .from("charges")
        .select("status, completed_at")
        .eq("id", charge_id)
        .maybeSingle();

      if (charge?.status === "completed") {
        console.log(`[treeal-pix-create] Charge ${charge_id} já está completed — recusando gerar novo QR`);
        return new Response(
          JSON.stringify({
            error: "charge_already_completed",
            message: "Esta cobrança já foi paga. Não é possível gerar novo QR Code.",
            completed_at: charge.completed_at,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Return existing QR code if already generated for this split
    if (payment_split_id) {
      const { data: existingSplit } = await supabase
        .from("payment_splits")
        .select("mp_payment_id, mp_qr_code, mp_qr_code_base64, mp_status, amount_cents")
        .eq("id", payment_split_id)
        .single();

      if (existingSplit?.mp_payment_id && existingSplit?.mp_qr_code) {
        console.log("Returning existing PIX (Treeal txid):", existingSplit.mp_payment_id);
        return new Response(
          JSON.stringify({
            success: true,
            payment_id: existingSplit.mp_payment_id,
            qr_code: existingSplit.mp_qr_code,
            qr_code_base64: existingSplit.mp_qr_code_base64,
            status: existingSplit.mp_status,
            amount_cents: existingSplit.amount_cents,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Parse PFX and build mTLS credentials
    let creds;
    try {
      creds = buildMtlsCredentials(config.certBase64, config.certPassword);
    } catch (certError) {
      console.error("Erro ao processar certificado mTLS:", certError);
      return new Response(
        JSON.stringify({ error: "Erro ao processar certificado mTLS", details: String(certError) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Get OAuth token
    let accessToken: string;
    try {
      accessToken = await getAccessToken(creds, config.clientId, config.clientSecret);
    } catch (oauthError) {
      console.error("Erro OAuth Treeal:", oauthError);
      return new Response(
        JSON.stringify({ error: "Erro na autenticação OAuth com a Treeal", details: String(oauthError) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Generate unique txid (26–35 alphanumeric chars, BACEN requirement)
    const txid = crypto.randomUUID().replace(/-/g, "").substring(0, 35);

    const cleanDoc = payer_document.replace(/\D/g, "");
    const devedor = cleanDoc.length === 11
      ? { cpf: cleanDoc, nome: payer_name }
      : { cnpj: cleanDoc, nome: payer_name };

    const amountDecimal = (amount_cents / 100).toFixed(2);
    const solicitacao = (description || "Pagamento PIX - Autonegocie").substring(0, 140);

    const cobPayload = {
      calendario: { expiracao: 86400 },
      devedor,
      valor: { original: amountDecimal },
      chave: config.pixKey,
      solicitacaoPagador: solicitacao,
    };

    console.log("Treeal COB request — txid:", txid, "valor:", amountDecimal);

    const cobResponse = await fetchMtls(
      `${TREEAL_CASHIN_URL}/cob/${txid}`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cobPayload),
      },
      creds,
    );

    if (!cobResponse.ok) {
      const errorText = await cobResponse.text();
      console.error("Treeal COB error:", cobResponse.status, errorText);
      return new Response(
        JSON.stringify({ error: "Erro ao criar cobrança PIX na Treeal", details: errorText }),
        { status: cobResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const cobData = await cobResponse.json();
    console.log("Treeal COB response:", JSON.stringify(cobData));

    const pixCopiaECola: string = cobData.pixCopiaECola;
    if (!pixCopiaECola) {
      console.error("pixCopiaECola ausente na resposta da Treeal:", cobData);
      return new Response(
        JSON.stringify({ error: "Código PIX não retornado pela Treeal", details: cobData }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Generate QR code image from the PIX EMV string
    const qrCodeDataUrl: string = await QRCode.toDataURL(pixCopiaECola, { errorCorrectionLevel: "M" });
    const qrCodeBase64 = qrCodeDataUrl.replace("data:image/png;base64,", "");

    const cobStatus: string = cobData.status || "ATIVA";
    const criacao: string = cobData.calendario?.criacao ?? new Date().toISOString();
    const expiresAt = new Date(new Date(criacao).getTime() + 86400 * 1000).toISOString();

    if (payment_split_id) {
      const { error: updateError } = await supabase
        .from("payment_splits")
        .update({
          mp_payment_id: txid,
          mp_qr_code: pixCopiaECola,
          mp_qr_code_base64: qrCodeBase64,
          mp_status: cobStatus,
          mp_date_of_expiration: expiresAt,
        })
        .eq("id", payment_split_id);

      if (updateError) {
        console.error("Error updating payment_split:", updateError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        payment_id: txid,
        qr_code: pixCopiaECola,
        qr_code_base64: qrCodeBase64,
        status: cobStatus,
        expiration: expiresAt,
        amount_cents,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error creating PIX (Treeal):", error);
    return new Response(
      JSON.stringify({ error: "Erro interno ao criar pagamento PIX", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

}
