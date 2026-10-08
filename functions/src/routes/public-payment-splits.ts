import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Use service_role to bypass RLS
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let id: string | null = null;
    let action: string | null = null;
    let splits: any[] = [];

    // Suportar GET (query param) e POST (body)
    if (req.method === 'GET') {
      const url = new URL(req.url);
      id = url.searchParams.get('id');
    } else if (req.method === 'POST') {
      const body = await req.json();
      id = body.id;
      action = body.action;
      splits = body.splits || [];
    }

    if (!id) {
      console.error('[public-payment-splits] Missing id parameter');
      return new Response(
        JSON.stringify({ error: 'Payment link id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[public-payment-splits] Action: ${action || 'GET'}, id: ${id}`);

    // ====== AÇÃO: CRIAR SPLITS (com deleção de antigos) ======
    if (action === 'create_splits' && splits.length > 0) {
      const chargeId = splits[0]?.charge_id;
      
      if (!chargeId) {
        return new Response(
          JSON.stringify({ error: 'charge_id is required in splits' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // GUARD: Verificar se existem splits com dados de pagamento já iniciados
      // Se sim, NÃO deletar - retornar os splits existentes para evitar perda de dados
      const { data: existingSplits } = await supabase
        .from('payment_splits')
        .select('*')
        .eq('charge_id', chargeId);

      const hasActivePayment = existingSplits?.some(s => 
        s.mp_payment_id ||       // PIX já gerado no Mercado Pago
        s.pre_payment_key ||     // Cartão já pré-autorizado
        s.status === 'concluded' // Já concluído
      );

      if (hasActivePayment) {
        console.log('[public-payment-splits] ⚠️ Splits com pagamento ativo encontrados, retornando existentes');
        return new Response(
          JSON.stringify({ 
            success: true, 
            payment_splits: existingSplits,
            warning: 'Splits already have active payment data, not replaced'
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Se não há pagamento ativo, pode deletar e recriar
      const { error: deleteError } = await supabase
        .from('payment_splits')
        .delete()
        .eq('charge_id', chargeId);

      if (deleteError) {
        console.error('[public-payment-splits] Error deleting old splits:', deleteError);
        // Continuar mesmo com erro
      } else {
        console.log(`[public-payment-splits] ✅ Deleted old splits for charge_id: ${chargeId}`);
      }

      // Inserir novos splits
      const { data: insertedSplits, error: insertError } = await supabase
        .from('payment_splits')
        .insert(splits)
        .select();

      if (insertError) {
        console.error('[public-payment-splits] Error inserting splits:', insertError);
        return new Response(
          JSON.stringify({ error: 'Failed to create splits', details: insertError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[public-payment-splits] ✅ Created ${insertedSplits?.length} new splits`);
      
      return new Response(
        JSON.stringify({ success: true, payment_splits: insertedSplits }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ====== AÇÃO PADRÃO: BUSCAR DADOS ======

    // Tentar buscar payment_link primeiro por ID
    let paymentLink = null;
    let chargeId = null;

    const { data: linkById } = await supabase
      .from('payment_links')
      .select(`
        *,
        charges!payment_links_charge_id_fkey (
          id,
          pix_amount,
          card_amount,
          has_boleto_link,
          boleto_linha_digitavel,
          creditor_document,
          creditor_name,
          payment_method,
          description,
          payer_name,
          payer_email,
          payer_document,
          payer_phone
        )
      `)
      .eq('id', id)
      .maybeSingle();

    if (linkById) {
      paymentLink = linkById;
      const chargeData = Array.isArray(linkById.charges) ? linkById.charges[0] : linkById.charges;
      chargeId = linkById.charge_id || chargeData?.id;
    } else {
      // Tentar buscar por charge_id
      const { data: linkByChargeId } = await supabase
        .from('payment_links')
        .select(`
          *,
          charges!payment_links_charge_id_fkey (
            id,
            pix_amount,
            card_amount,
            has_boleto_link,
            boleto_linha_digitavel,
            creditor_document,
            creditor_name,
            payment_method,
            description,
            payer_name,
            payer_email,
            payer_document,
            payer_phone
          )
        `)
        .eq('charge_id', id)
        .maybeSingle();

      if (linkByChargeId) {
        paymentLink = linkByChargeId;
        const chargeData = Array.isArray(linkByChargeId.charges) ? linkByChargeId.charges[0] : linkByChargeId.charges;
        chargeId = linkByChargeId.charge_id || chargeData?.id;
      } else {
        // Fallback: buscar diretamente na tabela charges
        const { data: chargeData } = await supabase
          .from('charges')
          .select('*')
          .eq('id', id)
          .maybeSingle();

        if (chargeData) {
          chargeId = chargeData.id;
          // Criar um payment_link virtual
          paymentLink = {
            id: chargeData.id,
            charge_id: chargeData.id,
            amount: chargeData.amount,
            description: chargeData.description,
            payer_name: chargeData.payer_name,
            payer_email: chargeData.payer_email,
            payer_document: chargeData.payer_document,
            payer_phone_number: chargeData.payer_phone,
            charges: chargeData
          };
        }
      }
    }

    if (!paymentLink) {
      console.error('[public-payment-splits] Payment link not found');
      return new Response(
        JSON.stringify({ error: 'Payment link not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extrair dados da charge
    const chargeData = Array.isArray(paymentLink.charges) ? paymentLink.charges[0] : paymentLink.charges;

    // Buscar payment_splits - APENAS OS MAIS RECENTES
    // Agrupa por method e pega o mais recente de cada
    let paymentSplits: any[] = [];
    
    if (chargeId) {
      // Buscar todos os splits para esta charge, ordenados por created_at DESC
      const { data: allSplits } = await supabase
        .from('payment_splits')
        .select('*')
        .eq('charge_id', chargeId)
        .order('created_at', { ascending: false });

      if (allSplits && allSplits.length > 0) {
        // Pegar apenas o mais recente de cada method
        const methodMap = new Map<string, any>();
        for (const split of allSplits) {
          if (!methodMap.has(split.method)) {
            methodMap.set(split.method, split);
          }
        }
        paymentSplits = Array.from(methodMap.values());
        
        // Ordenar por order_index
        paymentSplits.sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
      }
    }

    console.log(`[public-payment-splits] ✅ Found payment_link and ${paymentSplits.length} splits (latest only)`);

    // Formatar resposta - priorizar dados da charge sobre payment_link
    const response = {
      payment_link: {
        id: paymentLink.id,
        charge_id: chargeId,
        amount: paymentLink.amount,
        pix_amount: chargeData?.pix_amount || 0,
        card_amount: chargeData?.card_amount || 0,
        description: paymentLink.description || chargeData?.description || 'Pagamento',
        payer_name: chargeData?.payer_name || paymentLink.payer_name || '',
        payer_email: chargeData?.payer_email || paymentLink.payer_email || '',
        payer_document: chargeData?.payer_document || paymentLink.payer_document || '',
        payer_phone: chargeData?.payer_phone || paymentLink.payer_phone_number || '',
        has_boleto_link: chargeData?.has_boleto_link || false,
        boleto_linha_digitavel: chargeData?.boleto_linha_digitavel || '',
        creditor_document: chargeData?.creditor_document || '',
        creditor_name: chargeData?.creditor_name || '',
        payment_method: chargeData?.payment_method || null,
      },
      payment_splits: paymentSplits,
      // Retornar dados da charge separadamente para facilitar acesso
      charge: chargeData ? {
        id: chargeData.id,
        payer_name: chargeData.payer_name,
        payer_email: chargeData.payer_email,
        payer_document: chargeData.payer_document,
        payer_phone: chargeData.payer_phone,
      } : null,
    };

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[public-payment-splits] Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

}
