import { callRoute } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SimulationRequest {
  amountInCents: number;
  merchantId?: string;
}

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Validate method
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    // Parse request
    const { amountInCents, merchantId }: SimulationRequest = await req.json();

    // Validate inputs
    if (!amountInCents || amountInCents <= 0 || !Number.isInteger(amountInCents)) {
      return new Response(JSON.stringify({ 
        error: 'amountInCents deve ser um inteiro positivo' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get environment variables
    const baseUrl = process.env.QUITAPLUS_BASE_URL;
    const defaultMerchantId = process.env.QUITA_MAIS_MERCHANT_ID;

    if (!baseUrl || !defaultMerchantId) {
      throw new Error('Missing required environment variables');
    }

    const finalMerchantId = merchantId || defaultMerchantId;

    console.log('[quitaplus-simulation] Request:', { amountInCents, merchantId: finalMerchantId });

    // Get authentication token
    const tokenResponse = await callRoute('quitaplus-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!tokenResponse.ok) {
      throw new Error('Falha na autenticação');
    }

    const { accessToken } = await tokenResponse.json();

    // Call Quita+ simulation endpoint with retry logic
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < 3) {
      attempts++;
      
      try {
        console.log(`[quitaplus-simulation] Tentativa ${attempts}/3`);
        
        const simulationResponse = await fetch(`${baseUrl}/payment/simulation`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'AutonegocieHub/quitaplus-simulation',
            'Origin': 'https://autonegocie.com.br',
            'Referer': 'https://autonegocie.com.br/'
          },
          body: JSON.stringify({
            amountInCents,
            merchantId: finalMerchantId
          })
        });

        const responseText = await simulationResponse.text();

        // Handle 4xx errors (don't retry)
        if (!simulationResponse.ok && simulationResponse.status >= 400 && simulationResponse.status < 500) {
          let errorMessage = 'Erro na simulação';
          try {
            const errorData = JSON.parse(responseText);
            errorMessage = errorData.message || errorMessage;
          } catch {
            errorMessage = responseText || errorMessage;
          }

          return new Response(JSON.stringify({
            success: false,
            error: errorMessage,
            code: simulationResponse.status
          }), {
            status: simulationResponse.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Handle 5xx errors (retry)
        if (!simulationResponse.ok) {
          throw new Error(`HTTP ${simulationResponse.status}: ${responseText}`);
        }

        const simulationData = JSON.parse(responseText);
        console.log('[quitaplus-simulation] Simulation result:', simulationData);

        // Return success
        return new Response(JSON.stringify({
          success: true,
          simulation: simulationData
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        lastError = error as Error;
        console.error(`[quitaplus-simulation] Tentativa ${attempts} falhou:`, error);
        
        if (attempts < 3) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }
    }

    throw lastError;

  } catch (error) {
    console.error('[quitaplus-simulation] Erro fatal:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

}
