const ITEM_COLUMNS = ['id', 'parent_id', 'name_th', 'name_en', 'definition', 'remark', 'is_active'];
const META = '_hierarchy';
const SUMMARY = 'summary';

function text(value) {
  return String(value ?? '');
}

function validate({layers, nodes}) {
  if (layers.length < 1 || layers.length > 5) {
    throw new Error('A hierarchy must have one to five layers.');
  }
  const layerNames = new Set([META, SUMMARY]);
  for (const {name, color} of layers) {
    if (!name.trim() || name.length > 31 || /[\[\]:*?/\\]/.test(name)) {
      throw new Error('Use valid worksheet names of one to 31 characters for the layers.');
    }
    if (layerNames.has(name.toLowerCase())) {
      throw new Error('Layer names must be unique and cannot use reserved worksheet names.');
    }
    if (!/^#[\da-f]{6}$/i.test(color)) {
      throw new Error('Choose a valid color for each layer.');
    }
    layerNames.add(name.toLowerCase());
  }

  const items = new Map(nodes.map(node => [node.uid, node]));
  const ids = layers.map(() => new Set());
  for (const node of nodes) {
    const layerIds = ids[node.level];
    const id = node.id.trim().toLowerCase();
    if (!layerIds || !id || layerIds.has(id)) {
      throw new Error('Every item needs an ID unique within its layer.');
    }
    if (!node.name_en.trim()) throw new Error('Every item needs an English name.');
    if (node.parent && items.get(node.parent)?.level !== node.level - 1) {
      throw new Error('Each item must have a parent in the preceding layer.');
    }
    if (node.level > 0 && node.active && !node.parent) {
      throw new Error('Connect every active item to a parent in the preceding layer before downloading.');
    }
    layerIds.add(id);
  }
}

export function readWorkbook(xlsx, bytes) {
  const book = xlsx.read(bytes, {type: 'array', cellFormula: false, bookVBA: false});
  if (!book.Sheets[META] || !book.Sheets[SUMMARY]) {
    throw new Error('Choose a Carbonara workbook or start with the downloadable template.');
  }
  const rows = sheet => xlsx.utils.sheet_to_json(sheet, {header: 1, defval: ''});
  const layers = rows(book.Sheets[META]).slice(2).filter(([name]) => name)
    .map(([name, color]) => ({name: text(name), color: text(color)}));
  if (layers.length < 1 || layers.length > 5) {
    throw new Error('A hierarchy must have one to five layers.');
  }

  const nodes = [];
  let parents = new Map();
  for (const [level, layer] of layers.entries()) {
    const sheet = book.Sheets[layer.name];
    if (!sheet) throw new Error(`The ${layer.name} worksheet is missing.`);
    const [header = [], ...entries] = rows(sheet);
    if (!ITEM_COLUMNS.every((name, index) => header[index] === name)) {
      throw new Error(`Invalid columns in ${layer.name}.`);
    }

    const layerItems = new Map();
    for (const [rawId, rawParent, thai, english, definition, remark, active] of entries) {
      if (rawId === '' || rawId == null) continue;
      const id = text(rawId).trim();
      const parentId = text(rawParent).trim();
      const parent = level && parentId ? parents.get(parentId) : '';
      if (parent === undefined) throw new Error(`Parent "${parentId}" for item "${id}" was not found.`);
      const uid = `${level}:${id}`;
      nodes.push({
        uid, level, id, parent, name_th: text(thai), name_en: text(english),
        definition: text(definition), remark: text(remark),
        active: !['0', 'false', 'no'].includes(text(active).trim().toLowerCase()),
      });
      layerItems.set(id, uid);
    }
    parents = layerItems;
  }
  const state = {layers, nodes};
  validate(state);
  return state;
}

export function createWorkbook(xlsx, state) {
  validate(state);
  const {layers, nodes} = state;
  const book = xlsx.utils.book_new();
  function append(name, rows, filter = true) {
    const sheet = xlsx.utils.aoa_to_sheet(rows);
    if (filter) sheet['!autofilter'] = {ref: sheet['!ref']};
    xlsx.utils.book_append_sheet(book, sheet, name);
  }

  const items = new Map(nodes.map(node => [node.uid, node]));
  const children = new Map();
  for (const node of nodes) {
    if (!children.has(node.parent)) children.set(node.parent, []);
    children.get(node.parent).push(node);
  }
  const languages = ['th', 'en'];
  const summary = [['item_id', ...languages.flatMap(lang => layers.map(layer => `${layer.name}_${lang}`))]];
  function visit(node, ancestors) {
    const branch = [...ancestors, node];
    const descendants = children.get(node.uid);
    if (descendants) {
      for (const child of descendants) visit(child, branch);
    } else {
      summary.push([node.id, ...languages.flatMap(lang => layers.map((_, index) => branch[index]?.[`name_${lang}`] ?? ''))]);
    }
  }
  for (const root of children.get('') ?? []) {
    if (root.level === 0) visit(root, []);
  }
  append(SUMMARY, summary);

  for (const [level, layer] of layers.entries()) {
    const rows = nodes.filter(node => node.level === level).map(node => [
      node.id, items.get(node.parent)?.id ?? '', node.name_th, node.name_en,
      node.definition, node.remark, Number(node.active),
    ]);
    append(layer.name, [ITEM_COLUMNS, ...rows]);
  }
  append(META, [['version', 1], ['layer', 'color'], ...layers.map(({name, color}) => [name, color])], false);
  xlsx.utils.book_set_sheet_visibility(book, META, xlsx.utils.consts.SHEET_HIDDEN);
  return book;
}
