import { createClient, functionUrl } from '../db';
import { corsHeaders } from '../shared/cors'

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
)

interface Filters {
  from?: string
  to?: string
  tipo?: 'pontual' | 'recorrente'
  metodo?: 'PIX' | 'CARD' | 'QUITA'
  status?: string
  owner_id?: string
  company_id?: string
}

async function calculateKPIs(filters: Filters) {
  const { from, to } = filters
  
  console.log('[admin-reports] Calculating KPIs with filters:', { from, to })
  
  // Total Recebido Bruto - from payment_splits with status concluded
  let brutaQuery = supabase
    .from('payment_splits')
    .select('amount_cents')
    .eq('status', 'concluded')
  
  if (from) brutaQuery = brutaQuery.gte('created_at', from)
  if (to) brutaQuery = brutaQuery.lte('created_at', to + 'T23:59:59.999Z')
  
  const { data: brutaData, error: brutaError } = await brutaQuery
  if (brutaError) console.error('[admin-reports] Error fetching bruta:', brutaError)
  
  const totalBruto = (brutaData || []).reduce((sum, t) => sum + (t.amount_cents || 0), 0) / 100
  console.log('[admin-reports] Total Bruto:', totalBruto, 'from', brutaData?.length, 'splits')
  
  // Estornos - from refund_jobs with status completed
  let estornosQuery = supabase
    .from('refund_jobs')
    .select('refund_amount_cents')
    .eq('status', 'completed')
  
  if (from) estornosQuery = estornosQuery.gte('created_at', from)
  if (to) estornosQuery = estornosQuery.lte('created_at', to + 'T23:59:59.999Z')
  
  const { data: estornosData } = await estornosQuery
  const totalEstornos = (estornosData || []).reduce((sum, t) => sum + (t.refund_amount_cents || 0), 0) / 100
  
  // Taxas de Estorno - from refund_jobs
  let taxasQuery = supabase
    .from('refund_jobs')
    .select('fee_amount_cents')
    .eq('status', 'completed')
  
  if (from) taxasQuery = taxasQuery.gte('created_at', from)
  if (to) taxasQuery = taxasQuery.lte('created_at', to + 'T23:59:59.999Z')
  
  const { data: taxasData } = await taxasQuery
  const totalTaxas = (taxasData || []).reduce((sum, t) => sum + (t.fee_amount_cents || 0), 0) / 100
  
  // Conversão - charges completed vs total charges
  let chargesCreatedQuery = supabase.from('charges').select('id', { count: 'exact' })
  let chargesPaidQuery = supabase.from('charges').select('id', { count: 'exact' }).eq('status', 'completed')
  
  if (from) {
    chargesCreatedQuery = chargesCreatedQuery.gte('created_at', from)
    chargesPaidQuery = chargesPaidQuery.gte('created_at', from)
  }
  if (to) {
    chargesCreatedQuery = chargesCreatedQuery.lte('created_at', to + 'T23:59:59.999Z')
    chargesPaidQuery = chargesPaidQuery.lte('created_at', to + 'T23:59:59.999Z')
  }
  
  const { count: chargesCreated } = await chargesCreatedQuery
  const { count: chargesPaid } = await chargesPaidQuery
  
  console.log('[admin-reports] Charges:', { created: chargesCreated, paid: chargesPaid })
  
  const conversao = chargesCreated ? ((chargesPaid || 0) / chargesCreated) * 100 : 0
  
  // Inadimplência Recorrente
  const graceDays = 7
  const graceDate = new Date()
  graceDate.setDate(graceDate.getDate() - graceDays)
  
  const { count: executionsReadyOld } = await supabase
    .from('charge_executions')
    .select('id', { count: 'exact' })
    .eq('status', 'pending')
    .lte('scheduled_for', graceDate.toISOString())
  
  const { count: executionsReadyTotal } = await supabase
    .from('charge_executions')
    .select('id', { count: 'exact' })
    .eq('status', 'pending')
  
  const inadimplencia = executionsReadyTotal ? ((executionsReadyOld || 0) / executionsReadyTotal) * 100 : 0
  
  return {
    totalBruto,
    totalEstornos,
    totalTaxas,
    totalLiquido: totalBruto - totalEstornos,
    conversao: Math.round(conversao * 100) / 100,
    inadimplencia: Math.round(inadimplencia * 100) / 100
  }
}

async function getTableData(entity: string, filters: Filters, page = 1, pageSize = 50) {
  let query
  
  switch (entity) {
    case 'transactions':
      query = supabase.from('transactions').select('*', { count: 'exact' })
      break
    case 'charges':
      query = supabase.from('charges').select('*', { count: 'exact' })
      break
    case 'executions':
      query = supabase.from('charge_executions').select('*', { count: 'exact' })
      break
    case 'splits':
      query = supabase.from('payment_splits').select('*', { count: 'exact' })
      break
    default:
      throw new Error(`Invalid entity: ${entity}`)
  }
  
  if (filters.from) query = query.gte('created_at', filters.from)
  if (filters.to) query = query.lte('created_at', filters.to)
  
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  
  query = query.range(from, to).order('created_at', { ascending: false })
  
  return await query
}

