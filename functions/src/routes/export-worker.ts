import { createClient, functionUrl } from '../db';
import { corsHeaders } from '../shared/cors'

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
)

function generateCSV(data: any[], headers: string[]): string {
  const csvHeaders = headers.join(',')
  const csvRows = data.map(row => 
    headers.map(header => {
      const value = row[header]
      if (typeof value === 'string' && value.includes(',')) {
        return `"${value.replace(/"/g, '""')}"`
      }
      return value || ''
    }).join(',')
  )
  
  return [csvHeaders, ...csvRows].join('\n')
}

function generateXLSX(data: any[], headers: string[]): Uint8Array {
  // Simplified XLSX generation - in production use a proper library
  // For now, return CSV data as binary
  const csvContent = generateCSV(data, headers)
  return new TextEncoder().encode(csvContent)
}

async function processExportJob(jobId: string) {
  // Marcar job como RUNNING
  await supabase
    .from('export_jobs')
    .update({ 
      status: 'RUNNING', 
      started_at: new Date().toISOString() 
    })
    .eq('id', jobId)
  
  try {
    // Buscar job
    const { data: job } = await supabase
      .from('export_jobs')
      .select('*')
      .eq('id', jobId)
      .single()
    
    if (!job) throw new Error('Job not found')
    
    const filters = job.filters_json as any
    let data: any[] = []
    let headers: string[] = []
    
    // Buscar dados baseado no scope
    switch (job.scope) {
      case 'transactions':
        const { data: txData } = await supabase
          .from('transactions')
          .select('*')
          .gte('created_at', filters.from || '2020-01-01')
          .lte('created_at', filters.to || '2030-12-31')
          .order('created_at', { ascending: false })
        
        data = txData || []
        headers = ['id', 'transaction_id', 'amount_in_cents', 'status', 'payer_name', 'payer_email', 'created_at']
        break
        
      case 'charges':
        const { data: chargeData } = await supabase
          .from('charges')
          .select('*')
          .gte('created_at', filters.from || '2020-01-01')
          .lte('created_at', filters.to || '2030-12-31')
          .order('created_at', { ascending: false })
        
        data = chargeData || []
        headers = ['id', 'payer_name', 'payer_email', 'amount', 'status', 'recurrence_type', 'created_at']
        break
        
      case 'executions':
        const { data: execData } = await supabase
          .from('charge_executions')
          .select('*')
          .gte('created_at', filters.from || '2020-01-01')
          .lte('created_at', filters.to || '2030-12-31')
          .order('created_at', { ascending: false })
        
        data = execData || []
        headers = ['id', 'charge_id', 'status', 'scheduled_for', 'execution_date', 'attempts', 'created_at']
        break
        
      case 'splits':
        const { data: splitData } = await supabase
          .from('payment_splits')
          .select('*')
          .gte('created_at', filters.from || '2020-01-01')
          .lte('created_at', filters.to || '2030-12-31')
          .order('created_at', { ascending: false })
        
        data = splitData || []
        headers = ['id', 'charge_id', 'payment_link_id', 'method', 'amount_cents', 'status', 'created_at']
        break
        
      case 'kpis':
        // Para KPIs, criar dados agregados
        data = [{
          metric: 'Total Bruto',
          value: '0.00',
          period: `${filters.from || ''} - ${filters.to || ''}`,
          generated_at: new Date().toISOString()
        }]
        headers = ['metric', 'value', 'period', 'generated_at']
        break
        
      default:
        throw new Error(`Unknown scope: ${job.scope}`)
    }
    
    // Gerar arquivo
    let fileContent: Uint8Array
    let fileName: string
    let contentType: string
    
    if (job.format === 'CSV') {
      fileContent = new TextEncoder().encode(generateCSV(data, headers))
      fileName = `${job.scope}_${new Date().toISOString().split('T')[0]}_${jobId}.csv`
      contentType = 'text/csv'
    } else {
      fileContent = generateXLSX(data, headers)
      fileName = `${job.scope}_${new Date().toISOString().split('T')[0]}_${jobId}.xlsx`
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
    
    // Upload para Storage
    const filePath = `${job.company_id || 'global'}/${job.scope}/${new Date().toISOString().split('T')[0]}/${fileName}`
    
    const { error: uploadError } = await supabase.storage
      .from('exports')
      .upload(filePath, fileContent, {
        contentType,
        upsert: true
      })
    
    if (uploadError) throw uploadError
    
    // Marcar job como DONE
    await supabase
      .from('export_jobs')
      .update({
        status: 'DONE',
        file_path: filePath,
        rows_count: data.length,
        finished_at: new Date().toISOString()
      })
      .eq('id', jobId)
    
    console.log(`Export job ${jobId} completed successfully`)
    
  } catch (error) {
    console.error(`Export job ${jobId} failed:`, error)
    
    // Marcar job como FAILED
    await supabase
      .from('export_jobs')
      .update({
        status: 'FAILED',
        error: error.message,
        finished_at: new Date().toISOString()
      })
      .eq('id', jobId)
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  try {
    // Buscar jobs QUEUED
    const { data: jobs, error } = await supabase
      .from('export_jobs')
      .select('id')
      .eq('status', 'QUEUED')
      .order('created_at')
      .limit(3) // Processar até 3 jobs por vez
    
    if (error) throw error
    
    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({ message: 'No jobs to process' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    // Processar jobs em paralelo
    const promises = jobs.map(job => processExportJob(job.id))
    await Promise.all(promises)
    
    return new Response(JSON.stringify({ 
      message: `Processed ${jobs.length} export jobs`,
      processed_jobs: jobs.map(j => j.id)
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
    
  } catch (error) {
    console.error('Error in export-worker:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

}
