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

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;
    const authHeader = req.headers.get('Authorization');

    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verificar autenticação com anon key
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: roleRow, error: roleError } = await supabaseAuth
      .from('user_roles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (roleError || roleRow?.role !== 'admin') {
      console.log('[update-company-settings] Access denied - not admin:', user.id);
      return new Response(JSON.stringify({ error: 'Forbidden - Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('[update-company-settings] Admin authenticated:', user.id);

    // Parse body
    const { creditor_document, creditor_name, merchant_id } = await req.json();

    // Validações básicas
    if (creditor_document && typeof creditor_document !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid creditor_document' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (creditor_name && typeof creditor_name !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid creditor_name' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (merchant_id && typeof merchant_id !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid merchant_id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!creditor_document && !creditor_name && !merchant_id) {
      return new Response(JSON.stringify({ error: 'No updates provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: current } = await supabaseAuth
      .from('app_settings')
      .select('*')
      .eq('id', 'quita_mais')
      .maybeSingle();

    const next = {
      id: 'quita_mais',
      creditor_document: creditor_document || current?.creditor_document || '',
      creditor_name: creditor_name || current?.creditor_name || '',
      merchant_id: merchant_id || current?.merchant_id || '',
    };

    const { error: saveError } = await supabaseAuth.from('app_settings').upsert(next);
    if (saveError) throw saveError;

    if (next.creditor_document) process.env.QUITA_MAIS_CREDITOR_DOCUMENT = next.creditor_document;
    if (next.creditor_name) process.env.QUITA_MAIS_CREDITOR_NAME = next.creditor_name;
    if (next.merchant_id) process.env.QUITA_MAIS_MERCHANT_ID = next.merchant_id;

    return new Response(JSON.stringify({
      success: true,
      message: 'Configurações salvas.',
      ...next,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in update-company-settings function:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

}
