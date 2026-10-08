import { db } from '@/integrations/firebase/client';

export interface PaymentLinkData {
  link_id: string;
  link_url: string;
  guid: string;
  charge_id: string;
}

/**
 * Cria um payment link para uma cobrança específica (idempotente)
 * Retorna o link existente se já foi criado, ou cria um novo
 */
export async function createPaymentLinkForCharge(chargeId: string): Promise<PaymentLinkData | null> {
  try {
    // Verificar se já existe um payment link para esta cobrança
    const { data: existingLink, error: searchError } = await db
      .from('payment_links')
      .select('*')
      .eq('order_id', chargeId)
      .eq('status', 'active')
      .single();

    if (existingLink && !searchError) {
      // Link já existe, retornar o existente
      return {
        link_id: existingLink.link_id,
        link_url: existingLink.link_url,
        guid: existingLink.guid,
        charge_id: chargeId
      };
    }

    // Buscar dados da cobrança
    const { data: charge, error: chargeError } = await db
      .from('charges')
      .select('*')
      .eq('id', chargeId)
      .single();

    if (chargeError || !charge) {
      throw new Error('Cobrança não encontrada');
    }

    // Gerar IDs únicos
    const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const guid = `guid_${Math.random().toString(36).substr(2, 12)}`;
    const baseUrl = window.location.origin;
    const linkUrl = `${baseUrl}/payment?token=${linkId}&charge=${chargeId}`;

    // Criar registro no payment_links
    const { data: newLink, error: createError } = await db
      .from('payment_links')
      .insert({
        link_id: linkId,
        url: linkUrl,
        guid: guid,
        company_id: charge.company_id,
        order_id: chargeId,
        order_type: 'credit_card',
        status: 'active',
        amount: charge.amount,
        payer_name: charge.payer_name,
        payer_email: charge.payer_email,
        payer_document: charge.payer_document,
        payer_phone_number: charge.payer_phone,
        description: charge.description,
        installments: charge.installments,
        mask_fee: charge.mask_fee,
        // Store UI snapshot for the edge function
        ui_snapshot: {
          charge_id: chargeId,
          amount: charge.amount,
          description: charge.description,
          payer_name: charge.payer_name,
          installments: charge.installments,
          mask_fee: charge.mask_fee,
          has_boleto_link: charge.has_boleto_link
        }
      } as any)
      .select()
      .single();

    if (createError) {
      throw createError;
    }

    return {
      link_id: linkId,
      link_url: linkUrl,
      guid: guid,
      charge_id: chargeId
    };

  } catch (error) {
    console.error('Error creating payment link:', error);
    return null;
  }
}