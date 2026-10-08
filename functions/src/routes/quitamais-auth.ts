
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Get environment variables and normalize BASE_URL to origin only (no path)
    const rawBaseUrl = process.env.BASE_URL || 'https://pay-gt.autonegocie.com'
    const clientId = process.env.QUITA_MAIS_CLIENT_ID
    const clientSecret = process.env.QUITA_MAIS_CLIENT_SECRET

    let baseUrl = rawBaseUrl
    try {
      const parsed = new URL(rawBaseUrl.includes('://') ? rawBaseUrl : `https://${rawBaseUrl}`)
      baseUrl = `${parsed.protocol}//${parsed.host}` // strip any path/query
    } catch (_e) {
      baseUrl = 'https://pay-gt.autonegocie.com'
    }

    console.log('Environment check:', {
      rawBaseUrl,
      normalizedBaseUrl: baseUrl,
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret
    });

    if (!clientId || !clientSecret) {
      console.error('Missing QuitaMais credentials')
      return new Response(
        JSON.stringify({ 
          error: 'Configuration error', 
          details: 'Missing QuitaMais credentials' 
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    console.log('Requesting QuitaMais token from:', `${baseUrl}/connect/token`)

    // Try different common endpoints for OAuth token
    const endpoints = ['/connect/token', '/oauth/token', '/auth/token', '/token', '/identity/connect/token', '/oauth2/token']
    
    // Build host candidates. We normalize to host-only and also try identity/api variants if Cappta domain is used
    const hostCandidates: string[] = []
    const unique = new Set<string>()
    const addHost = (h: string) => { if (!unique.has(h)) { unique.add(h); hostCandidates.push(h) } }

    addHost(baseUrl)

    if (baseUrl.includes('cappta.com.br')) {
      // Common Cappta identity/api hosts for sandbox and prod
      const replacements = [
        baseUrl.replace('//api-', '//identity-'),
        baseUrl.replace('//identity-', '//api-'),
        'https://identity-sandbox.cappta.com.br',
        'https://api-sandbox.cappta.com.br',
        'https://identity.cappta.com.br',
        'https://api.cappta.com.br',
      ]
      replacements.forEach(addHost)
    }

    let tokenRequest: Response | undefined
    let lastError: any

    outer: for (const host of hostCandidates) {
      for (const endpoint of endpoints) {
        const fullUrl = `${host}${endpoint}`
        console.log(`Trying endpoint: ${fullUrl}`)
        try {
          tokenRequest = await fetch(fullUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: clientId,
              client_secret: clientSecret,
            }),
          })

          console.log(`Response status for ${fullUrl}:`, tokenRequest.status)
          if (tokenRequest.ok) {
            console.log(`Success with endpoint: ${fullUrl}`)
            break outer
          } else {
            const errorText = await tokenRequest.text()
            console.log(`Failed ${fullUrl} (${tokenRequest.status}):`, errorText)
            lastError = { status: tokenRequest.status, text: errorText, url: fullUrl }
          }
        } catch (fetchError: any) {
          console.log(`Network error for ${fullUrl}:`, fetchError.message)
          lastError = { error: fetchError.message, url: fullUrl }
        }
      }
    }

    if (!tokenRequest || !tokenRequest.ok) {
      console.error('All endpoints failed. Last error:', lastError)

      return new Response(
        JSON.stringify({
          error: 'Authentication failed',
          details: `All endpoints failed. Last status: ${lastError?.status || 'Network Error'}`,
          message: lastError?.text || lastError?.error || 'All authentication endpoints returned errors',
          testedEndpoints: hostCandidates.flatMap(h => endpoints.map(ep => `${h}${ep}`))
        }),
        {
          status: lastError?.status || 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    const tokenData = await tokenRequest.json()
    console.log('QuitaMais token received successfully')

    // Calculate expiration timestamp
    const expiresAt = Date.now() + (tokenData.expires_in * 1000)

    return new Response(
      JSON.stringify({
        accessToken: tokenData.access_token,
        tokenType: tokenData.token_type || 'Bearer',
        expiresIn: tokenData.expires_in,
        expiresAt
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (error) {
    console.error('Error in QuitaMais auth:', error)
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
