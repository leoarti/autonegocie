import { callRoute, createClient } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PrePaymentRequest {
  chargeId: string;
  paymentLinkId: string;
  amount: number;
  installments: number;
  card: {
    holderName: string;
    number: string;
    expirationDate: string; // MM/AA
    cvv: string;
  };
  payer: {
    name: string;
    document: string;
    email: string;
    phoneNumber: string;
  };
}

/**
 * Extrai mensagem amigável da resposta da API Quita+ para exibir ao usuário
 */
function extractUserFriendlyMessage(apiResponse: string, httpStatus: number): string {
  // Mapeamento de códigos conhecidos para mensagens amigáveis
  const friendlyMessages: Record<string, string> = {
    'CARD_DECLINED': 'Cartão recusado pela operadora',
    'INSUFFICIENT_FUNDS': 'Saldo insuficiente no cartão',
    'EXPIRED_CARD': 'Cartão expirado',
    'INVALID_CVV': 'Código de segurança (CVV) inválido',
    'INVALID_CARD_NUMBER': 'Número do cartão inválido',
    'ANTIFRAUD_DECLINED': 'Transação não aprovada pelo sistema antifraude',
    'CARD_BLOCKED': 'Cartão bloqueado',
    'PROCESSING_ERROR': 'Erro ao processar pagamento. Tente novamente.',
    'INVALID_EXPIRATION_DATE': 'Data de validade do cartão inválida',
    'TRANSACTION_NOT_ALLOWED': 'Transação não permitida para este cartão',
    'CARD_NOT_SUPPORTED': 'Bandeira do cartão não suportada',
    'LIMIT_EXCEEDED': 'Limite do cartão excedido',
    'DUPLICATE_TRANSACTION': 'Transação duplicada detectada',
    'INVALID_AMOUNT': 'Valor da transação inválido',
    'TIMEOUT': 'Tempo limite excedido. Tente novamente.',
    'GENERIC_ERROR': 'Erro ao processar pagamento. Tente novamente.',
  };

  try {
    const parsed = JSON.parse(apiResponse);
    
    // Tentar extrair mensagem e código da API (vários formatos possíveis)
    const apiMessage = parsed.message || parsed.Message || 
                       parsed.errorMessage || parsed.error?.message ||
                       parsed.error_message || parsed.ErrorMessage ||
                       parsed.returnMessage || parsed.ReturnMessage;
    const apiCode = parsed.code || parsed.Code || parsed.errorCode ||
                    parsed.returnCode || parsed.ReturnCode || parsed.error?.code;
    
    // Se temos um código conhecido, usar mensagem amigável
    if (apiCode && friendlyMessages[String(apiCode).toUpperCase()]) {
      return friendlyMessages[String(apiCode).toUpperCase()];
    }
    
    // Se temos mensagem da API, retornar ela diretamente
    if (apiMessage && typeof apiMessage === 'string' && apiMessage.trim().length > 0) {
      return apiMessage;
    }
    
    // Verificar se há campo específico de recusa de cartão
    if (parsed.authorized === false || parsed.Authorized === false) {
      const declineReason = parsed.declineReason || parsed.DeclineReason || 
                           parsed.reason || parsed.Reason;
      if (declineReason) {
        return `Cartão não autorizado: ${declineReason}`;
      }
      return 'Cartão não autorizado pela operadora';
    }
    
  } catch {
    // JSON inválido - verificar se é HTML de bloqueio WAF
    if (apiResponse.includes('Access Denied') || apiResponse.includes('errors.edgesuite.net')) {
      return 'Serviço temporariamente indisponível. Tente novamente em alguns minutos.';
    }
  }
  
  // Fallback por status HTTP
  if (httpStatus === 400) return 'Dados do cartão inválidos. Verifique e tente novamente.';
  if (httpStatus === 401) return 'Falha na autenticação. Tente novamente.';
  if (httpStatus === 403) return 'Transação não autorizada.';
  if (httpStatus === 422) return 'Dados do pagamento inválidos. Verifique e tente novamente.';
  if (httpStatus >= 500) return 'Erro temporário no servidor. Tente novamente em instantes.';
  
  return 'Não foi possível processar o pagamento. Verifique os dados e tente novamente.';
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const requestData: PrePaymentRequest = await req.json();
    console.log('[quitaplus-prepayment] Iniciando pré-pagamento para charge:', requestData.chargeId);

    // Validar número de parcelas
    if (requestData.installments < 1 || requestData.installments > 21) {
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'Número de parcelas inválido',
          message: 'O número de parcelas deve estar entre 1 e 21'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Obter URL do Supabase
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(supabaseUrl, supabaseKey);

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

    // Obter credenciais do ambiente
    const merchantId = process.env.QUITA_MAIS_MERCHANT_ID || '';
    const creditorName = process.env.QUITA_MAIS_CREDITOR_NAME || '';
    const creditorDocument = process.env.QUITA_MAIS_CREDITOR_DOCUMENT || '';
    const baseUrl = process.env.QUITAPLUS_BASE_URL || '';

    // Sanitizar dados
    const sanitizedCardNumber = requestData.card.number.replace(/\D/g, '');
    const sanitizedCvv = requestData.card.cvv.replace(/\D/g, '');
    const sanitizedDocument = requestData.payer.document.replace(/\D/g, '');
    const sanitizedPhone = requestData.payer.phoneNumber.replace(/\D/g, '');
    
    // Converter data de expiração de MM/AA para YYYY/MM
    const expDateClean = requestData.card.expirationDate.replace(/\D/g, '');
    let cardExpirationDate: string;
    if (expDateClean.length === 4) {
      // Formato MMAA -> YYYY/MM
      const month = expDateClean.substring(0, 2);
      const year = expDateClean.substring(2, 4);
      cardExpirationDate = `20${year}/${month}`;
    } else {
      // Assumir formato já correto ou inválido
      cardExpirationDate = requestData.card.expirationDate;
    }

    // Calcular data de expiração (+30 dias)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expiresAtFormatted = expiresAt.toISOString().replace('T', ' ').substring(0, 19);

    // Preparar primeiro JSON - Card Authorization (PascalCase)
    const cardPayload = {
      MerchantId: merchantId,
      CreditorName: creditorName,
      CreditorDocument: creditorDocument,
      AmountInCents: requestData.amount,
      Installments: requestData.installments,
      PayerDocument: sanitizedDocument,
      PayerEmail: requestData.payer.email.trim(),
      PayerPhoneNumber: sanitizedPhone,
      PayerName: requestData.payer.name.trim(),
      CardHolderName: requestData.card.holderName.trim(),
      CardNumber: sanitizedCardNumber,
      CardExpirationDate: cardExpirationDate,
      CardCvv: sanitizedCvv,
    };

    // Log do payload montado para debug
    console.log('[quitaplus-prepayment] Payload montado:', {
      AmountInCents: requestData.amount,
      Installments: requestData.installments,
      ChargeId: requestData.chargeId
    });

    // Body com apenas o cardPayload (JSON único)
    const rawBody = JSON.stringify(cardPayload);

    // Construir URL completa
    const fullUrl = `${baseUrl}/prepayment/authorize`;

    // Log detalhado do request completo (mascarando dados sensíveis)
    const maskedPayload = {
      ...cardPayload,
      CardNumber: cardPayload.CardNumber.slice(0, 6) + '******' + cardPayload.CardNumber.slice(-4),
      CardCvv: '***'
    };

    console.log('[quitaplus-prepayment] REQUEST COMPLETO:', {
      url: fullUrl,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer [MASKED]',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: maskedPayload
    });

    // Chamar API Quita+ com retry
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < 3) {
      attempts++;
      
      try {
        console.log(`[quitaplus-prepayment] Tentativa ${attempts}/3 - Chamando: ${fullUrl}`);
        
        // Headers melhorados para passar pelo WAF Akamai
        const quitaResponse = await fetch(fullUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Origin': baseUrl.replace(/\/+$/, ''),
            'Referer': `${baseUrl}/`,
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Connection': 'keep-alive',
          },
          body: rawBody,
        });

        const responseText = await quitaResponse.text();
        
        // Log detalhado da resposta
        console.log('[quitaplus-prepayment] RESPONSE COMPLETO:', {
          status: quitaResponse.status,
          statusText: quitaResponse.statusText,
          headers: Object.fromEntries(quitaResponse.headers.entries()),
          body: responseText
        });

        if (!quitaResponse.ok) {
          // Erros 4xx não devem ser retried
          if (quitaResponse.status >= 400 && quitaResponse.status < 500) {
            let errorMessage = 'Erro ao processar pagamento';
            let detailedError = responseText;
            
            // Detectar bloqueio do WAF
            const isWafBlock = responseText.includes('Access Denied') || 
                              responseText.includes('errors.edgesuite.net') ||
                              quitaResponse.status === 403;
            
            if (isWafBlock) {
              errorMessage = '🛡️ WAF/CDN Akamai bloqueando requisição';
              detailedError = `ERRO 403 - WAF Akamai bloqueou a requisição.

SOLUÇÕES POSSÍVEIS:
1. Liberar o IP deste servidor no painel do WAF da Cappta
2. Implementar proxy próprio com IP fixo
3. Contatar suporte da Cappta para liberação

DETALHES TÉCNICOS:
- Status: ${quitaResponse.status}
- Referência: ${responseText.match(/Reference[^<]+/)?.[0] || 'N/A'}
- URL Bloqueada: ${fullUrl}`;
            } else {
              try {
                const errorData = JSON.parse(responseText);
                errorMessage = errorData.message || errorMessage;
              } catch {
                errorMessage = responseText || errorMessage;
              }
            }

            const userMessage = extractUserFriendlyMessage(responseText, quitaResponse.status);

            return new Response(
              JSON.stringify({
                success: false,
                error: 'payment_failed',
                userMessage: userMessage,
                apiRawResponse: responseText,
                apiMetadata: {
                  httpStatus: quitaResponse.status,
                  httpStatusText: quitaResponse.statusText,
                  httpHeaders: Object.fromEntries(quitaResponse.headers.entries()),
                  requestUrl: fullUrl
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

        const quitaData = JSON.parse(responseText);
        const prePaymentKey = quitaData.prePaymentKey || quitaData.pre_payment_key;

        // Extrair isApproved e message da resposta da API
        // isApproved pode vir como IsApproved (PascalCase) ou isApproved (camelCase)
        // Se não existir, assumimos false para segurança (deve existir explicitamente)
        const isApproved = quitaData.isApproved ?? quitaData.IsApproved ?? false;
        const apiMessage = quitaData.message || quitaData.Message || 
                          quitaData.returnMessage || quitaData.ReturnMessage || '';

        console.log('[quitaplus-prepayment] Resposta da API analisada:', {
          prePaymentKey: prePaymentKey ? 'presente' : 'ausente',
          isApproved,
          message: apiMessage
        });

        // VALIDAÇÃO 1: Verificar se prePaymentKey existe
        if (!prePaymentKey) {
          console.error('[quitaplus-prepayment] API retornou sucesso HTTP mas sem prePaymentKey:', responseText);
          
          const userMessage = extractUserFriendlyMessage(responseText, quitaResponse.status);

          return new Response(
            JSON.stringify({
              success: false,
              error: 'prepayment_key_missing',
              userMessage: userMessage,
              isApproved: false,
              apiRawResponse: responseText,
              apiMetadata: {
                httpStatus: quitaResponse.status,
                httpStatusText: quitaResponse.statusText,
                httpHeaders: Object.fromEntries(quitaResponse.headers.entries()),
                requestUrl: fullUrl
              }
            }),
            {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        // SALVAR prePaymentKey no banco MESMO se não aprovado (para rastreamento)
        // O status depende de isApproved
        const splitStatus = isApproved === true ? 'pending' : 'failed';
        
        console.log(`[quitaplus-prepayment] Salvando prePaymentKey com status: ${splitStatus}`);

        // Atualizar payment_splits com pre_payment_key
        const { error: updateError } = await supabase
          .from('payment_splits')
          .update({
            pre_payment_key: prePaymentKey,
            authorization_code: quitaData.authorizationCode || quitaData.authorization_code,
            status: splitStatus,
          })
          .eq('payment_link_id', requestData.paymentLinkId)
          .eq('method', 'credit_card');

        if (updateError) {
          console.error('[quitaplus-prepayment] Erro ao atualizar payment_splits:', updateError);
        }

        // VALIDAÇÃO 2: Verificar se isApproved === true
        // Só continua o fluxo de sucesso se aprovado
        if (isApproved !== true) {
          console.log('[quitaplus-prepayment] Pagamento NÃO aprovado pela API:', apiMessage);
          
          // Determinar mensagem amigável para o usuário
          const userMessage = apiMessage || extractUserFriendlyMessage(responseText, quitaResponse.status);
          
          // Atualizar cobrança com status failed
          await supabase
            .from('charges')
            .update({
              pre_payment_key: prePaymentKey,
              status: 'payment_denied',
            })
            .eq('id', requestData.chargeId);

          return new Response(
            JSON.stringify({
              success: false,
              error: 'payment_not_approved',
              userMessage: userMessage,
              prePaymentKey: prePaymentKey, // Retornar para referência
              isApproved: false,
              apiRawResponse: responseText,
              apiMetadata: {
                httpStatus: quitaResponse.status,
                httpStatusText: quitaResponse.statusText,
                httpHeaders: Object.fromEntries(quitaResponse.headers.entries()),
                requestUrl: fullUrl
              }
            }),
            {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        // Só chega aqui se prePaymentKey existe E isApproved === true
        console.log('[quitaplus-prepayment] Pré-pagamento autorizado com sucesso, prePaymentKey:', prePaymentKey);

        // Atualizar cobrança com pre_payment_key e status (somente se aprovado)
        await supabase
          .from('charges')
          .update({
            pre_payment_key: prePaymentKey,
            payment_authorized_at: new Date().toISOString(),
            status: 'pre_authorized',
          })
          .eq('id', requestData.chargeId);

        // ============================================
        // FASE 2: VÍNCULO AUTOMÁTICO DE BOLETO
        // ============================================
        console.log('[quitaplus-prepayment] Verificando se deve vincular boleto automaticamente...');

        // Buscar dados da cobrança para vínculo do boleto
        const { data: charge, error: chargeError } = await supabase
          .from('charges')
          .select('id, boleto_linha_digitavel, creditor_document, creditor_name, payment_method')
          .eq('id', requestData.chargeId)
          .single();

        if (chargeError) {
          console.error('[quitaplus-prepayment] Erro ao buscar cobrança:', chargeError);
        }

        let boletoLinked = false;
        let linkBoletoError: any = null;

        // ============================================
        // NOVA REGRA: Para pagamentos combinados (PIX + Cartão),
        // NÃO vincular boleto automaticamente.
        // O admin deve fornecer manualmente a linha digitável.
        // ============================================
        if (charge?.payment_method === 'cartao_pix') {
          console.log('[quitaplus-prepayment] Pagamento combinado (PIX + Cartão) detectado.');
          console.log('[quitaplus-prepayment] Vínculo automático de boleto DESABILITADO para este tipo de pagamento.');
          console.log('[quitaplus-prepayment] O administrador deve vincular manualmente via painel.');
          // Não faz nada - o admin vai vincular manualmente depois
        } else if (charge?.boleto_linha_digitavel && prePaymentKey) {
          // Fluxo original para pagamentos APENAS cartão (não combinado)
          console.log('[quitaplus-prepayment] Pagamento apenas cartão - vinculando boleto automaticamente...', {
            chargeId: requestData.chargeId,
            linhaDigitavelLength: charge.boleto_linha_digitavel.length,
            prePaymentKey: prePaymentKey,
          });

          try {
            const linkResponse = await callRoute('quitaplus-link-boleto', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                prePaymentKey: prePaymentKey,
                paymentLinkId: requestData.paymentLinkId,
                boleto: {
                  number: charge.boleto_linha_digitavel,
                  creditorDocument: charge.creditor_document || creditorDocument,
                  creditorName: charge.creditor_name || creditorName,
                }
              }),
            });

            const linkResult = await linkResponse.json();
            console.log('[quitaplus-prepayment] Resultado do vínculo de boleto:', linkResult);

            // Verificar se houve erro no vínculo
            if (linkResult.error || (linkResult.apiMetadata?.httpStatus && linkResult.apiMetadata.httpStatus >= 400)) {
              linkBoletoError = {
                message: linkResult.error || 'Erro ao vincular boleto',
                apiResponse: linkResult.apiRawResponse,
                httpStatus: linkResult.apiMetadata?.httpStatus,
                attemptedAt: new Date().toISOString(),
              };
              console.error('[quitaplus-prepayment] Erro no vínculo do boleto:', linkBoletoError);

              // Atualizar metadata com erro (não falha o fluxo)
              const { data: currentCharge } = await supabase
                .from('charges')
                .select('metadata')
                .eq('id', requestData.chargeId)
                .single();

              const updatedMetadata = {
                ...(currentCharge?.metadata as object || {}),
                link_boleto_error: linkBoletoError,
              };

              await supabase
                .from('charges')
                .update({ metadata: updatedMetadata })
                .eq('id', requestData.chargeId);

            } else {
              // Vínculo bem-sucedido
              boletoLinked = true;
              console.log('[quitaplus-prepayment] Boleto vinculado com sucesso!');

              await supabase
                .from('charges')
                .update({
                  status: 'boleto_linked',
                  boleto_linked_at: new Date().toISOString(),
                })
                .eq('id', requestData.chargeId);
            }

          } catch (linkError) {
            linkBoletoError = {
              message: linkError instanceof Error ? linkError.message : 'Erro desconhecido ao vincular boleto',
              attemptedAt: new Date().toISOString(),
            };
            console.error('[quitaplus-prepayment] Exceção ao vincular boleto:', linkError);

            // Atualizar metadata com erro
            const { data: currentCharge } = await supabase
              .from('charges')
              .select('metadata')
              .eq('id', requestData.chargeId)
              .single();

            const updatedMetadata = {
              ...(currentCharge?.metadata as object || {}),
              link_boleto_error: linkBoletoError,
            };

            await supabase
              .from('charges')
              .update({ metadata: updatedMetadata })
              .eq('id', requestData.chargeId);
          }
        } else {
          console.log('[quitaplus-prepayment] Nenhuma linha digitável encontrada, pulando vínculo de boleto');
        }

        return new Response(
          JSON.stringify({
            success: true,
            prePaymentKey: prePaymentKey,
            boletoLinked: boletoLinked,
            linkBoletoError: linkBoletoError?.message || null,
            apiRawResponse: responseText,
            apiMetadata: {
              httpStatus: quitaResponse.status,
              httpStatusText: quitaResponse.statusText,
              httpHeaders: Object.fromEntries(quitaResponse.headers.entries()),
              requestUrl: fullUrl
            }
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );

      } catch (error) {
        lastError = error as Error;
        console.error(`[quitaplus-prepayment] Tentativa ${attempts} falhou:`, error);
        
        if (attempts < 3) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }
    }

    throw lastError;

  } catch (error) {
    console.error('[quitaplus-prepayment] Erro fatal:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'internal_error',
        userMessage: 'Erro temporário. Por favor, tente novamente.',
        code: 500,
      }),
      {
        status: 200, // Sempre retorna 200 para o front-end conseguir ler o JSON
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

}
