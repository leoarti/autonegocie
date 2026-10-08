// @ts-nocheck
import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Function to generate a bankslip number
function generateBankslipNumber(): string {
  // Generate a simple bankslip number based on timestamp and random digits
  const timestamp = Date.now().toString().slice(-8) // Last 8 digits of timestamp
  const random = Math.floor(Math.random() * 100000).toString().padStart(5, '0') // 5 random digits
  return timestamp + random // 13 digits total
}

// Function to mask sensitive data in logs
function maskSensitiveData(obj: any): any {
  if (!obj) return obj
  
  const masked = JSON.parse(JSON.stringify(obj))
  
  // Mask credit card data
  if (masked.CardNumber) masked.CardNumber = '****-****-****-' + (masked.CardNumber.slice(-4) || '****')
  if (masked.CardCvv) masked.CardCvv = '***'
  if (masked.CardExpirationDate) masked.CardExpirationDate = '**/**'
  if (masked.DebtorDocument) masked.DebtorDocument = '***masked***'
  if (masked.DebtorPhoneNumber) masked.DebtorPhoneNumber = '***masked***'
  
  // Mask nested card data
  if (masked.card) {
    if (masked.card.number) masked.card.number = '****-****-****-' + (masked.card.number.slice(-4) || '****')
    if (masked.card.cvv) masked.card.cvv = '***'
    if (masked.card.expirationDate) masked.card.expirationDate = '**/**'
  }
  
  // Mask debtor sensitive data  
  if (masked.debtor) {
    if (masked.debtor.document) masked.debtor.document = '***masked***'
    if (masked.debtor.phoneNumber) masked.debtor.phoneNumber = '***masked***'
  }

  // Mask payer sensitive data
  if (masked.payer) {
    if (masked.payer.document) masked.payer.document = '***masked***'
    if (masked.payer.phoneNumber) masked.payer.phoneNumber = '***masked***'
  }
  
  // Mask in OrderDetails structure
  if (masked.OrderDetails) {
    if (masked.OrderDetails.Debtor) {
      if (masked.OrderDetails.Debtor.Document) masked.OrderDetails.Debtor.Document = '***masked***'
      if (masked.OrderDetails.Debtor.PhoneNumber) masked.OrderDetails.Debtor.PhoneNumber = '***masked***'
    }
    if (masked.OrderDetails.Payer) {
      if (masked.OrderDetails.Payer.Document) masked.OrderDetails.Payer.Document = '***masked***'
      if (masked.OrderDetails.Payer.PhoneNumber) masked.OrderDetails.Payer.PhoneNumber = '***masked***'
    }
  }
  
  return masked
}

