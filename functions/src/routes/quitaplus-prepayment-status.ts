import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PrepaymentStatusRequest {
  prePaymentKey: string;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { prePaymentKey }: PrepaymentStatusRequest = await req.json();

    if (!prePaymentKey) {
      console.error('[quitaplus-prepayment-status] prePaymentKey não fornecido');
      return new Response(
        JSON.stringify({ error: 'prePaymentKey é obrigatório' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[quitaplus-prepayment-status] Consultando status para:', prePaymentKey);

    // Obter token de autenticação
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: tokenData, error: tokenError } = await supabase.functions.invoke('quitaplus-token');
    
    if (tokenError || !tokenData?.accessToken) {
      console.error('[quitaplus-prepayment-status] Erro ao obter token:', tokenError);
      return new Response(
        JSON.stringify({ error: 'Falha ao obter token de autenticação', details: tokenError?.message }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const baseUrl = (process.env.QUITAPLUS_BASE_URL || 'https://pay-gt.autonegocie.com').replace(/\/$/, '');
    const fullUrl = `${baseUrl}/prepayment/status/${prePaymentKey}`;

    console.log('[quitaplus-prepayment-status] Chamando:', fullUrl);

    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenData.accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': baseUrl,
        'Referer': `${baseUrl}/`,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

    const responseText = await response.text();

    console.log('[quitaplus-prepayment-status] Resposta:', {
      status: response.status,
      body: responseText
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Erro ao consultar status',
          apiRawResponse: responseText,
          httpStatus: response.status
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error('[quitaplus-prepayment-status] Erro ao parsear resposta:', parseError);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Resposta inválida da API',
          apiRawResponse: responseText
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Normalizar campos (API pode retornar camelCase ou PascalCase)
    const statusCode = data.statusCode || data.StatusCode || null;
    const statusName = data.status || data.Status || null;
    const transactionId = data.transactionId || data.TransactionId || null;
    const authorizationCode = data.authorizationCode || data.AuthorizationCode || null;

    // Mapeamento statusCode → status interno do sistema
    const statusCodeMap: Record<number, string> = {
      1: 'pre_authorized',       // Received - pré-pagamento foi criado
      2: 'cancelled',            // Canceled - prazo expirou ou valor diferente
      3: 'boleto_linked',        // BarcodeAssigned - boleto anexado
      4: 'validating',           // Settled - analisado pelo robô
      5: 'payment_denied',       // PaymentDenied - risco não aprovou
      6: 'approved',             // PaymentValidated - risco aprovou
      7: 'awaiting_validation',  // AwaitingPayerValidation - aguardando PIN
      8: 'validating',           // ValidatingPayment - risco analisando
      9: 'completed',            // Paid - boleto foi pago
      50: 'cnpj_nao_cadastrado', // MissingRegistryBankslipCNPJ - CNPJ não cadastrado
    };

    const internalStatus = statusCode ? statusCodeMap[statusCode] || 'pending' : null;

    console.log('[quitaplus-prepayment-status] Status obtido:', { 
      statusCode, 
      statusName, 
      internalStatus,
      transactionId, 
      authorizationCode 
    });

    return new Response(
      JSON.stringify({
        success: true,
        prePaymentKey,
        statusCode,
        statusName,
        internalStatus,
        transactionId,
        authorizationCode,
        apiRawResponse: responseText
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[quitaplus-prepayment-status] Erro inesperado:', error);
    return new Response(
      JSON.stringify({ 
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido' 
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

}
