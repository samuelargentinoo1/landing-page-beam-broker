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

import { createHash } from "node:crypto";

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

/* ---------- Meta Conversions API ---------- */

const sha256 = v => createHash("sha256").update(v).digest("hex");

/* telefone BR -> E.164 com DDI 55, depois hash */
function hashPhone(telefone) {
  let d = telefone.replace(/\D/g, "");
  /* 10-11 dígitos = DDD + número (sem DDI): prefixa 55 sempre —
     inclusive DDD 55 (RS), que começa com 55 mas não tem DDI */
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return sha256(d);
}

async function sendMetaLead(req, b, nome, telefone) {
  const pixelId = process.env.META_PIXEL_ID;
  const token   = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return { skipped: true };

  const partes = nome.toLowerCase().trim().split(/\s+/);
  const userData = {
    ph: [hashPhone(telefone)],
    fn: [sha256(partes[0])],
    client_user_agent: req.headers["user-agent"] || ""
  };
  if (partes.length > 1) userData.ln = [sha256(partes[partes.length - 1])];
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (ip) userData.client_ip_address = ip;
  if (b.fbp) userData.fbp = String(b.fbp);
  if (b.fbc) userData.fbc = String(b.fbc);

  const event = {
    event_name: "Lead",
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    event_source_url: String(b.sourceUrl || "https://landing-page-beam-broker.vercel.app/quiz.html"),
    user_data: userData,
    custom_data: { content_name: "Quiz Raio-X" }
  };
  if (b.eventId) event.event_id = String(b.eventId); // deduplica com o evento do navegador

  try {
    const r = await fetch("https://graph.facebook.com/v21.0/" + pixelId + "/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [event], access_token: token })
    });
    const out = await r.json();
    if (!r.ok) console.error("Meta CAPI falhou", r.status, JSON.stringify(out));
    return out;
  } catch (e) {
    console.error("Meta CAPI erro", e);
    return { error: String(e) };
  }
}

/* ---------- Aviso no grupo do WhatsApp (uazapi) ---------- */

async function notifyWhatsApp(lead) {
  const url   = process.env.UAZAPI_URL;
  const token = process.env.UAZAPI_TOKEN;
  const group = process.env.UAZAPI_GROUP_ID;
  if (!url || !token || !group) return { skipped: true };

  const text =
    "🔥 *Novo lead do Raio-X!*\n\n" +
    "👤 " + lead.nome + " — " + lead.cargo + "\n" +
    "🏢 " + (lead.imobiliaria || "-") + "\n" +
    "📱 " + lead.telefone + "\n\n" +
    "🎯 Objetivo: " + lead.objetivo + "\n" +
    "🏘 Atuação: " + lead.atuacao + "\n" +
    "👥 Corretores: " + lead.corretores + "\n" +
    "💰 VGV/ano: " + lead.vgv + "\n\n" +
    "➡️ Já está no Moskit: funil Inbound → Novo Lead (Ana Julia)";

  try {
    const r = await fetch(url + "/send/text", {
      method: "POST",
      headers: { "Content-Type": "application/json", token: token },
      body: JSON.stringify({ number: group, text: text })
    });
    const out = await r.json().catch(() => null);
    if (!r.ok) console.error("uazapi falhou", r.status, JSON.stringify(out));
    return { ok: r.ok };
  } catch (e) {
    console.error("uazapi erro", e);
    return { error: String(e) };
  }
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

  /* Meta CAPI roda em paralelo com o Moskit — um não bloqueia o outro */
  const metaPromise = sendMetaLead(req, b, nome, telefone);

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
    const meta = await metaPromise; // garante o envio ao Meta mesmo se o CRM falhar
    return res.status(502).json({ error: "Falha ao criar contato no Moskit.", detail: contact.data, meta });
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

  const zap = await notifyWhatsApp({
    nome, telefone, imobiliaria,
    cargo:      label("cargo", cargo),
    objetivo:   label("objetivo", r.objetivo),
    atuacao:    label("atuacao", r.atuacao),
    corretores: label("corretores", r.corretores),
    vgv:        label("vgv", r.vgv)
  });

  const meta = await metaPromise;
  if (!deal.ok) {
    console.error("Moskit /deals falhou", deal.status, JSON.stringify(deal.data));
    return res.status(200).json({ ok: true, contactId, companyId, dealError: deal.data, meta, zap });
  }

  return res.status(200).json({
    ok: true,
    contactId,
    companyId,
    dealId: deal.data ? deal.data.id : null,
    meta,
    zap
  });
}
