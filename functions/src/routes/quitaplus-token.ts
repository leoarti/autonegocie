
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface TokenCache {
  accessToken: string
  expiresAt: number
  tokenType?: string
}

let tokenCache: TokenCache | null = null

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function fetchTokenWithRetry(tokenUrl: string, clientId: string, clientSecret: string, maxRetries = 3): Promise<any> {
  let lastError: any
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Token request attempt ${attempt}/${maxRetries}`)
      
      // Create JSON body (Cappta API requirement)
      const body = JSON.stringify({
        clientId: clientId,
        clientSecret: clientSecret,
        grant_type: 'client_credentials'
      })
      
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'AutonegocieHub/quitaplus-token',
        },
        body: body,
      })

      if (response.ok) {
        const responseText = await response.text()
        console.log('Raw token response:', responseText.substring(0, 500))
        
        let data
        try {
          data = JSON.parse(responseText)
        } catch (e) {
          console.error('Failed to parse token response as JSON:', e)
          throw new Error(`Invalid JSON response: ${responseText.substring(0, 100)}`)
        }
        
        console.log('Token obtained successfully')
        console.log('Token data received:', { 
          hasAccessToken: !!data.access_token,
          hasExpiresIn: !!data.expires_in,
          tokenType: data.token_type,
          expiresIn: data.expires_in,
          allKeys: Object.keys(data)
        })
        return data
      }

      // Handle rate limiting (429) and server errors (5xx)
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get('retry-after')
        const backoffMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000
        
        console.log(`Request failed with ${response.status}, retrying in ${backoffMs}ms`)
        
        if (attempt < maxRetries) {
          await sleep(backoffMs)
          continue
        }
      }

      // For other errors, log and prepare to return error
      const errorText = await response.text()
      const maskedError = errorText.length > 200 ? errorText.substring(0, 200) + '...' : errorText
      console.log(`Request failed with ${response.status}: ${maskedError}`)
      lastError = {
        status: response.status,
        message: maskedError,
        attempt
      }
      
      if (response.status < 500) {
        // Client errors (4xx) - don't retry
        break
      }

    } catch (error: any) {
      console.log(`Network error on attempt ${attempt}:`, error.message)
      lastError = {
        error: error.message,
        attempt
      }
      
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000)
      }
    }
  }

  throw lastError
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
    // Get environment variables and build the complete token URL
    const baseUrl = process.env.QUITAPLUS_BASE_URL || 'https://pay-gt.autonegocie.com'
    // Check if URL already contains the token endpoint
    const tokenUrl = baseUrl.includes('/connect/token') || baseUrl.includes('/oauth/token')
      ? baseUrl
      : `${baseUrl.replace(/\/$/, '')}/connect/token`
    const clientId = process.env.QUITAPLUS_CLIENT_ID
    const clientSecret = process.env.QUITAPLUS_CLIENT_SECRET

    console.log('Environment check:', {
      tokenUrl,
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret
    })

    if (!clientId || !clientSecret) {
      console.error('Missing QuitaPlus credentials')
      return new Response(
        JSON.stringify({ 
          error: 'Configuration error', 
          details: 'Missing QUITAPLUS_CLIENT_ID or QUITAPLUS_CLIENT_SECRET' 
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Check if we have a valid cached token
    const now = Date.now()
    if (tokenCache && tokenCache.expiresAt > now + 60000) { // 1min buffer
      console.log('Using cached token')
      return new Response(
        JSON.stringify({
          accessToken: tokenCache.accessToken,
          tokenType: tokenCache.tokenType || 'Bearer',
          expiresIn: Math.floor((tokenCache.expiresAt - now) / 1000),
          expiresAt: tokenCache.expiresAt,
          fromCache: true
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    console.log('Requesting new token from:', tokenUrl)

    const tokenData = await fetchTokenWithRetry(tokenUrl, clientId, clientSecret)
    
    // Normalize token response fields
    const accessToken = tokenData?.access_token ?? tokenData?.accessToken ?? tokenData?.token
    const expiresIn = (tokenData?.expires_in ?? tokenData?.expiresIn ?? 3600) as number
    const tokenType = (tokenData?.token_type ?? tokenData?.tokenType ?? 'Bearer') as string

    if (!accessToken) {
      throw new Error('Token de acesso não recebido da API')
    }
    
    // Cache the token
    const expiresAt = now + (expiresIn * 1000)
    tokenCache = {
      accessToken,
      expiresAt,
      tokenType,
    }

    return new Response(
      JSON.stringify({
        accessToken,
        tokenType,
        expiresIn,
        expiresAt,
        fromCache: false
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (error: any) {
    console.error('Error in quitaplus-token:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Authentication failed', 
        details: error.message || 'Token request failed',
        status: error.status || 500,
        lastAttempt: error.attempt || 1
      }),
      { 
        status: error.status || 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }

}
