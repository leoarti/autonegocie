# Bloqueio de WAF/CDN — API Cappta

## Problema identificado

A API da Cappta (`api.cappta.com.br`) está protegida por um firewall de aplicação web (WAF) da Akamai, que está bloqueando requisições vindas das funções de borda do Supabase.

### Evidências do bloqueio

```
HTTP 403 Forbidden
Reference: errors.edgesuite.net
```

**Erro retornado:**
```html
<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>
You don't have permission to access "http://api.cappta.com.br/prepayment/authorize" on this server.
Reference #18.16f62917.1764342472.4cc3a29c
</BODY>
</HTML>
```

## Causas prováveis

1. **IP dinâmico fora da lista de permissão**
   - As funções de borda do Supabase usam IPs dinâmicos
   - O firewall não reconhece a origem das requisições

2. **Cabeçalhos insuficientes ou suspeitos**
   - `User-Agent` não reconhecido
   - Falta de cabeçalhos esperados pelo firewall

3. **Limite de taxa**
   - Muitas requisições da mesma faixa de IPs
   - Padrões de acesso considerados suspeitos

4. **Regras de segurança específicas**
   - Bloqueio geográfico
   - Lista de bloqueio de ASNs e provedores de nuvem
   - Validações próprias do firewall

## Soluções

### Solução 1: lista de permissão de IPs (recomendada)

**Contatar a Cappta** para incluir os IPs do Supabase na lista de permissão do firewall.

**IPs das funções de borda do Supabase:**
- Consultar a documentação oficial: https://supabase.com/docs/guides/functions/ip-addresses
- As faixas típicas incluem a AWS `us-east-1` (onde as funções de borda rodam)

**Informações para o suporte:**
- Endpoint bloqueado: `/prepayment/authorize`
- Referência do erro: `errors.edgesuite.net`
- Origem: funções de borda do Supabase (AWS Lambda)

---

### Solução 2: proxy com IP fixo

Implementar um proxy intermediário com IP fixo:

```
[Função de borda do Supabase]
    ↓
[Proxy com IP fixo] ← lista de permissão no firewall
    ↓
[API Cappta]
```

**Opções de proxy:**
- VPS dedicado (DigitalOcean, Linode etc.)
- Gateway de API (AWS API Gateway, Kong etc.)
- Cloudflare Workers com IP fixo

**Exemplo de implementação:**

```typescript
// Proxy simples em Node.js
import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

app.post('/prepayment/authorize', async (req, res) => {
  const response = await fetch('https://api.cappta.com.br/prepayment/authorize', {
    method: 'POST',
    headers: {
      'Authorization': req.headers.authorization,
      'Content-Type': 'application/json',
      // Cabeçalhos adicionais...
    },
    body: JSON.stringify(req.body)
  });

  const data = await response.text();
  res.status(response.status).send(data);
});

app.listen(3000);
```

---

### Solução 3: cabeçalhos mais realistas (parcial)

Adicionar cabeçalhos mais parecidos com os de um navegador para tentar passar pelo firewall:

```typescript
headers: {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Origin': 'https://api.cappta.com.br',
  'Referer': 'https://api.cappta.com.br/',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
}
```

Esta solução pode não bastar se o firewall bloqueia pelo IP.

---

### Solução 4: ambiente de homologação

Solicitar à Cappta um ambiente de homologação, sem firewall, para testes de integração.

---

## Teste de conectividade

Use a página `/admin/connectivity-test` para:
- Testar a obtenção do token
- Verificar o bloqueio do firewall
- Ver a resposta completa da API
- Acompanhar os registros em tempo real

---

## Depuração adicional

### Verificar os IPs do Supabase

```bash
# Fazer a requisição pela função de borda
curl -X POST https://<seu-projeto>.supabase.co/functions/v1/quitaplus-token
```

### Registros detalhados

A função `quitaplus-prepayment` já registra:
- Requisição completa (URL, método, cabeçalhos, corpo mascarado)
- Resposta completa (status, cabeçalhos, corpo)
- Detecção automática de bloqueio do firewall

---

## Contatos

**Suporte Cappta:**
- Solicitar inclusão dos IPs na lista de permissão
- Informar o bloqueio do firewall
- Pedir um ambiente de testes

**Documentação do Supabase:**
- IPs das funções de borda: https://supabase.com/docs/guides/functions/ip-addresses

---

## Situação atual

- Token obtido com sucesso
- Pré-pagamento bloqueado pelo firewall (403)
- Vínculo de boleto pendente (aguarda o pré-pagamento)
- Aguardando a lista de permissão de IPs ou a implementação de um proxy