async function getChartData(filters: Filters) {
  const fromDate = filters.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const toDate = filters.to ? filters.to + 'T23:59:59.999Z' : new Date().toISOString()
  
  // Receita diária - from payment_splits concluded
  const { data: dailyRevenue } = await supabase
    .from('payment_splits')
    .select('created_at, amount_cents, method')
    .eq('status', 'concluded')
    .gte('created_at', fromDate)
    .lte('created_at', toDate)
    .order('created_at')
  
  console.log('[admin-reports] Daily revenue splits:', dailyRevenue?.length)
  
  // Agrupar por dia
  const dailyMap = new Map()
  const methodTotals = new Map<string, number>()
  
  dailyRevenue?.forEach(t => {
    const date = new Date(t.created_at).toISOString().split('T')[0]
    dailyMap.set(date, (dailyMap.get(date) || 0) + (t.amount_cents || 0) / 100)
    
    // Agrupar por método
    const method = t.method === 'credit_card' ? 'CARD' : t.method?.toUpperCase() || 'OTHER'
    methodTotals.set(method, (methodTotals.get(method) || 0) + (t.amount_cents || 0) / 100)
  })
  
  const dailyData = Array.from(dailyMap.entries()).map(([date, value]) => ({
    date,
    value
  }))
  
  // Receita por método - dados reais
  const methodData = Array.from(methodTotals.entries()).map(([method, value]) => ({
    method,
    value
  }))
  
  // Status distribution - from charges real data
  const { data: statusCounts } = await supabase
    .from('charges')
    .select('status')
    .gte('created_at', fromDate)
    .lte('created_at', toDate)
  
  const statusMap = new Map<string, number>()
  statusCounts?.forEach(c => {
    const status = c.status?.toUpperCase() || 'UNKNOWN'
    statusMap.set(status, (statusMap.get(status) || 0) + 1)
  })
  
  const statusData = Array.from(statusMap.entries()).map(([status, value]) => ({
    status,
    value
  }))
  
  return {
    daily: dailyData,
    methods: methodData,
    status: statusData
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const path = url.pathname.split('/').pop()
    
    if (path === 'summary') {
      // GET /admin/reports/summary
      const filters: Filters = {
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        tipo: url.searchParams.get('tipo') as any,
        metodo: url.searchParams.get('metodo') as any,
        status: url.searchParams.get('status') || undefined,
        owner_id: url.searchParams.get('owner_id') || undefined,
        company_id: url.searchParams.get('company_id') || undefined
      }
      
      const kpis = await calculateKPIs(filters)
      const charts = await getChartData(filters)
      
      return new Response(JSON.stringify({ kpis, charts }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    if (path === 'table') {
      // GET /admin/reports/table
      const entity = url.searchParams.get('entity') || 'transactions'
      const page = parseInt(url.searchParams.get('page') || '1')
      const pageSize = parseInt(url.searchParams.get('page_size') || '50')
      
      const filters: Filters = {
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        tipo: url.searchParams.get('tipo') as any,
        metodo: url.searchParams.get('metodo') as any,
        status: url.searchParams.get('status') || undefined,
        owner_id: url.searchParams.get('owner_id') || undefined,
        company_id: url.searchParams.get('company_id') || undefined
      }
      
      const result = await getTableData(entity, filters, page, pageSize)
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    if (req.method === 'POST' && path === 'export') {
      // POST /admin/reports/export
      const { entity, format, filters } = await req.json()
      
      // Criar job de exportação
      const { data: job, error } = await supabase
        .from('export_jobs')
        .insert({
          owner_id: filters.owner_id || '00000000-0000-0000-0000-000000000000',
          company_id: filters.company_id,
          format,
          scope: entity,
          filters_json: filters,
          status: 'QUEUED'
        })
        .select()
        .single()
      
      if (error) throw error
      
      return new Response(JSON.stringify(job), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    // GET /admin/reports/export/:job_id
    const jobId = path
    if (jobId && jobId.length === 36) { // UUID length
      const { data: job, error } = await supabase
        .from('export_jobs')
        .select('*')
        .eq('id', jobId)
        .single()
      
      if (error) throw error
      
      let downloadUrl = null
      if (job.status === 'DONE' && job.file_path) {
        const { data } = await supabase.storage
          .from('exports')
          .createSignedUrl(job.file_path, 24 * 60 * 60) // 24h TTL
        downloadUrl = data?.signedUrl
      }
      
      return new Response(JSON.stringify({ ...job, download_url: downloadUrl }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    return new Response('Not found', { status: 404, headers: corsHeaders })
    
  } catch (error) {
    console.error('Error in admin-reports:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

}
