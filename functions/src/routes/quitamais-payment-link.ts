import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const paymentData = await req.json()

    if (!paymentData || !paymentData.amount || !paymentData.payer) {
      return new Response(
        JSON.stringify({ error: 'Missing required payment data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get access token first
    console.log('Getting QuitaMais access token...')
    const clientId = process.env.QUITA_MAIS_CLIENT_ID
    const clientSecret = process.env.QUITA_MAIS_CLIENT_SECRET
    const baseUrl = process.env.BASE_URL || 'https://pay-gt.autonegocie.com'

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({ error: 'QuitaMais credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const tokenResponse = await fetch(`${baseUrl}/connect/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      console.error('Token request failed:', tokenResponse.status, errorText)
      return new Response(
        JSON.stringify({ 
          error: 'Authentication failed', 
          details: `Token request returned ${tokenResponse.status}` 
        }),
        { status: tokenResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token

    if (!accessToken) {
      return new Response(
        JSON.stringify({ error: 'No access token received' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Creating payment link with QuitaMais API...')
    
    const supabaseUrl = process.env.SUPABASE_URL!
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

    // For testing with mock data, create a mock response
    console.log('Creating mock payment link for testing...')
    const paymentLink = {
      linkId: `mock_link_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      linkUrl: `https://checkout-sandbox.quitamais.com.br/pay/${Date.now()}`,
      guid: `mock_guid_${Math.random().toString(36).substr(2, 12)}`,
      status: 'active',
      createdAt: new Date().toISOString()
    }

    console.log('Mock payment link created:', paymentLink)

    // Save to database
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    
    const { data: savedLink, error: dbError } = await supabase
      .from('payment_links')
      .insert({
        link_id: paymentLink.linkId,
        link_url: paymentLink.linkUrl,
        guid: paymentLink.guid,
        amount: paymentData.amount,
        payer_name: paymentData.payer.name,
        payer_email: paymentData.payer.email,
        payer_phone_number: paymentData.payer.phoneNumber,
        payer_document: paymentData.payer.document,
        creditor_name: paymentData.bankslip?.creditorName,
        creditor_document: paymentData.bankslip?.creditorDocument,
        status: paymentLink.status,
        order_type: paymentData.orderType || 'credit_card',
        description: paymentData.description,
        order_id: paymentData.orderId,
        installments: paymentData.checkout.installments,
        mask_fee: paymentData.checkout.maskFee,
        expiration_date: paymentData.expirationDate,
      })
      .select()
      .maybeSingle()

    if (dbError) {
      console.error('Database error:', dbError)
      // Still return success since the payment link was created
    }

    return new Response(
      JSON.stringify({
        linkId: paymentLink.linkId,
        linkUrl: paymentLink.linkUrl,
        guid: paymentLink.guid,
        status: paymentLink.status,
        createdAt: paymentLink.createdAt,
        savedToDb: !dbError
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (error) {
    console.error('Error creating payment link:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error', 
        details: error.message 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }

}
