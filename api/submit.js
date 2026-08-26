// Recebe os dados do Simulador de Financiamento e grava no HubSpot.
//
// O front-end chama esta rota em 4 pontos diferentes (campo "stage" no
// corpo da requisição), sempre em segundo plano (fire-and-forget):
//   stage 1        -> fim do Passo 1 ("Você"): nome/celular/email/papel
//   stage 2        -> fim do Passo 2 ("Condomínio"): + cnpj/motivo/unidades
//   stage 3        -> "Calcular simulação": todos os dados + resultado completo
//   stage 'interesse' -> clique em "Tenho interesse" (sinal extra, opcional)
//
// Em TODOS os estágios (desde que haja e-mail):
//   1) cria/atualiza o Contato no HubSpot (por e-mail)
//   2) envia uma ocorrência do evento personalizado pe50638562_simulador_financiamento,
//      só com as propriedades já conhecidas naquele estágio — isso é o que
//      permite enxergar no HubSpot até onde cada usuário chegou (drop-off),
//      mesmo que ele nunca termine a simulação.
//
// Além disso:
//   - no stage 3, também é criada uma Nota com o detalhamento completo da simulação.
//   - no stage 'interesse', é criada uma Nota curta confirmando que o usuário
//     clicou em "Tenho interesse" depois de ver o resultado.
//
// Requer a variável de ambiente HUBSPOT_TOKEN (Private App Token) configurada
// no projeto Vercel, com os scopes:
//   crm.objects.contacts.read, crm.objects.contacts.write,
//   crm.objects.notes.read, crm.objects.notes.write,
//   analytics.behavioral_events.send
//
// O evento pe50638562_simulador_financiamento e suas propriedades
// (arrecadao_mensal, carencia, cnpj_do_condominio, email, motivo_do_financiamento,
// nome, papel_no_condominio, quantidade_de_unidades, resultados, telefone,
// valor_a_financiar) precisam já existir no HubSpot — esta rota só envia
// ocorrências, não cria a definição do evento.

