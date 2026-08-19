import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalizarNome(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/).filter(Boolean).sort().join(" ");
}

// Comparação rigorosa: o nome do documento precisa bater 100% com o nome
// cadastrado (todas as palavras, ignorando acento/maiúscula/ordem) — não aceita
// mais correspondência parcial.
function nomesConferem(nomeCadastrado: string, nomeExtraido: string): boolean {
  if (!nomeExtraido) return false;
  const a = normalizarNome(nomeCadastrado);
  const b = normalizarNome(nomeExtraido);
  if (!a || !b) return false;
  return a === b;
}

function apenasDigitos(s: string): string {
  return (s || "").replace(/\D/g, "");
}

// Comparação rigorosa de CPF: precisa bater dígito a dígito. Só é aplicada
// quando o CPF realmente aparece no documento (nem todo RG/CNH mostra o CPF
// impresso) — se não aparecer, não bloqueia por causa disso.
function cpfsConferem(cpfCadastrado: string, cpfExtraido: string): boolean {
  const a = apenasDigitos(cpfCadastrado);
  const b = apenasDigitos(cpfExtraido);
  if (!a || !b) return false;
  return a === b;
}

// Documento pode ser imagem (foto/galeria) ou PDF (digitalizado) - a Claude API
// aceita os dois, mas com blocos de conteudo diferentes.
function blocoDocumento(mediaType: string, base64: string) {
  if (mediaType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
  }
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const {
      nome_cadastrado, cpf_cadastrado,
      doc_base64, doc_media_type,
      selfie_base64, selfie_media_type,
    } = await req.json();

    if (!nome_cadastrado || !doc_base64) {
      return new Response(JSON.stringify({ erro: "parametros_faltando" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return new Response(JSON.stringify({ erro: "chave_nao_configurada" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const temSelfie = !!selfie_base64;
    const docEhPdf = doc_media_type === "application/pdf";

    const content: any[] = [
      { type: "text", text: docEhPdf ? "DOCUMENTO 1 - Documento de identidade (PDF):" : "IMAGEM 1 - Documento de identidade:" },
      blocoDocumento(doc_media_type, doc_base64),
    ];

    const instrucaoBase =
      'Leia com atenção o documento de identidade (RG ou CNH) acima e extraia exatamente três informações: ' +
      '1) nome completo impresso; 2) número do CPF impresso no documento (se houver — nem todo RG/CNH mostra o CPF, ' +
      'nesse caso retorne string vazia); 3) número do RG/registro geral impresso (se houver, senão string vazia). ' +
      'Seja muito preciso na leitura, letra por letra e número por número — isso será usado para conferência de identidade. ';

    let instrucao = instrucaoBase +
      'Responda APENAS em JSON puro, sem markdown, no formato exato: {"nome_documento": "...", "cpf_documento": "...", "rg_documento": "..."}.';

    // Comparacao facial so faz sentido se o documento for imagem (rosto visivel).
    // Se for PDF, normalmente e so texto/digitalizacao do documento, sem se prestar
    // a comparacao visual de rosto - nesse caso so faz a leitura do nome/cpf/rg.
    if (temSelfie && !docEhPdf) {
      content.push({ type: "text", text: "IMAGEM 2 - Selfie enviada pelo morador:" });
      content.push({ type: "image", source: { type: "base64", media_type: selfie_media_type, data: selfie_base64 } });
      instrucao = instrucaoBase +
        'Além disso, compare o rosto da foto do documento com o rosto da selfie (IMAGEM 2). ' +
        'Dê sempre o seu melhor julgamento sobre qual das duas opções está mais próxima da realidade, mesmo que a diferença de ' +
        'ângulo, iluminação ou qualidade de foto entre um documento e uma selfie dificulte a comparação - use "inconclusivo" ' +
        'apenas no caso raro de um dos rostos estar realmente irreconhecível (muito escuro, cortado, fora de foco). ' +
        'Responda APENAS em JSON puro, sem markdown, no formato exato: {"nome_documento": "...", "cpf_documento": "...", ' +
        '"rg_documento": "...", "avaliacao_facial": "mesma_pessoa" ou "pessoas_diferentes" ou "inconclusivo", ' +
        '"observacao_facial": "uma frase curta explicando o motivo"}.';
    } else if (temSelfie && docEhPdf) {
      instrucao += ' O documento enviado é um PDF, então não é possível comparar rosto - deixe avaliacao_facial como ' +
        '"inconclusivo" e observacao_facial explicando que o documento é um PDF sem foto comparável. Responda em JSON: ' +
        '{"nome_documento": "...", "cpf_documento": "...", "rg_documento": "...", "avaliacao_facial": "inconclusivo", "observacao_facial": "..."}.';
    }

    content.push({ type: "text", text: instrucao });

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 350,
        messages: [{ role: "user", content }],
      }),
    });

    const dados = await resp.json();
    const texto = dados.content?.find((b: any) => b.type === "text")?.text || "{}";
    const limpo = texto.replace(/```json|```/g, "").trim();
    let extraido;
    try {
      extraido = JSON.parse(limpo);
    } catch {
      extraido = { nome_documento: "", cpf_documento: "", rg_documento: "", avaliacao_facial: "inconclusivo", observacao_facial: "" };
    }

    const nomeExtraido = extraido.nome_documento || "";
    const cpfExtraido = extraido.cpf_documento || "";

    return new Response(JSON.stringify({
      nome_extraido: nomeExtraido,
      nome_confere: nomesConferem(nome_cadastrado, nomeExtraido),
      cpf_extraido: cpfExtraido,
      cpf_confere: cpf_cadastrado ? cpfsConferem(cpf_cadastrado, cpfExtraido) : null,
      rg_extraido: extraido.rg_documento || "",
      facial_avaliacao: temSelfie ? (extraido.avaliacao_facial || "inconclusivo") : null,
      facial_observacao: temSelfie ? (extraido.observacao_facial || "") : null,
      metodo_verificacao_facial: temSelfie ? "ia_opiniao" : null,
    }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ erro: "erro_interno", detalhe: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
