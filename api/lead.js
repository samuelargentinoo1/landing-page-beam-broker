/**
 * Recebe os dados do quiz da landing e cria o lead no Moskit CRM:
 *   1. Empresa (a imobiliária)
 *   2. Contato (nome + WhatsApp + cargo), vinculado à empresa
 *   3. Negócio no Funil Inbound > Novo Lead, com as respostas do quiz
 *      em campos personalizados (visíveis só nesse funil)
 *
 * Única variável de ambiente necessária (configurada na Vercel):
 *   MOSKIT_API_KEY
 */

const MOSKIT_API = "https://api.moskitcrm.com/v2";

/* ids validados na conta Moskit da Beam (jul/2026) */
const RESPONSIBLE_ID = 159056;  // Ana Julia <ana@beam360.com.br>
const STAGE_ID       = 503634;  // Funil de Vendas - Inbound > Novo Lead
const ORIGEM_LABEL   = "Landing Page Raio-X (quiz)";

const CF = {
  cargoContato: "CF_075MJBSjC9EgeMaz", // contato: Cargo ou Função
  objetivo:     "CF_vG0mR0ikCzdNjqbV", // negócio: Objetivo comercial
  atuacao:      "CF_2ojMxLiPCoRbgMOE", // negócio: Atuação da imobiliária
  corretores:   "CF_K7Rm8QiRCVzXnDbN", // negócio: Nº de corretores
  vgv:          "CF_gvGm3Bi0CGnrkM45", // negócio: VGV anual
  origem:       "CF_3LvDvEi4CLR43m6a"  // negócio: Origem do lead
};

/* tags do quiz -> rótulos legíveis no CRM */
const LABELS = {
  cargo: {
    "dono":             "Dono de imobiliária",
    "gestor-comercial": "Gestor comercial",
    "corretor":         "Corretor"
  },
  objetivo: {
    "converter-mais":    "Vender mais com os leads que já chegam",
    "menos-dependencia": "Depender menos de portais e indicações",
    "estruturar-time":   "Estruturar ou escalar o time de corretores",
    "previsibilidade":   "Ter previsibilidade de vendas todo mês"
  },
  atuacao: {
    "locacao":      "Locação e administração de imóveis",
    "mcmv":         "Imóveis populares e MCMV",
    "medio-padrao": "Médio padrão",
    "alto-padrao":  "Alto padrão e luxo",
    "lancamentos":  "Lançamentos e incorporação",
    "mista":        "Venda e locação (mista)"
  },
  corretores: {
    "solo":    "Trabalha sozinho por enquanto",
    "2-5":     "2 a 5 corretores",
    "6-15":    "6 a 15 corretores",
    "16-40":   "16 a 40 corretores",
    "40-mais": "Mais de 40 corretores"
  },
  vgv: {
    "ate-5mi":       "Até R$ 5 milhões",
    "5-20mi":        "De R$ 5 a R$ 20 milhões",
    "20-50mi":       "De R$ 20 a R$ 50 milhões",
    "50mi-mais":     "Acima de R$ 50 milhões",
    "nao-acompanha": "Ainda não acompanha esse número"
  }
};

const label = (group, tag) => (LABELS[group] && LABELS[group][tag]) || tag || "-";

async function moskit(path, method, key, body) {
  const res = await fetch(MOSKIT_API + path, {
    method,
    headers: { "Content-Type": "application/json", apikey: key },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  const key = process.env.MOSKIT_API_KEY;
  if (!key) {
    return res.status(503).json({ error: "Integração Moskit não configurada (MOSKIT_API_KEY ausente)." });
  }

  const b = req.body || {};
  const nome        = String(b.nome || "").trim();
  const telefone    = String(b.telefone || "").trim();
  const imobiliaria = String(b.imobiliaria || "").trim();
  const cargo       = String(b.cargo || "").trim();
  const r           = b.respostas && typeof b.respostas === "object" ? b.respostas : {};

  if (nome.length < 2 || telefone.replace(/\D/g, "").length < 10) {
    return res.status(400).json({ error: "Dados incompletos." });
  }

  const who = { createdBy: { id: RESPONSIBLE_ID }, responsible: { id: RESPONSIBLE_ID } };
  const resumo =
    "Lead da " + ORIGEM_LABEL + "\n" +
    "Imobiliária: " + imobiliaria + "\n" +
    "Cargo: " + label("cargo", cargo) + "\n" +
    "Objetivo: " + label("objetivo", r.objetivo) + "\n" +
    "Atuação: " + label("atuacao", r.atuacao) + "\n" +
    "Corretores: " + label("corretores", r.corretores) + "\n" +
    "VGV/ano: " + label("vgv", r.vgv);

  /* 1) empresa (imobiliária) — não bloqueia o fluxo se falhar */
  let companyId = null;
  if (imobiliaria.length >= 2) {
    const company = await moskit("/companies", "POST", key,
      Object.assign({ name: imobiliaria }, who));
    if (company.ok && company.data && company.data.id) companyId = company.data.id;
    else console.error("Moskit /companies falhou", company.status, JSON.stringify(company.data));
  }

  /* 2) contato */
  const contactPayload = Object.assign({
    name: nome,
    phones: [{ number: telefone }],
    notes: resumo,
    entityCustomFields: [{ id: CF.cargoContato, textValue: label("cargo", cargo) }]
  }, who);
  if (companyId) contactPayload.employers = [{ company: { id: companyId } }];

  const contact = await moskit("/contacts", "POST", key, contactPayload);
  if (!contact.ok || !contact.data || !contact.data.id) {
    console.error("Moskit /contacts falhou", contact.status, JSON.stringify(contact.data));
    return res.status(502).json({ error: "Falha ao criar contato no Moskit.", detail: contact.data });
  }
  const contactId = contact.data.id;

  /* 3) negócio no Inbound > Novo Lead */
  const dealPayload = Object.assign({
    name: nome,
    stage: { id: STAGE_ID },
    status: "OPEN",
    contacts: [{ id: contactId }],
    entityCustomFields: [
      { id: CF.objetivo,   textValue: label("objetivo", r.objetivo) },
      { id: CF.atuacao,    textValue: label("atuacao", r.atuacao) },
      { id: CF.corretores, textValue: label("corretores", r.corretores) },
      { id: CF.vgv,        textValue: label("vgv", r.vgv) },
      { id: CF.origem,     textValue: ORIGEM_LABEL }
    ]
  }, who);
  if (companyId) dealPayload.companies = [{ id: companyId }];

  const deal = await moskit("/deals", "POST", key, dealPayload);
  if (!deal.ok) {
    console.error("Moskit /deals falhou", deal.status, JSON.stringify(deal.data));
    return res.status(200).json({ ok: true, contactId, companyId, dealError: deal.data });
  }

  return res.status(200).json({
    ok: true,
    contactId,
    companyId,
    dealId: deal.data ? deal.data.id : null
  });
}