const EVENT_NAME = 'pe50638562_simulador_financiamento';
const CARENCIA_ENUM = { 30: 'i30_dias', 60: 'i60_dias', 90: 'i90_dias' };
const STATUS_CODE = {
  'Elegível': 'Elegivel',
  'Inelegível': 'Inelegivel',
  'Comitê Investimentos': 'Comite',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado no ambiente da Vercel.' });
    return;
  }

  const hs = async (path, options = {}) => {
    const r = await fetch(`https://api.hubapi.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await r.text();
    const json = text ? JSON.parse(text) : {};
    if (!r.ok) {
      const err = new Error(json.message || `HubSpot API error (${r.status})`);
      err.status = r.status;
      err.body = json;
      throw err;
    }
    return json;
  };

  const fmt = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const pct = (v) => ((Number(v) || 0) * 100).toFixed(2).replace('.', ',') + '%';

  // ---------- Contato ----------
  async function upsertContact(data) {
    const email = (data.email || '').trim();
    if (!email) return null;

    const nomePartes = (data.nome || '').trim().split(/\s+/).filter(Boolean);
    const properties = {
      email,
      firstname: (nomePartes[0] || '').toUpperCase(),
      lastname: nomePartes.slice(1).join(' ').toUpperCase(),
      phone: data.celular || '',
    };

    let contactId = null;
    const search = await hs('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        limit: 1,
      }),
    });
    if (search.results && search.results.length) contactId = search.results[0].id;

    if (contactId) {
      await hs(`/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties }),
      });
    } else {
      const created = await hs('/crm/v3/objects/contacts', {
        method: 'POST',
        body: JSON.stringify({ properties }),
      });
      contactId = created.id;
    }
    return contactId;
  }

  // ---------- Evento personalizado (comportamental) ----------
  // Serializa os 5 prazos calculados em um texto compacto, respeitando o
  // limite de 256 caracteres do HubSpot para propriedades de evento
  // (formato: "12x=1234.56:Elegivel;24x=...;...", ~120 caracteres mesmo em
  // cenários extremos). O detalhamento completo de cada prazo continua
  // disponível na Nota criada no stage 3.
  function serializeResultados(resultados) {
    const str = resultados
      .map((r) => `${r.n}x=${(Number(r.pmt) || 0).toFixed(2)}:${STATUS_CODE[r.status] || r.status}`)
      .join(';');
    return str.length > 256 ? str.slice(0, 256) : str;
  }

  function buildEventProperties(data) {
    const props = {};
    if (data.nome) props.nome = String(data.nome).slice(0, 256);
    if (data.celular) props.telefone = String(data.celular).slice(0, 256);
    if (data.email) props.email = String(data.email).slice(0, 256);
    if (data.papel) props.papel_no_condominio = String(data.papel).slice(0, 256);
    if (data.cnpj) props.cnpj_do_condominio = String(data.cnpj).slice(0, 256);
    if (data.motivo) props.motivo_do_financiamento = String(data.motivo).slice(0, 256);
    if (data.unidades !== undefined && data.unidades !== null && data.unidades !== '') {
      props.quantidade_de_unidades = Number(data.unidades);
    }
    if (data.arrecadacao !== undefined && data.arrecadacao !== null) {
      props.arrecadao_mensal = Number(data.arrecadacao);
    }
    if (data.valor !== undefined && data.valor !== null) {
      props.valor_a_financiar = Number(data.valor);
    }
    if (data.carenciaDias && CARENCIA_ENUM[data.carenciaDias]) {
      props.carencia = CARENCIA_ENUM[data.carenciaDias];
    }
    if (Array.isArray(data.resultados) && data.resultados.length) {
      props.resultados = serializeResultados(data.resultados);
    }
    return props;
  }

  async function sendEvent(data) {
    const email = (data.email || '').trim();
    if (!email) return null;
    return hs('/events/v3/send', {
      method: 'POST',
      body: JSON.stringify({
        eventName: EVENT_NAME,
        email,
        properties: buildEventProperties(data),
      }),
    });
  }

  // ---------- Notas ----------
  async function createNote(noteBody, contactId) {
    const note = await hs('/crm/v3/objects/notes', {
      method: 'POST',
      body: JSON.stringify({
        properties: { hs_note_body: noteBody, hs_timestamp: Date.now() },
      }),
    });
    if (contactId && note.id) {
      await hs(`/crm/v4/objects/notes/${note.id}/associations/default/contacts/${contactId}`, {
        method: 'PUT',
      });
    }
    return note.id;
  }

  // Cor por status, só pra dar destaque visual rápido pro executivo comercial
  // ao abrir a nota (o HubSpot renderiza o HTML da hs_note_body).
  const STATUS_COLOR = {
    'Elegível': '#1b8a4c',
    'Inelegível': '#c0392b',
    'Comitê Investimentos': '#b8860b',
  };

  function tabelaResultados(resultados) {
    const linhas = resultados
      .map((r) => {
        const cor = STATUS_COLOR[r.status] || '#333';
        return `<tr>
          <td style="padding:4px 10px;border:1px solid #ddd;"><strong>${r.n}x</strong></td>
          <td style="padding:4px 10px;border:1px solid #ddd;">${fmt(r.pmt)}</td>
          <td style="padding:4px 10px;border:1px solid #ddd;">${pct(r.cetAM)} a.m.</td>
          <td style="padding:4px 10px;border:1px solid #ddd;">${pct(r.comprometimento, 1)}</td>
          <td style="padding:4px 10px;border:1px solid #ddd;color:${cor};"><strong>${r.status}</strong></td>
        </tr>`;
      })
      .join('');

    return `<table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px;">
      <tr style="background:#f2f2f2;">
        <th style="padding:4px 10px;border:1px solid #ddd;text-align:left;">Prazo</th>
        <th style="padding:4px 10px;border:1px solid #ddd;text-align:left;">Parcela</th>
        <th style="padding:4px 10px;border:1px solid #ddd;text-align:left;">CET</th>
        <th style="padding:4px 10px;border:1px solid #ddd;text-align:left;">Compromete arrecadação</th>
        <th style="padding:4px 10px;border:1px solid #ddd;text-align:left;">Status</th>
      </tr>
      ${linhas}
    </table>`;
  }

  function fullNoteBody(data) {
    const resultados = Array.isArray(data.resultados) ? data.resultados : [];
    const recomendado = resultados.find((r) => r.status === 'Elegível') || null;
    const recomendacaoLinha = recomendado
      ? `<strong>Prazo recomendado (menor prazo elegível):</strong> ${recomendado.n}x — ${fmt(
          recomendado.pmt
        )}/mês<br><br>`
      : `<strong>Nenhum prazo ficou elegível nas condições informadas.</strong><br><br>`;

    return [
      '<strong>Nova simulação — Simulador de Financiamento CondoConta</strong><br><br>',
      `<strong>Responsável:</strong> ${data.nome || '-'} (${data.papel || '-'})<br>`,
      `<strong>Contato:</strong> ${data.celular || '-'} · ${data.email || '-'}<br><br>`,
      `<strong>CNPJ do condomínio:</strong> ${data.cnpj || '-'}<br>`,
      `<strong>Motivo do financiamento:</strong> ${data.motivo || '-'}<br>`,
      `<strong>Unidades:</strong> ${data.unidades ?? '-'}<br><br>`,
      `<strong>Arrecadação mensal:</strong> ${fmt(data.arrecadacao)}<br>`,
      `<strong>Valor a financiar:</strong> ${fmt(data.valor)}<br>`,
      `<strong>Carência:</strong> ${data.carenciaDias || '-'} dias<br><br>`,
      recomendacaoLinha,
      '<strong>Resultado da simulação (todos os prazos):</strong>',
      tabelaResultados(resultados),
    ].join('');
  }

  function interesseNoteBody(data) {
    return [
      '<strong>Usuário confirmou interesse</strong> explicitamente ',
      'ao clicar em "Tenho interesse" após ver o resultado da simulação.<br>',
      `Responsável: ${data.nome || '-'} · ${data.email || '-'} · ${data.celular || '-'}`,
    ].join('');
  }

  // ---------- Fluxo principal ----------
  const data = req.body || {};
  const stage = data.stage;
  const email = (data.email || '').trim();
  const result = { ok: true };

  try {
    if (email) result.contactId = await upsertContact(data);
  } catch (err) {
    console.error('Erro ao criar/atualizar contato no HubSpot:', err.status, err.body || err.message);
    result.contactError = err.message;
  }

  try {
    if (email) {
      await sendEvent(data);
      result.eventSent = true;
    }
  } catch (err) {
    console.error('Erro ao enviar evento para o HubSpot:', err.status, err.body || err.message);
    result.eventError = err.message;
  }

  try {
    if (stage === 3) {
      result.noteId = await createNote(fullNoteBody(data), result.contactId);
    } else if (stage === 'interesse') {
      result.noteId = await createNote(interesseNoteBody(data), result.contactId);
    }
  } catch (err) {
    console.error('Erro ao criar nota no HubSpot:', err.status, err.body || err.message);
    result.noteError = err.message;
  }

  // stage 1 e 2 são só rastreio em segundo plano: o front-end não trata a
  // resposta, então sempre respondemos 200 (o log de erro acima já basta
  // para diagnóstico). Para stage 3 e 'interesse', um erro em contato/nota
  // é reportado ao front, que é quem depende dessa confirmação.
  const criticalFailure = (stage === 3 || stage === 'interesse') && (result.contactError || result.noteError);
  if (criticalFailure) {
    res.status(500).json({ error: result.noteError || result.contactError || 'Erro ao enviar para o HubSpot' });
    return;
  }

  res.status(200).json(result);
}
