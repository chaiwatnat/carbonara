import {createWorkbook, readWorkbook} from './workbook.mjs';

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const colors = ['#4F79B8','#31977D','#8B6AB4','#D49B38','#D16970'];
  const browserMode = document.documentElement.dataset.storage === 'browser';
  let state = {layers:[],nodes:[]}, path = '', dirty = false, editing = null, level = 0, connecting = null, dragged = null, savedAt = null, zoom = 1, savedState = '', history = [], language = 'en', viewMode = false;
  const collapsed = new Set();
  const esc = v => String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const get = uid => state.nodes.find(n => n.uid === uid);
  const children = uid => state.nodes.filter(n => n.parent === uid);
  const displayName = n => n ? (language === 'th' ? (n.name_th?.trim() || n.name_en) : (n.name_en?.trim() || n.name_th)) : '';
  const msg = s => { $('status').textContent = s; };
  const nextId = i => String(Math.max(0, ...state.nodes.filter(n => n.level === i && /^\d+$/.test(n.id)).map(n => Number(n.id))) + 1);
  function updateFile() { const date = savedAt ? new Date(savedAt * 1000) : null; const stamp = date && !isNaN(date) ? ` saved ${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}` : ''; $('file').textContent = (path ? path.split(/[\\/]/).pop()+stamp : '') + (dirty ? ' • Unsaved changes' : ''); }
  function mark() { dirty = true; updateFile(); }
  function checkpoint() { history.push(JSON.stringify(state)); if (history.length > 80) history.shift(); $('undo').disabled = false; }
  function resetHistory() { history=[]; $('undo').disabled=true; savedState=JSON.stringify(state); }
  function emptyBoard() {
    return {layers: colors.slice(0, 3).map((color, i) => ({name: `Layer${i + 1}`, color})), nodes: []};
  }
  function loadBoard(board, filename = '', timestamp = null, message = '') {
    state = board;
    path = filename;
    savedAt = timestamp;
    dirty = false;
    collapsed.clear();
    connecting = null;
    resetHistory();
    render();
    fit();
    msg(message);
  }
  function zoomTo(value) { zoom=Math.max(.15,Math.min(1.8,value)); $('stage').style.zoom=zoom; requestAnimationFrame(drawWires); }
  function fit() { $('stage').style.zoom=1; const width=$('board').scrollWidth; zoomTo(Math.min(1,$('workspace').clientWidth / Math.max(1,width))); }
  function confirmDiscard() { return !dirty || confirm('Discard unsaved changes?'); }
  async function api(url, data) {
    const response = await fetch(url, data === undefined ? {cache:'no-store'} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
  }
  function visible(n) {
    const seen = new Set(); let p = n.parent;
    while (p && !seen.has(p)) { if (collapsed.has(p)) return false; seen.add(p); p = get(p)?.parent; }
    return true;
  }
  function render() {
    $('board').innerHTML = state.layers.map((layer, i) => {
      const nodes = state.nodes.filter(n => n.level === i && visible(n));
      const icon = (action, label, content, extra='') => `<button type="button" class="icon-button ${extra}" data-action="${action}" title="${label}" aria-label="${label}">${content}</button>`;
      return `<section class="lane" style="--color:${esc(layer.color)}" data-lane="${i}"><div class="lane-head"><input type="text" maxlength="31" aria-label="Layer ${i+1} name" data-name="${i}" value="${esc(layer.name)}" ${viewMode?'disabled':''}><input type="color" aria-label="Layer ${i+1} color" data-color="${i}" value="${esc(layer.color)}" ${viewMode?'disabled':''}></div><p class="count">Layer ${i+1} · ${state.nodes.filter(n=>n.level===i).length} items</p><div class="cards">${nodes.map(n => {
        const branch = children(n.uid).length ? icon('collapse',collapsed.has(n.uid)?'Expand branch':'Collapse branch',collapsed.has(n.uid)?'▸':'▾','branch-icon') : '';
        const name = displayName(n);
        return `<article class="card ${viewMode?'view-card':''} ${n.active?'':'inactive'} ${connecting===n.uid?'connecting':''}" draggable="${!viewMode}" data-uid="${esc(n.uid)}"><div class="card-title" title="${esc(viewMode ? name : 'Drag to reorder')}"><strong>${esc(name)}</strong><span class="id">#${esc(n.id)}</span>${viewMode?branch:''}</div>${viewMode?'':`<small>${n.parent ? 'Parent: '+esc(displayName(get(n.parent)) || 'Unknown') : (i ? 'Not connected' : 'Top layer')}</small><div class="card-actions">${icon('edit','Edit','✎')}${icon('duplicate','Duplicate','⧉')}${icon('connect',connecting===n.uid?'Cancel connection':'Connect','●','connect-icon')}${n.parent?icon('disconnect','Disconnect','<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.64 18.36 18.36 5.64"/></svg>','disconnect-icon'):''}${icon('delete','Delete box','<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V4h6v2m3 0-1 14H7L6 6m4 4v7m4-7v7"/></svg>','delete-icon')}${branch}</div>`}</article>`;
      }).join('')}</div>${viewMode?'':`<button class="add" data-add="${i}">+ Add item</button>`}</section>`;
    }).join('');
    $('add-layer').disabled = viewMode || state.layers.length >= 5; $('remove-layer').disabled = viewMode || state.layers.length <= 1;
    $('renumber').disabled = viewMode; $('undo').disabled = viewMode || !history.length;
    const branches = state.nodes.filter(n => children(n.uid).length);
    $('toggle-all').textContent = branches.length && branches.every(n => collapsed.has(n.uid)) ? 'Expand all' : 'Collapse all';
    updateFile(); requestAnimationFrame(drawWires);
  }
  function drawWires() {
    const svg = $('wires'), stage = $('stage'), base = stage.getBoundingClientRect();
    svg.setAttribute('width', stage.scrollWidth); svg.setAttribute('height', stage.scrollHeight); svg.replaceChildren();
    const cards = new Map([...document.querySelectorAll('.card')].map(el => [el.dataset.uid,el]));
    for (const child of state.nodes) {
      const a = cards.get(child.parent), b = cards.get(child.uid); if (!a || !b) continue;
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      const x1=(ar.right-base.left)/zoom, y1=(ar.top-base.top+ar.height/2)/zoom, x2=(br.left-base.left)/zoom, y2=(br.top-base.top+br.height/2)/zoom;
      const line = document.createElementNS('http://www.w3.org/2000/svg','path');
      const bend = Math.max(25,(x2-x1)*.45); line.setAttribute('d',`M ${x1} ${y1} C ${x1+bend} ${y1}, ${x2-bend} ${y2}, ${x2} ${y2}`); line.setAttribute('stroke',state.layers[child.level].color); line.classList.add('wire'); svg.append(line);
    }
  }
  function edit(i, uid = null) {
    level = i; editing = uid;
    const n = get(uid) || {id:nextId(i),name_en:'',name_th:'',definition:'',remark:'',active:true,parent:''};
    $('editor-title').textContent = `${uid?'Edit':'Add'} item`; $('layer-label').value=state.layers[i].name; $('item-id').value=n.id;
    $('name-en').value=n.name_en; $('name-th').value=n.name_th; $('definition').value=n.definition; $('remark').value=n.remark; $('active').checked=n.active;
    $('parent-wrap').hidden = i===0;
    $('parent').innerHTML = '<option value="">Not connected</option>' + state.nodes.filter(p=>p.level===i-1).map(p=>`<option value="${esc(p.uid)}">${esc(p.name_en)} (#${esc(p.id)})</option>`).join('');
    $('parent').value=n.parent || ''; $('delete').hidden=!uid; $('editor').showModal();
  }
  function connect(uid) {
    if (!connecting) { connecting=uid; msg('Select Connect on an item in the adjacent layer.'); render(); return; }
    if (connecting===uid) { connecting=null; msg('Connection cancelled.'); render(); return; }
    const a=get(connecting), b=get(uid);
    if (Math.abs(a.level-b.level)!==1) { msg('Connect items in adjacent layers only.'); return; }
    const parent=a.level<b.level?a:b, child=parent===a?b:a;
    checkpoint(); child.parent=parent.uid; collapsed.delete(parent.uid); connecting=null; mark(); render(); msg('Items connected.');
  }
  function reorder(uid, targetUid, after = false) {
    if (uid===targetUid) return;
    const node=get(uid), target=get(targetUid); if (!node || !target || node.level!==target.level) return;
    checkpoint(); state.nodes.splice(state.nodes.indexOf(node),1); state.nodes.splice(state.nodes.indexOf(target)+(after?1:0),0,node); mark(); render();
  }
  function deleteNode(uid) { const n=get(uid); if(!n)return; const count=children(uid).length; if(!confirm(`Delete this box?${count?' Its direct children will be disconnected.':''}`))return; checkpoint(); state.nodes=state.nodes.filter(x=>x.uid!==uid); state.nodes.forEach(x=>{if(x.parent===uid)x.parent='';});collapsed.delete(uid);if(connecting===uid)connecting=null;mark();render(); }
  $('board').addEventListener('click', e => {
    const add=e.target.closest('[data-add]'); if (add) return edit(Number(add.dataset.add));
    const action=e.target.closest('[data-action]'), card=e.target.closest('[data-uid]'); if (!action || !card) return;
    const n=get(card.dataset.uid);
    switch(action.dataset.action) {
      case 'edit': edit(n.level,n.uid); break;
      case 'connect': connect(n.uid); break;
      case 'disconnect': checkpoint(); n.parent=''; mark(); render(); msg('Connection removed.'); break;
      case 'collapse': collapsed.has(n.uid)?collapsed.delete(n.uid):collapsed.add(n.uid); render(); break;
      case 'duplicate': { if(!confirm(`Duplicate "${n.name_en}"? The copy will receive a new ID.`)) break; checkpoint(); const copy={...n,uid:crypto.randomUUID(),id:nextId(n.level)}; state.nodes.splice(state.nodes.indexOf(n)+1,0,copy); mark(); render(); msg('Item duplicated with a new ID.'); break; }
      case 'delete': deleteNode(n.uid); break;
    }
  });
  $('board').addEventListener('dragstart',e=>{ const card=e.target.closest('[data-uid]'); if (!card) return; dragged=card.dataset.uid; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',dragged); card.classList.add('dragging'); });
  $('board').addEventListener('dragover',e=>{ const card=e.target.closest('[data-uid]'); if(card && get(card.dataset.uid)?.level===get(dragged)?.level) { e.preventDefault(); e.dataTransfer.dropEffect='move'; } });
  $('board').addEventListener('drop',e=>{ const card=e.target.closest('[data-uid]'); if(card && dragged) { e.preventDefault(); reorder(dragged,card.dataset.uid,e.clientY > card.getBoundingClientRect().top+card.offsetHeight/2); } dragged=null; });
  $('board').addEventListener('dragend',()=>{ dragged=null; document.querySelectorAll('.dragging').forEach(x=>x.classList.remove('dragging')); });
  $('board').addEventListener('change',e=>{ if(e.target.dataset.name!==undefined){checkpoint();state.layers[+e.target.dataset.name].name=e.target.value.trim();mark();} if(e.target.dataset.color!==undefined){checkpoint();state.layers[+e.target.dataset.color].color=e.target.value;mark();render();} });
  $('add-layer').onclick=()=>{if(state.layers.length<5){checkpoint();let i=state.layers.length;state.layers.push({name:`Layer${i+1}`,color:colors[i]});mark();render();fit();}};
  $('remove-layer').onclick=()=>{let i=state.layers.length-1,count=state.nodes.filter(n=>n.level===i).length;if(i>0&&confirm(`Remove layer "${state.layers[i].name}"${count ? ` and its ${count} item(s)` : ''}?`)){checkpoint();state.nodes=state.nodes.filter(n=>n.level!==i);state.layers.pop();mark();render();fit();}};
  $('toggle-all').onclick=()=>{const branches=state.nodes.filter(n=>children(n.uid).length);if(branches.every(n=>collapsed.has(n.uid)))collapsed.clear();else branches.forEach(n=>collapsed.add(n.uid));render();};
  $('renumber').onclick=()=>{if(!confirm('Renumber all IDs by parent order and box order?'))return;checkpoint();let parents=[];for(let i=0;i<state.layers.length;i++){const order=new Map(parents.map((n,j)=>[n.uid,j]));const nodes=state.nodes.filter(n=>n.level===i);if(i)nodes.sort((a,b)=>(order.get(a.parent)??Infinity)-(order.get(b.parent)??Infinity));nodes.forEach((n,j)=>n.id=String(j+1));state.nodes=state.nodes.filter(n=>n.level!==i).concat(nodes);parents=nodes;}mark();render();msg('IDs renumbered by parent and box order.');};
  $('form').onsubmit=e=>{e.preventDefault();const name=$('name-en').value.trim();if(!name)return;checkpoint();const n={uid:editing||crypto.randomUUID(),level,id:editing?get(editing).id:nextId(level),parent:level?$('parent').value:'',name_en:name,name_th:$('name-th').value.trim(),definition:$('definition').value.trim(),remark:$('remark').value.trim(),active:$('active').checked};if(editing)state.nodes[state.nodes.findIndex(x=>x.uid===editing)]=n;else state.nodes.push(n);$('editor').close();mark();render();msg('');};
  $('delete').onclick=()=>{const uid=editing; $('editor').close(); deleteNode(uid);};
  $('close').onclick=$('cancel').onclick=()=>$('editor').close();
  $('language').onclick=()=>{language=language==='en'?'th':'en';$('language').textContent=`Name: ${language.toUpperCase()}`;render();};
  $('mode').onclick=()=>{viewMode=!viewMode;connecting=null;dragged=null;$('mode').textContent=`Mode: ${viewMode?'View':'Edit'}`;render();};
  $('undo').onclick=()=>{if(!history.length)return;state=JSON.parse(history.pop());dirty=JSON.stringify(state)!==savedState;connecting=null;$('undo').disabled=!history.length;render();msg('Last change undone.');};
  $('zoom-out').onclick=()=>zoomTo(zoom/1.2); $('zoom-in').onclick=()=>zoomTo(zoom*1.2); $('fit').onclick=fit;
  const picker = $('workbook-picker');
  const pickerStatus = $('workbook-picker-status');
  let folder = '', parentFolder = '', pickerBusy = false;

  async function pickWorkbook(url, data, onSuccess) {
    if (pickerBusy) return;
    pickerBusy = true;
    pickerStatus.textContent = 'Loading…';
    try {
      const result = await api(url, data);
      pickerStatus.textContent = '';
      onSuccess(result);
    } catch (error) {
      pickerStatus.textContent = error.message;
    } finally {
      pickerBusy = false;
    }
  }

  function showFolder(nextPath) {
    return pickWorkbook('/api/browse', {path: nextPath}, result => {
      folder = result.path;
      parentFolder = result.parent;
      $('workbook-folder').value = folder;
      $('workbook-parent').disabled = !parentFolder;
      $('workbook-entries').replaceChildren(...result.entries.map(entry => {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.directory ? entry.name + '/' : entry.name;
        button.onclick = () => entry.directory ? showFolder(entry.path) : openWorkbook(entry.path);
        row.append(button);
        return row;
      }));
      if (!result.entries.length) pickerStatus.textContent = 'No folders or .xlsx workbooks here.';
    });
  }

  function openWorkbook(target) {
    if (pickerBusy || !confirmDiscard()) return;
    return pickWorkbook('/api/open', {path: target}, result => {
      loadBoard(result.state, result.path, result.saved_at, 'Hierarchy opened.');
      picker.close();
    });
  }

  function showPicker() {
    picker.showModal();
    showFolder(folder);
  }
  $('close-workbook-picker').onclick = () => { if (!pickerBusy) picker.close(); };
  picker.addEventListener('cancel', event => { if (pickerBusy) event.preventDefault(); });
  $('workbook-folder-form').onsubmit = event => {
    event.preventDefault();
    showFolder($('workbook-folder').value);
  };
  $('workbook-parent').onclick = () => showFolder(parentFolder);
  $('workbook-home').onclick = () => showFolder('');
  function sampleBoard() {
    const sample = emptyBoard();
    ['Topics', 'Subjects', 'Lessons'].forEach((name, index) => { sample.layers[index].name = name; });
    const examples = [
      [0, '1', '', 'Learning library'],
      [1, '1', '0:1', 'Design'],
      [1, '2', '0:1', 'Web development'],
      [2, '1', '1:1', 'Typography'],
      [2, '2', '1:1', 'Color theory'],
      [2, '3', '1:2', 'HTML and CSS'],
      [2, '4', '1:2', 'Accessibility'],
    ];
    sample.nodes = examples.map(([level, id, parent, name_en]) => ({
      uid: `${level}:${id}`, level, id, parent, name_en, name_th: '', definition: '', remark: '', active: true,
    }));
    return sample;
  }

  function downloadWorkbook(board, filename) {
    const xlsx = window.XLSX;
    if (!xlsx) throw new Error('The workbook library did not load. Reload the page and try again.');
    xlsx.writeFileXLSX(createWorkbook(xlsx, board), filename, {compression: true});
  }

  function downloadBoard() {
    const requested = prompt('Name the workbook to download:', path || 'hierarchy.xlsx');
    if (requested === null) return;
    const name = requested.trim().replace(/\.xlsx$/i, '');
    if (!name || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
      msg('Enter a valid workbook filename.');
      return;
    }
    try {
      const filename = name + '.xlsx';
      downloadWorkbook(state, filename);
      path = filename;
      savedAt = null;
      savedState = JSON.stringify(state);
      dirty = false;
      updateFile();
      msg('Workbook download started.');
    } catch (error) {
      msg(error.message);
    }
  }

  function setupBrowserStorage() {
    const input = $('workbook-file');
    const open = $('open');
    open.onclick = () => input.click();
    input.onchange = async () => {
      const [file] = input.files;
      input.value = '';
      if (!file || !confirmDiscard()) return;
      const originalBoard = state;
      const previous = JSON.stringify(state);
      open.disabled = true;
      try {
        if (!/\.xlsx$/i.test(file.name)) throw new Error('Choose an .xlsx workbook.');
        const bytes = await file.arrayBuffer();
        if (state !== originalBoard) return;
        const xlsx = window.XLSX;
        if (!xlsx) throw new Error('The workbook library did not load. Reload the page and try again.');
        const board = readWorkbook(xlsx, bytes);
        if (JSON.stringify(state) !== previous && !confirmDiscard()) return;
        loadBoard(board, file.name, null, 'Hierarchy opened.');
      } catch (error) {
        msg(error.message);
      } finally {
        open.disabled = false;
      }
    };
    $('generate').textContent = 'Download workbook';
    $('generate').onclick = downloadBoard;
    $('template').onclick = () => {
      try {
        downloadWorkbook(emptyBoard(), 'hierarchy_template.xlsx');
      } catch (error) {
        msg(error.message);
      }
    };
    $('sample').hidden = false;
    $('sample').onclick = () => {
      if (confirmDiscard()) loadBoard(sampleBoard(), '', null, 'Sample loaded. Edit it and download your own copy.');
    };
    loadBoard(emptyBoard(), '', null, 'Build a hierarchy or try a sample. Workbooks stay on your device.');
  }

  $('new').onclick = () => {
    if (confirmDiscard()) loadBoard(emptyBoard(), '', null, 'New hierarchy ready.');
  };
  window.addEventListener('resize',drawWires);window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  if (browserMode) {
    setupBrowserStorage();
  } else {
    $('open').onclick = showPicker;
    $('template').onclick = () => window.location.assign('/api/template');
    $('generate').onclick=async()=>{let name='';if(!path){name=prompt('Name the new hierarchy file:');if(name===null)return;}if(!confirm(path?`Save and overwrite ${path.split(/[\\/]/).pop()}?`:`Save a new hierarchy as ${name.trim().replace(/\.xlsx$/i,'')}.xlsx?`))return;const snapshot=JSON.stringify(state);$('generate').disabled=true;try{const r=await api('/api/generate',{new:!path,name,path,state:JSON.parse(snapshot)});path=r.path;savedAt=r.saved_at;savedState=snapshot;dirty=JSON.stringify(state)!==savedState;render();msg(dirty?'Saved; newer changes are not yet saved.':'Hierarchy saved.');}catch(e){msg(e.message);}finally{$('generate').disabled=false;}};
    api('/api/start').then(r => loadBoard(r.state, r.message ? '' : r.path, r.saved_at, r.message)).catch(e => msg(e.message));
  }
})();
