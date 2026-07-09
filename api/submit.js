// Recebe os dados do Simulador de Financiamento e grava no HubSpot:
// 1) cria/atualiza um Contato (por e-mail)
// 2) anexa uma Nota com o detalhamento completo da simulação
//
// Requer a variável de ambiente HUBSPOT_TOKEN (Private App Token) configurada
// no projeto Vercel, com os scopes:
//   crm.objects.contacts.read, crm.objects.contacts.write,
//   crm.objects.notes.read, crm.objects.notes.write

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

  try {
    const data = req.body || {};
    const nomePartes = (data.nome || '').trim().split(/\s+/).filter(Boolean);
    const firstname = (nomePartes[0] || '').toUpperCase();
    const lastname = nomePartes.slice(1).join(' ').toUpperCase();
    const email = (data.email || '').trim();

    const properties = {
      email,
      firstname,
      lastname,
      phone: data.celular || '',
    };

    // 1. Busca contato existente pelo e-mail
    let contactId = null;
    if (email) {
      const search = await hs('/crm/v3/objects/contacts/search', {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
          limit: 1,
        }),
      });
      if (search.results && search.results.length) {
        contactId = search.results[0].id;
      }
    }

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

    // 2. Monta o corpo da nota com o detalhamento da simulação
    const resultados = Array.isArray(data.resultados) ? data.resultados : [];
    const linhasPrazos = resultados
      .map(
        (r) =>
          `${r.n}x — parcela ${fmt(r.pmt)} · CET ${pct(r.cetAM)} a.m. · compromete ${pct(
            r.comprometimento
          )} da arrecadação · ${r.status}`
      )
      .join('<br>');

    const noteBody = [
      '<strong>Nova simulação — Simulador de Financiamento CondoConta</strong><br><br>',
      `<strong>Responsável:</strong> ${data.nome || '-'} (${data.papel || '-'})<br>`,
      `<strong>Contato:</strong> ${data.celular || '-'} · ${email || '-'}<br><br>`,
      `<strong>CNPJ do condomínio:</strong> ${data.cnpj || '-'}<br>`,
      `<strong>Motivo do financiamento:</strong> ${data.motivo || '-'}<br>`,
      `<strong>Unidades:</strong> ${data.unidades ?? '-'}<br>`,
      `<strong>Canal comercial:</strong> ${data.canal || '-'}<br><br>`,
      `<strong>Arrecadação mensal:</strong> ${fmt(data.arrecadacao)}<br>`,
      `<strong>Valor a financiar:</strong> ${fmt(data.valor)}<br>`,
      `<strong>Carência:</strong> ${data.carenciaDias || '-'} dias<br><br>`,
      `<strong>Resultado da simulação:</strong><br>${linhasPrazos}`,
    ].join('');

    const note = await hs('/crm/v3/objects/notes', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          hs_note_body: noteBody,
          hs_timestamp: Date.now(),
        },
      }),
    });

    if (contactId && note.id) {
      await hs(`/crm/v4/objects/notes/${note.id}/associations/default/contacts/${contactId}`, {
        method: 'PUT',
      });
    }

    res.status(200).json({ ok: true, contactId, noteId: note.id });
  } catch (err) {
    console.error('Erro ao enviar para o HubSpot:', err.status, err.body || err.message);
    res.status(500).json({ error: err.message || 'Erro ao enviar para o HubSpot' });
  }
}
