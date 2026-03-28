const NOTION_API_VERSION = '2022-06-28';

function getPropertyFinder(properties) {
  const entries = Object.entries(properties || {});

  const findProperty = (typeList, preferredNames = [], fallbackMatch = () => false) => {
    const normalizedPreferred = preferredNames.map((name) => name.toLowerCase());

    for (const [name, meta] of entries) {
      if (!typeList.includes(meta.type)) continue;
      if (normalizedPreferred.includes(name.toLowerCase())) {
        return [name, meta];
      }
    }

    for (const [name, meta] of entries) {
      if (!typeList.includes(meta.type)) continue;
      if (fallbackMatch(name.toLowerCase(), meta)) {
        return [name, meta];
      }
    }

    return null;
  };

  return { findProperty, entries };
}

async function getNotionConfig(pool) {
  const [settings] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('notionToken', 'notionDatabaseId')");
  const config = {};
  settings.forEach((s) => {
    config[s.setting_key] = s.setting_value;
  });

  return {
    notionToken: (config.notionToken || '').trim(),
    notionDatabaseId: (config.notionDatabaseId || '').trim()
  };
}

async function getDatabaseInfo(headers, notionDatabaseId) {
  const dbRes = await fetch(`https://api.notion.com/v1/databases/${notionDatabaseId}`, { headers });
  if (!dbRes.ok) {
    const detail = await dbRes.text();
    throw new Error(`No se pudo leer la base de Notion (${dbRes.status}): ${detail}`);
  }
  return dbRes.json();
}

function buildNotionProperties(task, properties) {
  const { findProperty, entries } = getPropertyFinder(properties);

  const titleProp =
    findProperty(['title'], ['Homework Name', 'Nombre Tarea', 'Tarea']) ||
    entries.find(([, value]) => value.type === 'title');

  if (!titleProp) {
    throw new Error('La base de Notion no tiene propiedad de tipo title');
  }

  const [titlePropertyName] = titleProp;
  const notionProperties = {
    [titlePropertyName]: {
      title: [{ type: 'text', text: { content: String(task.title || 'Sin titulo').slice(0, 2000) } }]
    }
  };

  const categoryProp = findProperty(
    ['select', 'multi_select'],
    ['Class', 'Clase', 'Materia', 'Category', 'Categoria', 'Categoría', 'Area', 'Área'],
    (name) =>
      name.includes('class') ||
      name.includes('clase') ||
      name.includes('materia') ||
      name.includes('category') ||
      name.includes('categoria') ||
      name.includes('area')
  );

  if (categoryProp && task.category) {
    const [categoryPropName, categoryPropMeta] = categoryProp;
    const categoryName = String(task.category).slice(0, 100);
    if (categoryPropMeta.type === 'select') {
      notionProperties[categoryPropName] = { select: { name: categoryName } };
    } else {
      notionProperties[categoryPropName] = { multi_select: [{ name: categoryName }] };
    }
  }

  const dueDateProp = findProperty(
    ['date'],
    ['Due Date', 'Fecha Entrega', 'Fecha de Entrega', 'Vence'],
    (name) => name.includes('due') || name.includes('fecha') || name.includes('venc') || name.includes('entrega')
  );

  if (dueDateProp && task.dueDate) {
    const [dueDatePropName] = dueDateProp;
    notionProperties[dueDatePropName] = { date: { start: new Date(task.dueDate).toISOString() } };
  }

  const completedProp = findProperty(
    ['checkbox'],
    ['Completed', 'Completada', 'Done'],
    (name) => name.includes('completed') || name.includes('complet') || name.includes('done')
  );

  if (completedProp) {
    const [completedPropName] = completedProp;
    notionProperties[completedPropName] = { checkbox: Boolean(task.completed) };
  }

  const statusProp = findProperty(
    ['status', 'select'],
    ['Status', 'Estado'],
    (name) => name.includes('status') || name.includes('estado')
  );

  if (statusProp) {
    const [statusPropName, statusMeta] = statusProp;
    const preferredDone = ['done', 'completada', 'complete', 'finalizada', 'listo'];
    const preferredOpen = ['not started', 'to do', 'todo', 'pendiente', 'submit', 'in progress', 'progreso'];

    if (statusMeta.type === 'status' && statusMeta.status && Array.isArray(statusMeta.status.options)) {
      const optionNames = statusMeta.status.options.map((opt) => opt.name);
      const matchSet = task.completed ? preferredDone : preferredOpen;
      let chosenName = optionNames.find((name) => matchSet.some((probe) => name.toLowerCase().includes(probe)));
      if (!chosenName && optionNames.length > 0) {
        chosenName = task.completed ? optionNames[optionNames.length - 1] : optionNames[0];
      }
      if (chosenName) {
        notionProperties[statusPropName] = { status: { name: chosenName } };
      }
    } else if (statusMeta.type === 'select') {
      notionProperties[statusPropName] = { select: { name: task.completed ? 'Done' : 'Not Started' } };
    }
  }

  const notesProp = findProperty(
    ['rich_text'],
    ['Notes / Instructions', 'Notes', 'Instrucciones', 'Descripcion', 'Descripción'],
    (name) =>
      name.includes('note') ||
      name.includes('instruction') ||
      name.includes('instruccion') ||
      name.includes('descripcion')
  );

  if (notesProp && task.description && String(task.description).trim()) {
    const [notesPropName] = notesProp;
    notionProperties[notesPropName] = {
      rich_text: [{
        type: 'text',
        text: { content: String(task.description).slice(0, 2000) }
      }]
    };
  }

  return {
    notionProperties,
    titlePropertyName,
    hasNotesProperty: Boolean(notesProp)
  };
}

