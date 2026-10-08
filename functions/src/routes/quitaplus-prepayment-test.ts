import { callRoute } from '../db';
import { corsHeaders } from '../shared/cors';

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('[quitaplus-prepayment-test] Iniciando teste de conectividade - Modo Compatibilidade (dois JSONs concatenados)');

    // 1. Obter token
    const tokenResponse = await callRoute('quitaplus-token', {
      method: 'POST',
      headers: {
        'Authorization': req.headers.get('Authorization') || '',
        'Content-Type': 'application/json',
      },
    });

    if (!tokenResponse.ok) {
      throw new Error(`Falha ao obter token: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.accessToken;

    console.log('[quitaplus-prepayment-test] Token obtido com sucesso');

    // 2. Construir corpo RAW com DOIS JSONs concatenados (modo compatibilidade)
    const rawBody = `{
  "MerchantId":"00000000000000",
  "CreditorName":"Cappta teste",
  "CreditorDocument": "00000000000000",
  "AmountInCents":12000,
  "Installments":8,
  "PayerDocument":"62087771510",
  "PayerEmail": "user@email.com",
  "PayerPhoneNumber":"95987159889",
  "PayerName":"Ryan Renan Raimundo Oliveira",
  "CardHolderName":"Ryan Renan Raimundo Oliveira",
  "CardNumber":"5240 2628 3194 5576",
  "CardExpirationDate":"2026/05",
  "CardCvv":"810"
}

{
  "orderDetails": {
    "merchantId": "00000000000000",
    "initiatorKey": "9953784",
    "expiresAt": "2024-11-26 00:00:01",
    "description": "Teste link de pagamentos",
    "details": "detalhes do pagamento",
    "payer": {
      "document": "62087771510",
      "email": "user@email.com",
      "phoneNumber": "95987159889",
      "name": "Ryan Renan Raimundo Oliveira"
    },
    "bankslip": {
      "number": "846000000006409600553005013226838913999990004015",
      "creditorDocument": "00000000000000",
      "creditorName": "Fortbrasil"
    },
    "checkout": {
      "maskFee": false,
      "installments": null
    }
  }
}`;

    const baseUrl = process.env.QUITAPLUS_BASE_URL;
    const endpoint = '/prepayment/authorize';
    const fullUrl = `${baseUrl}${endpoint}`;

    // Log do request (mascarar dados sensíveis)
    console.log('[quitaplus-prepayment-test] ===== REQUEST COMPLETO =====');
    console.log('[quitaplus-prepayment-test] URL:', fullUrl);
    console.log('[quitaplus-prepayment-test] Method: POST');
    console.log('[quitaplus-prepayment-test] Headers:', {
      'Authorization': 'Bearer [MASKED]',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    });
    console.log('[quitaplus-prepayment-test] Body (RAW - CardNumber/CVV mascarados):');
    const maskedBody = rawBody
      .replace(/"CardNumber":"[^"]+"/g, '"CardNumber":"5240 **** **** 5576"')
      .replace(/"CardCvv":"[^"]+"/g, '"CardCvv":"***"');
    console.log(maskedBody);
    console.log('[quitaplus-prepayment-test] Body length:', rawBody.length, 'bytes');
    console.log('[quitaplus-prepayment-test] ============================');

    // 3. Enviar para Quita+ API
    console.log('[quitaplus-prepayment-test] Enviando requisição para:', fullUrl);
    
    const quitaResponse = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: rawBody, // Corpo RAW com dois JSONs concatenados
    });

    const responseText = await quitaResponse.text();
    
    // Log do response completo
    console.log('[quitaplus-prepayment-test] ===== RESPONSE COMPLETO =====');
    console.log('[quitaplus-prepayment-test] Status:', quitaResponse.status, quitaResponse.statusText);
    console.log('[quitaplus-prepayment-test] Headers:', Object.fromEntries(quitaResponse.headers.entries()));
    console.log('[quitaplus-prepayment-test] Body (texto):', responseText);
    console.log('[quitaplus-prepayment-test] ==============================');

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    // Análise do resultado
    const analysis = {
      success: quitaResponse.ok,
      status: quitaResponse.status,
      acceptedFormat: quitaResponse.status !== 400, // 400 = formato rejeitado
      hasPrePaymentKey: responseData?.prePaymentKey ? true : false,
      isApproved: responseData?.isApproved || false,
      message: responseData?.message || null,
      responseBody: responseData,
    };

    console.log('[quitaplus-prepayment-test] ===== ANÁLISE =====');
    console.log('[quitaplus-prepayment-test] Formato aceito:', analysis.acceptedFormat);
    console.log('[quitaplus-prepayment-test] Status:', analysis.status);
    console.log('[quitaplus-prepayment-test] Aprovado:', analysis.isApproved);
    console.log('[quitaplus-prepayment-test] PrePaymentKey presente:', analysis.hasPrePaymentKey);
    console.log('[quitaplus-prepayment-test] Mensagem:', analysis.message);
    console.log('[quitaplus-prepayment-test] ====================');

    return new Response(
      JSON.stringify({
        testMode: 'compatibility',
        description: 'Teste com dois JSONs concatenados (modo compatibilidade)',
        analysis,
        request: {
          url: fullUrl,
          method: 'POST',
          bodyLength: rawBody.length,
          contentType: 'application/json',
        },
        response: {
          status: quitaResponse.status,
          statusText: quitaResponse.statusText,
          body: responseData,
        },
      }, null, 2),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('[quitaplus-prepayment-test] Erro no teste:', error);
    
    return new Response(
      JSON.stringify({
        error: 'Test failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error,
      }, null, 2),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

}
