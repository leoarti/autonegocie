import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface SubscriptionData {
  canonicalStatus: 'active' | 'trialing' | 'past_due' | 'canceled';
  raw: any;
  companyId: string;
  userId: string;
  computedAt: string;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      process.env.SUPABASE_URL ?? '',
      process.env.SUPABASE_ANON_KEY ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    )

    // Get user from JWT
    const {
      data: { user },
    } = await supabaseClient.auth.getUser()

    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const url = new URL(req.url)
    const companyId = url.searchParams.get('companyId') || user.id

    // Check if user is admin - admins always have active subscription
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role === 'admin') {
      const result = {
        canonicalStatus: 'active' as const,
        raw: { status: 'active', plan_code: 'admin-plan', role: 'admin' },
        companyId,
        userId: user.id,
        computedAt: new Date().toISOString()
      }

      console.log(`Admin subscription (always active): ${JSON.stringify({
        companyId,
        userId: user.id,
        canonicalStatus: 'active',
        computedAt: result.computedAt
      })}`)

      return new Response(
        JSON.stringify(result),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Query subscription from database - single source of truth
    const { data: subscription, error } = await supabaseClient
      .from('subscriptions')
      .select('status, plan_code, current_period_end, canceled_at, grace_days')
      .eq('company_id', companyId)
      .eq('owner_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error && error.code !== 'PGRST116') {
      console.error('Database error:', error)
      return new Response(
        JSON.stringify({ error: 'Database error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // SUBSCRIPTION SYSTEM DISABLED: Always return active status
    const canonicalStatus: 'active' = 'active'
    const raw = subscription || { status: 'active', forced: true, disabled_system: true }

    const result = {
      canonicalStatus,
      raw,
      companyId,
      userId: user.id,
      computedAt: new Date().toISOString()
    }

    // Audit log
    console.log(`Subscription canonical status: ${JSON.stringify({
      companyId,
      userId: user.id,
      canonicalStatus,
      computedAt: result.computedAt
    })}`)

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Subscription status error:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

}