async function getAuthToken(supabase: any, maxRetries = 3): Promise<string> {
  let lastError: any

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Getting auth token, attempt ${attempt}/${maxRetries}`)
      
      const { data: tokenData, error } = await supabase.functions.invoke('quitaplus-token')
      
      if (error) {
        throw new Error(`Token error: ${error.message}`)
      }
      
      if (!tokenData?.accessToken) {
        throw new Error('Token não recebido')
      }
      
      console.log('Auth token obtained successfully')
      return tokenData.accessToken
      
    } catch (error: any) {
      console.log(`Token request failed on attempt ${attempt}:`, error.message)
      lastError = error
      
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000) // Exponential backoff
      }
    }
  }
  
  throw lastError
}

async function makeApiRequest(
  accessToken: string,
  endpoint: string,
  method: string,
  payload: any,
  maxRetries = 3
): Promise<any> {
  const baseUrl = process.env.QUITAPLUS_BASE_URL || 'https://pay-gt.autonegocie.com'
  const url = `${baseUrl}/${endpoint}`
  let lastError: any
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Making API request to ${url}, attempt ${attempt}/${maxRetries}`)
      
      const requestOptions: RequestInit = {
        method: method,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }
      }
      
      if (payload && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        requestOptions.body = JSON.stringify(payload)
      }
      
      const response = await fetch(url, requestOptions)
      
      console.log(`Response status: ${response.status}`)
      
      if (response.ok) {
        const data = await response.json()
        console.log('API request successful:', data)
        return data
      }
      
      // Get response body for debugging
      const errorText = await response.text()
      console.log(`Response error (${response.status}):`, errorText)
      console.log('Response headers:', JSON.stringify([...response.headers.entries()]))
      
      // Handle rate limiting and server errors with retry
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get('retry-after')
        const backoffMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000
        
        console.log(`Request failed with ${response.status}, retrying in ${backoffMs}ms`)
        
        if (attempt < maxRetries) {
          await sleep(backoffMs)
          continue
        }
      }
      
      // For other errors, prepare to return error
      lastError = {
        status: response.status,
        message: errorText,
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
    // Receive UI data directly 
    const uiData = await req.json()
    
    console.log('Processing UI data:', JSON.stringify(maskSensitiveData(uiData), null, 2))
    
    // Initialize Supabase client for calling other edge functions
    const supabaseUrl = process.env.SUPABASE_URL!
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseKey)
    
    // Get authentication token
    const accessToken = await getAuthToken(supabase)
    
    // Get environment variables
    const merchantId = process.env.QUITA_MAIS_MERCHANT_ID
    const creditorDocument = process.env.QUITA_MAIS_CREDITOR_DOCUMENT
    const creditorName = process.env.QUITA_MAIS_CREDITOR_NAME
    
    if (!merchantId) {
      throw { status: 400, message: 'Missing required QUITA_MAIS_MERCHANT_ID secret' }
    }
    if (!creditorDocument) {
      throw { status: 400, message: 'Missing required QUITA_MAIS_CREDITOR_DOCUMENT secret' }
    }
    if (!creditorName) {
      throw { status: 400, message: 'Missing required QUITA_MAIS_CREDITOR_NAME secret' }
    }

    // ====== CONTRATO CANÔNICO QUITA+ ======
    
    // 1. NORMALIZAR orderType obrigatório → NUMÉRICO PARA PATH
    let normalizedOrderType: string
    const rawOrderType = uiData.orderType
    
    if (rawOrderType === "boleto" || rawOrderType === "bankslip" || rawOrderType === "1" || rawOrderType === 1) {
      normalizedOrderType = "1" // Boleto = tipo 1 (numérico exigido no path)
    } else {
      throw { status: 400, message: `orderType inválido: ${rawOrderType}. Valores aceitos: "boleto", "bankslip", "1", 1` }
    }

    // 2. BUILD REQUEST_BODY - JSON CANÔNICO EXATO
    const REQUEST_BODY = {
      "orderDetails": {
        "merchantId": merchantId,
        "initiatorKey": uiData.initiatorKey || null,
        "expiresAt": (() => {
          if (uiData.expirationDate) {
            const date = new Date(uiData.expirationDate)
            return date.toISOString().slice(0, 19).replace('T', ' ')
          } else {
            // Default: 30 dias
            const defaultExpiration = new Date()
            defaultExpiration.setDate(defaultExpiration.getDate() + 30)
            return defaultExpiration.toISOString().slice(0, 19).replace('T', ' ')
          }
        })(),
        "description": uiData.description || null,
        "details": uiData.details || null,
        "payer": {
          "document": uiData.payer?.document?.replace(/\D/g, '') || "",
          "email": uiData.payer?.email || "",
          "phoneNumber": uiData.payer?.phoneNumber?.replace(/\D/g, '') || "",
          "name": uiData.payer?.name || ""
        },
        "bankslip": {
          "number": uiData.bankslip?.number?.replace(/\D/g, '') || generateBankslipNumber(),
          "creditorDocument": creditorDocument.replace(/\D/g, ''),
          "creditorName": creditorName
        },
        "checkout": {
          "maskFee": uiData.checkout?.maskFee === true,
          "installments": (uiData.checkout?.installments && uiData.checkout.installments > 0) ? 
            parseInt(uiData.checkout.installments.toString()) : null
        }
      }
    }

    // 3. VALIDAÇÃO DO JSON CANÔNICO
    const validateCanonicalStructure = (body: any): boolean => {
      // Verificar objeto raiz contém apenas orderDetails
      const rootKeys = Object.keys(body)
      if (rootKeys.length !== 1 || rootKeys[0] !== 'orderDetails') {
        console.error('VALIDATION FAILED: Root object must contain only orderDetails')
        return false
      }

      const orderDetails = body.orderDetails
      const expectedOrderDetailsKeys = ['merchantId', 'initiatorKey', 'expiresAt', 'description', 'details', 'payer', 'bankslip', 'checkout']
      const actualOrderDetailsKeys = Object.keys(orderDetails)
      
      // Verificar chaves do orderDetails
      if (actualOrderDetailsKeys.length !== expectedOrderDetailsKeys.length) {
        console.error('VALIDATION FAILED: orderDetails keys count mismatch')
        return false
      }
      
      for (const key of expectedOrderDetailsKeys) {
        if (!actualOrderDetailsKeys.includes(key)) {
          console.error(`VALIDATION FAILED: Missing key in orderDetails: ${key}`)
          return false
        }
      }

      // Verificar chaves do payer (verificar se existe primeiro)
      if (orderDetails.payer && typeof orderDetails.payer === 'object') {
        const expectedPayerKeys = ['document', 'email', 'phoneNumber', 'name']
        const actualPayerKeys = Object.keys(orderDetails.payer)
        if (!expectedPayerKeys.every(key => actualPayerKeys.includes(key)) || 
            actualPayerKeys.length !== expectedPayerKeys.length) {
          console.error('VALIDATION FAILED: payer keys mismatch')
          return false
        }
      } else {
        console.error('VALIDATION FAILED: payer must be an object')
        return false
      }

      // Verificar chaves do bankslip (verificar se existe primeiro)
      if (orderDetails.bankslip && typeof orderDetails.bankslip === 'object') {
        const expectedBankslipKeys = ['number', 'creditorDocument', 'creditorName']
        const actualBankslipKeys = Object.keys(orderDetails.bankslip)
        if (!expectedBankslipKeys.every(key => actualBankslipKeys.includes(key)) || 
            actualBankslipKeys.length !== expectedBankslipKeys.length) {
          console.error('VALIDATION FAILED: bankslip keys mismatch')
          return false
        }
      } else {
        console.error('VALIDATION FAILED: bankslip must be an object')
        return false
      }

      // Verificar chaves do checkout (verificar se existe primeiro)
      if (orderDetails.checkout && typeof orderDetails.checkout === 'object') {
        const expectedCheckoutKeys = ['maskFee', 'installments']
        const actualCheckoutKeys = Object.keys(orderDetails.checkout)
        if (!expectedCheckoutKeys.every(key => actualCheckoutKeys.includes(key)) || 
            actualCheckoutKeys.length !== expectedCheckoutKeys.length) {
          console.error('VALIDATION FAILED: checkout keys mismatch')
          return false
        }
      } else {
        console.error('VALIDATION FAILED: checkout must be an object')
        return false
      }

      return true
    }

    // Validar estrutura antes de prosseguir
    if (!validateCanonicalStructure(REQUEST_BODY)) {
      throw { status: 400, message: 'REQUEST_BODY não conforme ao JSON canônico' }
    }

    // 4. BUILD EXTRAS_TO_STORE - dados somente para o banco (NUNCA enviados para API)
    const EXTRAS_TO_STORE = {
      amount: uiData.amount || 0,
      order_type_ui: rawOrderType,
      orderId: uiData.orderId || null,
      ui_snapshot: uiData // snapshot completo da UI
    }
    
    
    const baseUrl = process.env.QUITAPLUS_BASE_URL || 'https://pay-gt.autonegocie.com'
    
    console.log('REQUEST_BODY (CONTRATO EXATO):', JSON.stringify(maskSensitiveData(REQUEST_BODY), null, 2))
    console.log('EXTRAS_TO_STORE (SOMENTE DB):', JSON.stringify(maskSensitiveData(EXTRAS_TO_STORE), null, 2))
    console.log('URL FINAL COMPLETA:', `${baseUrl}/payment/order/${normalizedOrderType}`)
    console.log('NORMALIZED ORDER TYPE:', normalizedOrderType)
    
    // Fazer chamada para API Quita+ com URL normalizada e REQUEST_BODY limpo
    const result = await makeApiRequest(accessToken, `payment/order/${normalizedOrderType}`, 'POST', REQUEST_BODY)
    
    // Return result with extras for database storage
    return new Response(
      JSON.stringify({
        ...result,
        _extrasToStore: EXTRAS_TO_STORE
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (error: any) {
    console.error('Error in quitaplus-proxy:', error)
    
    // Enhanced error response with debug info for 400/404
    const errorResponse: any = { 
      error: 'Proxy request failed', 
      details: error.message || 'Request failed',
      status: error.status || 500,
      lastAttempt: error.attempt || 1
    }
    
    // Add debug info for validation errors (400/404)
    if (error.status === 400 || error.status === 404) {
      errorResponse.debug = {
        url: `${baseUrl}/payment/order/${normalizedOrderType}`,
        orderTypeNormalizado: normalizedOrderType,
        hasOrderDetails: REQUEST_BODY && REQUEST_BODY.orderDetails ? true : false
      }
    }
    
    return new Response(
      JSON.stringify(errorResponse),
      { 
        status: error.status || 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }

}
