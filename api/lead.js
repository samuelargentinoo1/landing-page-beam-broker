/**
 * Recebe os dados do quiz e cria o lead no Moskit CRM.
 *
 * Variáveis de ambiente (configurar na Vercel):
 *   MOSKIT_API_KEY      — obrigatória. Gerada no Moskit em Apps > API pública.
 *   MOSKIT_STAGE_ID     — opcional. Id da fase do funil onde criar o negócio.
 *                         Sem ela, apenas o contato é criado.
 *   MOSKIT_RESPONSIBLE  — opcional. Id do usuário responsável pelo lead.
 */

const MOSKIT_API = "https://api.moskitcrm.com/v2";

const CARGO_LABELS = {
  "dono": "Dono de imobiliária",
  "gestor-comercial": "Gestor comercial",
  "corretor": "Corretor"
};

async function moskit(path, method, key, body) {
  const res = await fetch(MOSKIT_API + path, {
    method: method,
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
    return res.status(503).json({ error: "Integração Moskit ainda não configurada (MOSKIT_API_KEY ausente)." });
  }

  const b = req.body || {};
  const nome = String(b.nome || "").trim();
  const telefone = String(b.telefone || "").trim();
  const imobiliaria = String(b.imobiliaria || "").trim();
  const cargo = String(b.cargo || "").trim();
  const respostas = b.respostas && typeof b.respostas === "object" ? b.respostas : {};

  if (nome.length < 2 || telefone.replace(/\D/g, "").length < 10) {
    return res.status(400).json({ error: "Dados incompletos." });
  }

  const cargoLabel = CARGO_LABELS[cargo] || cargo;
  const resumo = [
    "Lead do quiz Raio-X (landing Beam Broker)",
    "Imobiliária: " + imobiliaria,
    "Cargo: " + cargoLabel,
    "Objetivo: " + (respostas.objetivo || "-"),
    "Atuação: " + (respostas.atuacao || "-"),
    "Corretores: " + (respostas.corretores || "-"),
    "VGV/ano: " + (respostas.vgv || "-")
  ].join("\n");

  const responsible = process.env.MOSKIT_RESPONSIBLE
    ? { id: Number(process.env.MOSKIT_RESPONSIBLE) }
    : undefined;

  // 1) cria o contato
  const contactPayload = {
    name: nome,
    phones: [{ number: telefone }],
    notes: resumo
  };
  if (responsible) contactPayload.responsible = responsible;

  const contact = await moskit("/contacts", "POST", key, contactPayload);
  if (!contact.ok) {
    console.error("Moskit /contacts falhou", contact.status, JSON.stringify(contact.data));
    return res.status(502).json({ error: "Falha ao criar contato no Moskit.", detail: contact.data });
  }

  const contactId = contact.data && contact.data.id;

  // 2) cria o negócio, se houver fase de funil configurada
  let deal = null;
  if (process.env.MOSKIT_STAGE_ID && contactId) {
    const dealPayload = {
      name: "Raio-X — " + (imobiliaria || nome),
      stage: { id: Number(process.env.MOSKIT_STAGE_ID) },
      contacts: [{ id: contactId }],
      notes: resumo
    };
    if (responsible) dealPayload.responsible = responsible;

    deal = await moskit("/deals", "POST", key, dealPayload);
    if (!deal.ok) {
      console.error("Moskit /deals falhou", deal.status, JSON.stringify(deal.data));
      // contato já foi criado — reporta sucesso parcial
      return res.status(200).json({ ok: true, contactId, dealError: deal.data });
    }
  }

  return res.status(200).json({
    ok: true,
    contactId,
    dealId: deal && deal.data ? deal.data.id : null
  });
}
