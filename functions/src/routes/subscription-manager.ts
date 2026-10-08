import { createClient, functionUrl } from '../db';
import { corsHeaders } from '../shared/cors'

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
)

interface SubscriptionStatus {
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELED'
  allowed: boolean
  grace_days: number
  grace_until?: string
  current_period_end?: string
  plan_code?: string
  company_id: string
}

async function getSubscriptionStatus(companyId: string): Promise<SubscriptionStatus | null> {
  const { data: subscription, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (error || !subscription) {
    return null
  }

  // Calcular se está permitido (grace period)
  const now = new Date()
  let allowed = false
  let graceUntil: Date | null = null

  if (subscription.status === 'ACTIVE') {
    allowed = true
  } else if (subscription.status === 'PAST_DUE') {
    const periodEnd = subscription.current_period_end 
      ? new Date(subscription.current_period_end)
      : new Date(subscription.started_at)
    
    graceUntil = new Date(periodEnd.getTime() + (subscription.grace_days * 24 * 60 * 60 * 1000))
    allowed = now <= graceUntil
  }

  return {
    status: subscription.status,
    allowed,
    grace_days: subscription.grace_days,
    grace_until: graceUntil?.toISOString(),
    current_period_end: subscription.current_period_end,
    plan_code: subscription.plan_code,
    company_id: subscription.company_id
  }
}

async function getUserCompanyId(userId: string): Promise<string | null> {
  // Por simplicidade, usar o próprio user_id como company_id
  // Em produção, isso viria de uma tabela de companies/organizations
  return userId
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const path = url.pathname.split('/').pop()
    
    // GET /subscription/status
    if (req.method === 'GET' && path === 'status') {
      const authHeader = req.headers.get('authorization')
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Authorization required' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Extrair user do token (simplificado)
      const token = authHeader.replace('Bearer ', '')
      const { data: { user } } = await supabase.auth.getUser(token)
      
      if (!user) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const companyId = await getUserCompanyId(user.id)
      if (!companyId) {
        return new Response(JSON.stringify({ error: 'Company not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const status = await getSubscriptionStatus(companyId)
      if (!status) {
        // Se não tem assinatura, criar uma CANCELED por padrão
        const { data: newSub } = await supabase
          .from('subscriptions')
          .insert({
            company_id: companyId,
            owner_id: user.id,
            status: 'CANCELED',
            plan_code: 'none'
          })
          .select()
          .single()

        return new Response(JSON.stringify({
          status: 'CANCELED',
          allowed: false,
          grace_days: 7,
          plan_code: 'none',
          company_id: companyId
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify(status), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // POST /subscription/admin/set
    if (req.method === 'POST' && path === 'set') {
      const authHeader = req.headers.get('authorization')
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Authorization required' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const token = authHeader.replace('Bearer ', '')
      const { data: { user } } = await supabase.auth.getUser(token)
      
      if (!user) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Verificar se é admin
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (!profile || profile.role !== 'admin') {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const body = await req.json()
      const { company_id, status, grace_days, current_period_end, plan_code } = body

      if (!company_id || !status) {
        return new Response(JSON.stringify({ error: 'company_id and status are required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const updateData: any = {
        status,
        updated_at: new Date().toISOString()
      }

      if (grace_days !== undefined) updateData.grace_days = grace_days
      if (current_period_end !== undefined) updateData.current_period_end = current_period_end
      if (plan_code !== undefined) updateData.plan_code = plan_code
      if (status === 'CANCELED') updateData.canceled_at = new Date().toISOString()

      const { data, error } = await supabase
        .from('subscriptions')
        .update(updateData)
        .eq('company_id', company_id)
        .select()
        .single()

      if (error) throw error

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // GET /subscription/admin/list
    if (req.method === 'GET' && path === 'list') {
      const authHeader = req.headers.get('authorization')
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Authorization required' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const token = authHeader.replace('Bearer ', '')
      const { data: { user } } = await supabase.auth.getUser(token)
      
      if (!user) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Verificar se é admin
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (!profile || profile.role !== 'admin') {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const statusFilter = url.searchParams.get('status')
      const page = parseInt(url.searchParams.get('page') || '1')
      const pageSize = parseInt(url.searchParams.get('page_size') || '50')

      let query = supabase
        .from('subscriptions')
        .select(`
          *,
          profiles!subscriptions_owner_id_fkey(full_name)
        `, { count: 'exact' })

      if (statusFilter) {
        query = query.eq('status', statusFilter)
      }

      const from = (page - 1) * pageSize
      const to = from + pageSize - 1

      query = query.range(from, to).order('created_at', { ascending: false })

      const { data, error, count } = await query

      if (error) throw error

      return new Response(JSON.stringify({
        data: data || [],
        count,
        page,
        page_size: pageSize,
        total_pages: Math.ceil((count || 0) / pageSize)
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response('Not found', { status: 404, headers: corsHeaders })

  } catch (error) {
    console.error('Error in subscription-manager:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

}
