// @ts-nocheck
import https from 'node:https';
import forge from 'node-forge';

export const TREEAL_CASHIN_URL = "https://api.pix.treeal.com";

export interface MtlsCredentials {
  certPem: string;
  keyPem: string;
  caCerts: string[];
}

/** Parses a base64-encoded PFX and returns PEM cert + key + CA chain. */
export function buildMtlsCredentials(certBase64: string, certPassword: string): MtlsCredentials {
  const cleanBase64 = certBase64.replace(/\s+/g, "");
  const pfxBinary = atob(cleanBase64);
  const pfxBuffer = forge.util.createBuffer(pfxBinary, "binary");
  const pfxAsn1 = forge.asn1.fromDer(pfxBuffer);
  const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, false, certPassword);

  const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
  if (!certBags?.length) throw new Error("Certificado nao encontrado no arquivo PFX");

  // Deno expects the client certificate chain concatenated in PEM format.
  const leafCertPem = forge.pki.certificateToPem(certBags[0].cert);
  const caCerts = certBags.slice(1).map((bag) => forge.pki.certificateToPem(bag.cert));
  const certPem = [leafCertPem, ...caCerts].join("\n");

  let keyPem: string;
  const shroudedBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
  if (shroudedBags?.length > 0) {
    keyPem = forge.pki.privateKeyToPem(shroudedBags[0].key);
  } else {
    const keyBags = pfx.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];
    if (!keyBags?.length) throw new Error("Chave privada nao encontrada no arquivo PFX");
    keyPem = forge.pki.privateKeyToPem(keyBags[0].key);
  }

  console.log(`PFX parsed: leaf cert OK, ${caCerts.length} chain cert(s) extracted`);
  return { certPem, keyPem, caCerts };
}

/**
 * Makes an HTTPS/mTLS request using Deno's native HTTP client.
 * - Supports TLS 1.3
 * - Sends the client certificate in the format Deno expects (`cert` + `key`)
 * - Lets fetch handle chunked/gzip/http2 responses correctly
 */
export async function fetchMtls(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string },
  creds: MtlsCredentials,
): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }> {
  const target = new URL(url);
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers: options.headers,
      cert: creds.certPem,
      key: creds.keyPem,
      ca: creds.caCerts.length > 0 ? creds.caCerts : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });

  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    text: async () => result.body,
    json: async () => JSON.parse(result.body),
  };
}

/** Obtains an OAuth2 Bearer token from Treeal using client_credentials flow. */
export async function getAccessToken(
  creds: MtlsCredentials,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const response = await fetchMtls(
    `${TREEAL_CASHIN_URL}/oauth/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(body.length),
      },
      body,
    },
    creds,
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Treeal OAuth falhou [${response.status}]: ${detail}`);
  }

  const data = await response.json() as Record<string, unknown>;
  if (!data.access_token) throw new Error("Treeal OAuth: access_token ausente na resposta");
  return data.access_token as string;
}

/** Loads and validates the five required Treeal env secrets. */
export function loadTreealConfig() {
  const certBase64   = process.env.TREEAL_CERT_BASE64;
  const certPassword = process.env.TREEAL_CERT_PASSWORD;
  const clientId     = process.env.TREEAL_CLIENT_ID;
  const clientSecret = process.env.TREEAL_CLIENT_SECRET;
  const pixKey       = process.env.TREEAL_PIX_KEY;

  if (!certBase64 || !certPassword || !clientId || !clientSecret || !pixKey) {
    throw new Error(
      "Secrets da Treeal ausentes. Configure: TREEAL_CERT_BASE64, TREEAL_CERT_PASSWORD, TREEAL_CLIENT_ID, TREEAL_CLIENT_SECRET, TREEAL_PIX_KEY",
    );
  }

  return { certBase64, certPassword, clientId, clientSecret, pixKey };
}

/** Maps Treeal/BACEN COB status to the internal system status. */
export function mapTreealStatus(status: string): "pending" | "concluded" | "failed" {
  switch (status) {
    case "CONCLUIDA": return "concluded";
    case "ATIVA":     return "pending";
    case "REMOVIDA_PELO_USUARIO_RECEBEDOR":
    case "REMOVIDA_PELO_PSP": return "failed";
    default: return "pending";
  }
}