async function findNotionPageByTitle(headers, notionDatabaseId, titlePropertyName, title) {
  if (!title) return null;

  const queryRes = await fetch(`https://api.notion.com/v1/databases/${notionDatabaseId}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      page_size: 1,
      filter: {
        property: titlePropertyName,
        title: {
          equals: String(title).slice(0, 2000)
        }
      }
    })
  });

  if (!queryRes.ok) {
    const detail = await queryRes.text();
    throw new Error(`Error consultando pagina en Notion (${queryRes.status}): ${detail}`);
  }

  const queryData = await queryRes.json();
  if (!queryData.results || queryData.results.length === 0) return null;
  return queryData.results[0];
}

async function createNotionPage(headers, notionDatabaseId, notionProperties, task, hasNotesProperty) {
  const payload = {
    parent: { database_id: notionDatabaseId },
    properties: notionProperties
  };

  if (!hasNotesProperty && task.description && String(task.description).trim()) {
    payload.children = [{
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: String(task.description).slice(0, 2000) }
        }]
      }
    }];
  }

  const createRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!createRes.ok) {
    const detail = await createRes.text();
    throw new Error(`Error creando pagina en Notion (${createRes.status}): ${detail}`);
  }

  return createRes.json();
}

async function updateNotionPage(headers, pageId, notionProperties) {
  const updateRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ properties: notionProperties })
  });

  if (!updateRes.ok) {
    const detail = await updateRes.text();
    throw new Error(`Error actualizando pagina en Notion (${updateRes.status}): ${detail}`);
  }

  return updateRes.json();
}

async function syncTaskToNotion(pool, task, options = {}) {
  try {
    const { notionToken, notionDatabaseId } = await getNotionConfig(pool);

    if (!notionToken || !notionDatabaseId) {
      return { synced: false, skipped: true, reason: 'Notion no configurado' };
    }

    const headers = {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json'
    };

    const dbData = await getDatabaseInfo(headers, notionDatabaseId);
    const { notionProperties, titlePropertyName, hasNotesProperty } = buildNotionProperties(task, dbData.properties || {});

    let existingPage = null;
    if (options.upsert !== false) {
      existingPage = await findNotionPageByTitle(headers, notionDatabaseId, titlePropertyName, task.title);
    }

    if (existingPage) {
      const updated = await updateNotionPage(headers, existingPage.id, notionProperties);
      return { synced: true, action: 'updated', notionPageId: updated.id };
    }

    const created = await createNotionPage(headers, notionDatabaseId, notionProperties, task, hasNotesProperty);
    return { synced: true, action: 'created', notionPageId: created.id };
  } catch (e) {
    console.error('Error sincronizando tarea con Notion:', e.message);
    return { synced: false, error: e.message };
  }
}

module.exports = {
  syncTaskToNotion
};
