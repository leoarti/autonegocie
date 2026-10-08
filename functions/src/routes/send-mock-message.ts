import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { chargeId, templateContent, phoneNumber, payerName, amount } = await req.json()

    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL!
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseKey)

    console.log('Creating mock WhatsApp message for charge:', chargeId)

    // Substituir variáveis no template
    let finalMessage = templateContent || 'Olá {{nome}}, você tem uma cobrança de {{valor}} pendente.'
    
    const replacements = {
      'nome': payerName || 'Cliente',
      'valor': new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      }).format((amount || 0) / 100),
      'empresa': 'Minha Empresa',
      'link': `https://exemplo.com/pagamento/${chargeId}`,
      'vencimento': new Date().toLocaleDateString('pt-BR')
    }

    Object.entries(replacements).forEach(([key, value]) => {
      finalMessage = finalMessage.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
    })

    // Inserir mensagem mock na fila
    const { data: message, error: messageError } = await supabase
      .from('charge_messages')
      .insert({
        charge_id: chargeId,
        content: finalMessage,
        phone_number: phoneNumber,
        status: 'pending'
      })
      .select()
      .single()

    if (messageError) {
      console.error('Error creating message:', messageError)
      throw messageError
    }

    console.log('Mock message created successfully:', message.id)

    return new Response(JSON.stringify({
      success: true,
      messageId: message.id,
      content: finalMessage
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error('Error in send-mock-message function:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }

}
