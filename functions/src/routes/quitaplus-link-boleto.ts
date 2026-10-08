import { callRoute, createClient } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface LinkBoletoRequest {
  prePaymentKey: string;
  paymentLinkId: string;
  boleto: {
    number: string; // linha digitável
    creditorDocument: string;
    creditorName: string;
  };
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const requestData: LinkBoletoRequest = await req.json();
    console.log('[quitaplus-link-boleto] Iniciando vínculo de boleto para prePaymentKey:', requestData.prePaymentKey);

    // Validar linha digitável (47 ou 48 dígitos)
    const sanitizedNumber = requestData.boleto.number.replace(/\D/g, '');
    if (sanitizedNumber.length !== 47 && sanitizedNumber.length !== 48) {
      return new Response(
        JSON.stringify({
          apiRawResponse: JSON.stringify({ error: 'Linha digitável do boleto inválida', message: 'A linha digitável deve ter 47 ou 48 dígitos' }),
          apiMetadata: {
            httpStatus: 400,
            httpStatusText: 'Bad Request',
            httpHeaders: {},
            requestUrl: 'validation'
          }
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Obter URL do Supabase
    const supabaseUrl = process.env.SUPABASE_URL!;

    // Obter token de autenticação
    const tokenResponse = await callRoute('quitaplus-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Falha na autenticação: ${tokenResponse.statusText}`);
    }

    const { accessToken } = await tokenResponse.json();

    const baseUrl = process.env.QUITAPLUS_BASE_URL || '';

    // Preparar payload para Quita+ (formato correto da API)
    const quitaPlusPayload = {
      Barcode: sanitizedNumber, // Campo único em PascalCase
    };

    console.log('[quitaplus-link-boleto] Payload preparado:', JSON.stringify(quitaPlusPayload, null, 2));
    console.log('[quitaplus-link-boleto] Enviando vínculo:', {
      prePaymentKey: requestData.prePaymentKey,
      boletoLastDigits: sanitizedNumber.slice(-4),
      url: `${baseUrl}/prepayment/AttachBankslip/${requestData.prePaymentKey}`,
    });

    // Chamar API Quita+ com retry
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < 3) {
      attempts++;
      
      try {
        const quitaResponse = await fetch(`${baseUrl}/prepayment/AttachBankslip/${requestData.prePaymentKey}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
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
          body: JSON.stringify(quitaPlusPayload),
        });

        const responseText = await quitaResponse.text();
        console.log('[quitaplus-link-boleto] Resposta Quita+:', {
          status: quitaResponse.status,
          body: responseText.substring(0, 500),
        });

        // Detectar erros no corpo da resposta mesmo com HTTP 200
        const responseTextLower = responseText.toLowerCase();
        const isApiError = 
          responseTextLower.includes('não encontrado') ||
          responseTextLower.includes('not found') ||
          responseTextLower.includes('invalid') ||
          responseTextLower.includes('canceled') ||
          responseTextLower.includes('cancelled') ||
          responseTextLower.includes('expired') ||
          responseTextLower.includes('expirado') ||
          responseTextLower.includes('cancelado') ||
          responseTextLower.includes('error') ||
          responseTextLower.includes('erro') ||
          responseTextLower.includes('failed') ||
          responseTextLower.includes('falha');

        if (!quitaResponse.ok) {
          // Erros 4xx não devem ser retried
          if (quitaResponse.status >= 400 && quitaResponse.status < 500) {
            return new Response(
              JSON.stringify({
                success: false,
                apiRawResponse: responseText,
                apiMetadata: {
                  httpStatus: quitaResponse.status,
                  httpStatusText: quitaResponse.statusText,
                  httpHeaders: Object.fromEntries(quitaResponse.headers.entries()),
                  requestUrl: `${baseUrl}/prepayment/AttachBankslip/${requestData.prePaymentKey}`
                }
              }),
              {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              }
            );
          }

          // Erros 5xx podem ser retried
          throw new Error(`HTTP ${quitaResponse.status}: ${responseText}`);
        }

        // Se a resposta contém padrões de erro, considerar como falha
        if (isApiError) {
          console.warn('[quitaplus-link-boleto] API retornou HTTP 200 mas com mensagem de erro:', responseText);
          return new Response(
            JSON.stringify({
              success: false,
              apiRawResponse: responseText,
              apiMetadata: {
                httpStatus: quitaResponse.status,
                httpStatusText: quitaResponse.statusText,
                httpHeaders: Object.fromEntries(quitaResponse.headers.entries()),
                requestUrl: `${baseUrl}/prepayment/AttachBankslip/${requestData.prePaymentKey}`
              },
              errorDetected: true,
              errorMessage: 'API retornou mensagem de erro no corpo da resposta'
            }),
            {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        const quitaData = JSON.parse(responseText);

        // Atualizar DB apenas se paymentLinkId for UUID válido
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isValidUuid = uuidRegex.test(requestData.paymentLinkId);

        if (isValidUuid) {
          // Inicializar cliente Supabase para atualizar DB
          const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
          const supabase = createClient(supabaseUrl, supabaseKey);

          // Atualizar payment_splits com link_id
          const { error: updateError } = await supabase
            .from('payment_splits')
            .update({
              link_id: quitaData.linkId || quitaData.link_id,
              status: 'linked',
            })
            .eq('payment_link_id', requestData.paymentLinkId)
            .eq('pre_payment_key', requestData.prePaymentKey);

          if (updateError) {
            console.error('[quitaplus-link-boleto] Erro ao atualizar payment_splits:', updateError);
            // Não falha a requisição se o vínculo na API foi bem-sucedido
            console.warn('[quitaplus-link-boleto] Vínculo na API OK, mas falha no update do DB');
          } else {
            console.log('[quitaplus-link-boleto] DB atualizado com sucesso');
          }
        } else {
          console.log('[quitaplus-link-boleto] PaymentLinkId não é UUID válido, pulando update do DB:', requestData.paymentLinkId);
        }

        console.log('[quitaplus-link-boleto] Boleto vinculado com sucesso');

        return new Response(
          JSON.stringify({
            success: true,
            apiRawResponse: responseText,
            apiMetadata: {
              httpStatus: quitaResponse.status,
              httpStatusText: quitaResponse.statusText,
              httpHeaders: Object.fromEntries(quitaResponse.headers.entries()),
              requestUrl: `${baseUrl}/prepayment/AttachBankslip/${requestData.prePaymentKey}`
            }
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );

      } catch (error) {
        lastError = error as Error;
        console.error(`[quitaplus-link-boleto] Tentativa ${attempts} falhou:`, error);
        
        if (attempts < 3) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }
    }

    throw lastError;

  } catch (error) {
    console.error('[quitaplus-link-boleto] Erro fatal:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
        code: 500,
        message: 'Erro interno do servidor',
      }),
      {
        status: 200, // Sempre retorna 200 para o front-end conseguir ler o JSON
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

}
