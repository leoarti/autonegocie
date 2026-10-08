import { callRoute, createClient } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface AdminLinkBoletoRequest {
  chargeId: string;
  linhaDigitavel: string;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verificar autenticação
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'Não autorizado', message: 'Token de autenticação ausente' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extrair user do token
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Não autorizado', message: 'Token inválido' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verificar se é admin
    const { data: roleData, error: roleError } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single();

    if (roleError || roleData?.role !== 'admin') {
      return new Response(
        JSON.stringify({ success: false, error: 'Acesso negado', message: 'Apenas administradores podem vincular boletos manualmente' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const requestData: AdminLinkBoletoRequest = await req.json();
    console.log('[admin-link-boleto] Iniciando vinculação manual para charge:', requestData.chargeId);

    // Validar linha digitável
    const sanitizedLinha = requestData.linhaDigitavel.replace(/\D/g, '');
    if (sanitizedLinha.length < 47 || sanitizedLinha.length > 48) {
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'Linha digitável inválida', 
          message: 'A linha digitável deve ter 47 ou 48 dígitos' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Buscar cobrança
    const { data: charge, error: chargeError } = await supabase
      .from('charges')
      .select('id, pre_payment_key, payment_method, creditor_document, creditor_name, status, boleto_admin_linha_digitavel')
      .eq('id', requestData.chargeId)
      .single();

    if (chargeError || !charge) {
      return new Response(
        JSON.stringify({ success: false, error: 'Cobrança não encontrada', message: 'ID inválido' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verificar se é pagamento combinado
    if (charge.payment_method !== 'cartao_pix') {
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'Tipo de pagamento inválido', 
          message: 'Vinculação manual só é permitida para pagamentos combinados (PIX + Cartão)' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verificar se tem pre_payment_key (cartão aprovado)
    if (!charge.pre_payment_key) {
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'Cartão não aprovado', 
          message: 'O cartão precisa ser aprovado antes de vincular o boleto' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verificar se já foi vinculado
    if (charge.boleto_admin_linha_digitavel) {
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'Já vinculado', 
          message: 'Esta cobrança já possui um boleto vinculado manualmente' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ====== PRÉ-VALIDAÇÃO: Verificar status do pré-pagamento na API antes de vincular ======
    console.log('[admin-link-boleto] Verificando status do pré-pagamento na API...');
    
    const statusResponse = await callRoute('quitaplus-prepayment-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prePaymentKey: charge.pre_payment_key }),
    });

    const statusResult = await statusResponse.json();
    console.log('[admin-link-boleto] Status do pré-pagamento:', statusResult);

    // Verificar se status é válido para vínculo
    // Status válidos: 1 (Pending), 9 (Paid)
    // Status inválidos: 2 (Canceled), 3 (Expired), 4 (Failed), etc.
    const validStatusCodes = [1, 9]; // Pending, Paid
    const statusCode = statusResult.statusCode ?? statusResult.StatusCode;

    if (statusCode === undefined || statusCode === null) {
      console.error('[admin-link-boleto] Não foi possível obter status do pré-pagamento');
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Pré-pagamento não encontrado',
          message: 'Não foi possível verificar o status do pré-pagamento na API. Verifique se o pagamento por cartão foi realizado corretamente.',
          apiResponse: statusResult,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!validStatusCodes.includes(statusCode)) {
      const statusDescription = statusResult.statusDescription || statusResult.StatusDescription || 'Status desconhecido';
      console.warn('[admin-link-boleto] Pré-pagamento com status inválido para vínculo:', statusCode, statusDescription);
      
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Pré-pagamento inválido',
          message: `O pré-pagamento não está em status válido para vincular o boleto. Status atual: ${statusDescription} (código ${statusCode})`,
          statusCode: statusCode,
          statusDescription: statusDescription,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[admin-link-boleto] Pré-pagamento válido, prosseguindo com vínculo do boleto...');

    // Obter credenciais padrão
    const creditorName = process.env.QUITA_MAIS_CREDITOR_NAME || '';
    const creditorDocument = process.env.QUITA_MAIS_CREDITOR_DOCUMENT || '';

    console.log('[admin-link-boleto] Chamando quitaplus-link-boleto...');

    // Chamar função de vínculo
    const linkResponse = await callRoute('quitaplus-link-boleto', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prePaymentKey: charge.pre_payment_key,
        paymentLinkId: requestData.chargeId,
        boleto: {
          number: sanitizedLinha,
          creditorDocument: charge.creditor_document || creditorDocument,
          creditorName: charge.creditor_name || creditorName,
        }
      }),
    });

    const linkResult = await linkResponse.json();
    console.log('[admin-link-boleto] Resultado do vínculo:', linkResult);

    // ====== PÓS-VALIDAÇÃO: Verificar flag success + erros + httpStatus ======
    // linkResult.success === false indica que a API retornou erro (mesmo com HTTP 200)
    if (linkResult.success === false || linkResult.error || (linkResult.apiMetadata?.httpStatus && linkResult.apiMetadata.httpStatus >= 400)) {
      const errorMessage = linkResult.errorMessage || linkResult.error || 'Erro ao vincular boleto na API';
      
      console.error('[admin-link-boleto] Falha no vínculo do boleto:', errorMessage);
      
      return new Response(
        JSON.stringify({
          success: false,
          error: errorMessage,
          message: 'O boleto não foi vinculado. Verifique se o pré-pagamento ainda é válido e tente novamente.',
          apiResponse: linkResult.apiRawResponse,
          httpStatus: linkResult.apiMetadata?.httpStatus,
          errorDetected: linkResult.errorDetected,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verificar se linkResult.success está explicitamente true
    if (linkResult.success !== true) {
      console.warn('[admin-link-boleto] Resposta sem flag success explícita, tratando com cautela');
      // Continuar apenas se não houver indicadores de erro
    }

    // Sucesso - Atualizar cobrança
    const { error: updateError } = await supabase
      .from('charges')
      .update({
        boleto_admin_linha_digitavel: sanitizedLinha,
        status: 'boleto_linked',
        boleto_linked_at: new Date().toISOString(),
      })
      .eq('id', requestData.chargeId);

    if (updateError) {
      console.error('[admin-link-boleto] Erro ao atualizar cobrança:', updateError);
    }

    console.log('[admin-link-boleto] Boleto vinculado com sucesso!');

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Boleto vinculado com sucesso',
        linhaDigitavel: sanitizedLinha,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[admin-link-boleto] Erro fatal:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

}
