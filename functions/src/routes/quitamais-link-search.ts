
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
    const { accessToken, linkId } = await req.json()

    if (!accessToken || !linkId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get environment variables
    const baseUrl = process.env.BASE_URL || 'https://pay-gt.autonegocie.com'

    console.log('Searching payment link:', linkId)

    // Search payment link with QuitaMais API
    const searchResponse = await fetch(`${baseUrl}/payment/link/search/${linkId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text()
      console.error('QuitaMais link search failed:', searchResponse.status, errorText)
      
      return new Response(
        JSON.stringify({ 
          error: 'Link search failed', 
          details: `QuitaMais API returned ${searchResponse.status}`,
          message: errorText 
        }),
        { 
          status: searchResponse.status, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    const linkData = await searchResponse.json()
    console.log('Payment link found successfully')

    return new Response(
      JSON.stringify(linkData),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (error) {
    console.error('Error searching payment link:', error)
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
