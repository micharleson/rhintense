'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const publicSite = $('#publicSite');
const portal = $('#clientPortal');
const authView = $('#authView');
const appView = $('#appView');
const portalView = $('#portalView');
let csrfToken = '';
let currentUser = null;
let currentCompany = null;
let currentPanel = 'overview';
let cachedEmployees = [];
let cachedProcesses = [];
let cachedDeadlines = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function dateLabel(value) {
  if (!value) return 'Sem prazo';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('pt-BR');
}
function feedback(id, message = '', error = false) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message;
  node.dataset.error = error ? 'true' : 'false';
  node.style.color = error ? 'var(--red)' : '';
}
async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (csrfToken && !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(path, {...options, headers, credentials:'same-origin'});
  const contentType = response.headers.get('content-type') || '';
  if (options.download && response.ok) return response.blob();
  const payload = contentType.includes('application/json') ? await response.json() : {};
  if (!response.ok) {
    if (response.status === 401 && currentUser) showAuth('login');
    throw new Error(payload.error || 'Não foi possível concluir a solicitação.');
  }
  return payload;
}
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
function setAuthMode(mode) {
  const registering = mode === 'register';
  $('#loginForm').hidden = registering;
  $('#registerForm').hidden = !registering;
  $('#authTitle').textContent = registering ? 'Cadastrar empresa' : 'Acessar sua conta';
  $('#authDescription').textContent = registering ? 'Crie a área da sua empresa e seu acesso administrador.' : 'Entre para acompanhar as rotinas da sua empresa.';
  $('#authSwitch').innerHTML = registering ? 'Já tem acesso? <button type="button" id="showLogin">Entrar</button>' : 'Primeiro acesso? <button type="button" id="showRegister">Cadastrar empresa</button>';
  feedback('authFeedback');
}
function showAuth(mode = 'login') {
  currentUser = null; currentCompany = null; csrfToken = '';
  appView.hidden = true; authView.hidden = false;
  setAuthMode(mode);
}
function showPortal() {
  publicSite.hidden = true;
  portal.hidden = false;
  window.scrollTo(0, 0);
  document.title = 'Portal do Cliente | RH Intense';
  if (currentUser) showApp();
  else {
    showAuth('login');
    request('/api/auth/me').then(setSession).then(showApp).catch(() => {});
  }
}
function showSite() {
  portal.hidden = true; publicSite.hidden = false;
  window.scrollTo(0, 0);
  document.title = 'RH Intense | Gestão de Pessoas';
}
function setSession(data) {
  csrfToken = data.csrfToken;
  currentUser = data.user;
  currentCompany = data.company;
}
function showApp() {
  if (!currentUser) return showAuth('login');
  authView.hidden = true; appView.hidden = false;
  $('#activeCompany').textContent = currentCompany?.name || '';
  const roleLabel = ({company_admin:'Admin da empresa',manager:'Gestor(a)',staff:'Equipe',viewer:'Consulta'})[currentUser.role] || 'Usuário';
  $('#activeUser').textContent = `${currentUser.name} · ${roleLabel}`;
  renderPanel(currentPanel);
}
function setPanel(name) {
  currentPanel = name;
  $$('.portal-nav [data-panel]').forEach(button => {
    if (button.dataset.panel === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  feedback('portalFeedback');
  renderPanel(name);
}
function pageHead(title, description, action = '') {
  return `<div class="portal-page-head"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action ? `<div class="portal-controls">${action}</div>` : ''}</div>`;
}
function card(title, subtitle, content) {
  return `<article class="portal-card"><div class="card-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div></div>${content}</article>`;
}
function empty(text) { return `<p class="portal-empty">${escapeHtml(text)}</p>`; }
function employeeOptions(selected = '') {
  return '<option value="">Sem vínculo</option>' + cachedEmployees.map(person => `<option value="${escapeHtml(person.id)}" ${selected === person.id ? 'selected' : ''}>${escapeHtml(person.name)}</option>`).join('');
}
function processOptions(selected = '') {
  return '<option value="">Sem vínculo</option>' + cachedProcesses.map(process => `<option value="${escapeHtml(process.id)}" ${selected === process.id ? 'selected' : ''}>${escapeHtml(process.title)}</option>`).join('');
}
function statusBadge(status) {
  const cls = status === 'Concluído' || status === 'Ativo' ? 'badge-teal' : status === 'Aguardando retorno' || status === 'Pendente' ? 'badge-amber' : 'badge-purple';
  return `<span class="badge ${cls}">${escapeHtml(status || '—')}</span>`;
}
function employeeForm() {
  return `<form class="portal-card portal-data-form" id="employeeForm"><div class="card-head"><div><h2>Novo funcionário</h2><p>Cadastre os dados profissionais necessários para a gestão da equipe.</p></div></div><div class="form-grid">
    <div class="field"><label for="empName">Nome *</label><input id="empName" name="name" maxlength="120" required /></div>
    <div class="field"><label for="empEmail">E-mail profissional</label><input id="empEmail" name="email" type="email" /></div>
    <div class="field"><label for="empDepartment">Área</label><input id="empDepartment" name="department" maxlength="100" /></div>
    <div class="field"><label for="empJob">Cargo</label><input id="empJob" name="jobTitle" maxlength="100" /></div>
    <div class="field"><label for="empStatus">Situação</label><select id="empStatus" name="status"><option>Ativo</option><option>Inativo</option><option>Afastado</option></select></div>
    <div class="field"><label for="empHireDate">Data de admissão</label><input id="empHireDate" name="hireDate" type="date" /></div></div><button class="btn btn-small" type="submit">Salvar funcionário</button><p class="inline-feedback" id="employeeFeedback" role="status"></p></form>`;
}
function processForm() {
  return `<form class="portal-card portal-data-form" id="processForm"><div class="card-head"><div><h2>Novo processo</h2><p>Registre o andamento, responsável e próxima ação.</p></div></div><div class="form-grid">
    <div class="field"><label for="procTitle">Processo *</label><input id="procTitle" name="title" maxlength="180" required /></div>
    <div class="field"><label for="procArea">Área</label><input id="procArea" name="area" maxlength="100" /></div>
    <div class="field"><label for="procAction">Próxima ação</label><input id="procAction" name="nextAction" maxlength="500" /></div>
    <div class="field"><label for="procStatus">Status</label><select id="procStatus" name="status"><option>A iniciar</option><option>Em andamento</option><option>Aguardando retorno</option><option>Concluído</option><option>Cancelado</option></select></div>
    <div class="field"><label for="procDueDate">Prazo</label><input id="procDueDate" name="dueDate" type="date" /></div>
    <div class="field"><label for="procEmployee">Funcionário relacionado</label><select id="procEmployee" name="employeeId">${employeeOptions()}</select></div></div><button class="btn btn-small" type="submit">Salvar processo</button><p class="inline-feedback" id="processFeedback" role="status"></p></form>`;
}
function deadlineForm() {
  return `<form class="portal-card portal-data-form" id="deadlineForm"><div class="card-head"><div><h2>Novo prazo</h2><p>Organize compromissos e datas importantes da equipe.</p></div></div><div class="form-grid">
    <div class="field"><label for="deadlineTitle">Prazo *</label><input id="deadlineTitle" name="title" maxlength="180" required /></div>
    <div class="field"><label for="deadlineDate">Data *</label><input id="deadlineDate" name="dueDate" type="date" required /></div>
    <div class="field"><label for="deadlineStatus">Status</label><select id="deadlineStatus" name="status"><option>Pendente</option><option>Concluído</option><option>Cancelado</option></select></div>
    <div class="field"><label for="deadlineEmployee">Funcionário relacionado</label><select id="deadlineEmployee" name="employeeId">${employeeOptions()}</select></div>
    <div class="field"><label for="deadlineProcess">Processo relacionado</label><select id="deadlineProcess" name="processId">${processOptions()}</select></div>
    <div class="field wide"><label for="deadlineDescription">Observação</label><textarea id="deadlineDescription" name="description" rows="2" maxlength="1000"></textarea></div></div><button class="btn btn-small" type="submit">Salvar prazo</button><p class="inline-feedback" id="deadlineFeedback" role="status"></p></form>`;
}
async function renderPanel(name) {
  if (!currentUser) return;
  try {
    if (name === 'overview') {
      const [employees, processes, deadlines, documents, forms] = await Promise.all([
        request('/api/employees'), request('/api/processes'), request('/api/deadlines'), request('/api/documents'), request('/api/forms')
      ]);
      cachedEmployees = employees; cachedProcesses = processes;
      cachedEmployees=employees; cachedProcesses=processes; cachedDeadlines=deadlines;
      const upcoming = deadlines.filter(item => item.status === 'Pendente').slice(0, 5);
      const upcomingContent = upcoming.length ? `<div class="data-list">${upcoming.map(item => `<div class="data-row"><div><h3>${escapeHtml(item.title)}</h3><p>${dateLabel(item.dueDate)}${item.description ? ` · ${escapeHtml(item.description)}` : ''}</p></div>${statusBadge(item.status)}</div>`).join('')}</div>` : empty('Não há prazos pendentes cadastrados.');
      portalView.innerHTML = pageHead('Visão geral', `Bem-vinda(o), ${currentUser.name}. Acompanhe os registros da sua empresa.`) +
        `<div class="portal-overview-grid"><article class="portal-stat"><span>Funcionários</span><strong>${employees.length}</strong></article><article class="portal-stat"><span>Processos</span><strong>${processes.length}</strong></article><article class="portal-stat"><span>Prazos pendentes</span><strong>${deadlines.filter(x=>x.status==='Pendente').length}</strong></article><article class="portal-stat"><span>Documentos</span><strong>${documents.length}</strong></article><article class="portal-stat"><span>Formulários</span><strong>${forms.length}</strong></article></div>` + card('Próximos prazos', 'Datas cadastradas para acompanhamento.', upcomingContent);
      return;
    }
    if (name === 'team') {
      const people = await request('/api/employees'); cachedEmployees = people;
      const rows = people.length ? people.map(person => `<tr><td data-label="Nome">${escapeHtml(person.name)}</td><td data-label="Área">${escapeHtml(person.department || '—')}</td><td data-label="Cargo">${escapeHtml(person.jobTitle || '—')}</td><td data-label="Situação">${statusBadge(person.status)}</td><td data-label="Ação"><div class="data-row-actions"><button class="btn btn-secondary btn-small small-button" type="button" data-edit-type="employee" data-id="${escapeHtml(person.id)}">Editar</button><button class="btn btn-secondary btn-small small-button" type="button" data-delete-type="employee" data-id="${escapeHtml(person.id)}">Excluir</button></div></td></tr>`).join('') : '';
      portalView.innerHTML = pageHead('Funcionários', 'Cadastro profissional e situação da equipe.') + employeeForm() + card('Equipe cadastrada', `${people.length} registro(s).`, rows ? `<div class="portal-table-wrap"><table class="portal-table"><thead><tr><th>Nome</th><th>Área</th><th>Cargo</th><th>Situação</th><th>Ação</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('Ainda não há funcionários cadastrados.'));
      return;
    }
    if (name === 'processes') {
      const [processes, employees] = await Promise.all([request('/api/processes'),request('/api/employees')]); cachedProcesses=processes; cachedEmployees=employees;
      const rows = processes.length ? processes.map(item=>`<tr><td data-label="Processo">${escapeHtml(item.title)}</td><td data-label="Área">${escapeHtml(item.area||'—')}</td><td data-label="Próxima ação">${escapeHtml(item.nextAction||'—')}</td><td data-label="Prazo">${dateLabel(item.dueDate)}</td><td data-label="Status">${statusBadge(item.status)}</td><td data-label="Ação"><div class="data-row-actions"><button class="btn btn-secondary btn-small small-button" type="button" data-edit-type="process" data-id="${escapeHtml(item.id)}">Editar</button><button class="btn btn-secondary btn-small small-button" type="button" data-delete-type="process" data-id="${escapeHtml(item.id)}">Excluir</button></div></td></tr>`).join('') : '';
      portalView.innerHTML=pageHead('Processos', 'Acompanhe responsáveis, próximas ações, status e prazos.')+processForm()+card('Processos registrados',`${processes.length} registro(s).`,rows?`<div class="portal-table-wrap"><table class="portal-table"><thead><tr><th>Processo</th><th>Área</th><th>Próxima ação</th><th>Prazo</th><th>Status</th><th>Ação</th></tr></thead><tbody>${rows}</tbody></table></div>`:empty('Ainda não há processos cadastrados.'));
      return;
    }
    if (name === 'deadlines') {
      const [deadlines,employees,processes]=await Promise.all([request('/api/deadlines'),request('/api/employees'),request('/api/processes')]); cachedDeadlines=deadlines; cachedEmployees=employees; cachedProcesses=processes;
      const rows=deadlines.length?deadlines.map(item=>`<div class="data-row"><div><h3>${escapeHtml(item.title)}</h3><p>Data: ${dateLabel(item.dueDate)}${item.description?` · ${escapeHtml(item.description)}`:''}</p></div><div class="data-row-actions">${statusBadge(item.status)}<button class="btn btn-secondary btn-small small-button" type="button" data-edit-type="deadline" data-id="${escapeHtml(item.id)}">Editar</button><button class="btn btn-secondary btn-small small-button" type="button" data-delete-type="deadline" data-id="${escapeHtml(item.id)}">Excluir</button></div></div>`).join(''):empty('Ainda não há prazos cadastrados.');
      portalView.innerHTML=pageHead('Prazos', 'Organize datas, responsáveis e pendências.')+deadlineForm()+card('Agenda de prazos',`${deadlines.length} registro(s).`,`<div class="data-list">${rows}</div>`);
      return;
    }
    if (name === 'documents') {
      const [documents,employees]=await Promise.all([request('/api/documents'),request('/api/employees')]); cachedEmployees=employees;
      const rows=documents.length?documents.map(item=>`<div class="data-row"><div><h3>${escapeHtml(item.name)}</h3><p>${(item.sizeBytes/1024).toFixed(1)} KB · ${dateLabel(item.createdAt.slice(0,10))}</p></div><div class="data-row-actions"><button class="btn btn-secondary btn-small small-button" type="button" data-download-id="${escapeHtml(item.id)}">Baixar</button><button class="btn btn-secondary btn-small small-button" type="button" data-delete-type="document" data-id="${escapeHtml(item.id)}">Excluir</button></div></div>`).join(''):empty('Ainda não há documentos enviados.');
      portalView.innerHTML=pageHead('Documentos', 'Armazene e consulte arquivos da empresa com acesso autenticado.')+`<form class="portal-card portal-data-form" id="documentForm"><div class="card-head"><div><h2>Enviar documento</h2><p>Arquivos de até 10 MB. O download exige acesso ao portal.</p></div></div><div class="form-grid"><div class="field"><label for="documentFile">Arquivo *</label><input id="documentFile" name="file" type="file" required /></div><div class="field"><label for="documentEmployee">Funcionário relacionado</label><select id="documentEmployee" name="employeeId">${employeeOptions()}</select></div></div><button class="btn btn-small" type="submit">Enviar arquivo</button><p class="inline-feedback" id="documentFeedback" role="status"></p></form>`+card('Arquivos',`${documents.length} documento(s).`,`<div class="data-list">${rows}</div>`);
      return;
    }
    if (name === 'forms') {
      const forms=await request('/api/forms');
      const list=forms.length?forms.map(item=>`<article class="portal-card"><div class="card-head"><div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description||'')}</p></div><button class="btn btn-secondary btn-small small-button" type="button" data-submissions-id="${escapeHtml(item.id)}">Ver respostas</button></div><div class="portal-form-list"><form data-submit-form="${escapeHtml(item.id)}"><h3>Enviar resposta</h3>${item.fields.map((field,index)=>`<div class="field"><label for="form-${escapeHtml(item.id)}-${index}">${escapeHtml(field.label)}${field.required?' *':''}</label>${field.type==='textarea'?`<textarea id="form-${escapeHtml(item.id)}-${index}" name="${escapeHtml(field.label)}" rows="3" ${field.required?'required':''}></textarea>`:`<input id="form-${escapeHtml(item.id)}-${index}" name="${escapeHtml(field.label)}" type="${escapeHtml(field.type)}" ${field.required?'required':''} />`}</div>`).join('')}<button class="btn btn-small" type="submit">Enviar resposta</button><p class="inline-feedback" data-form-feedback="${escapeHtml(item.id)}" role="status"></p></form></div></article>`).join(''):empty('Ainda não há formulários. Crie o primeiro para registrar solicitações ou respostas.');
      portalView.innerHTML=pageHead('Formulários', 'Crie formulários internos e registre respostas.')+`<form class="portal-card portal-data-form" id="formTemplateForm"><div class="card-head"><div><h2>Novo formulário</h2><p>Informe um campo por linha. Os campos são obrigatórios por padrão.</p></div></div><div class="form-grid"><div class="field"><label for="formTitle">Título *</label><input id="formTitle" name="title" maxlength="140" required /></div><div class="field"><label for="formDescription">Descrição</label><input id="formDescription" name="description" maxlength="500" /></div><div class="field wide"><label for="formFields">Campos *</label><textarea id="formFields" name="fields" rows="4" placeholder="Ex.: Solicitação\nData desejada\nObservações" required></textarea></div></div><button class="btn btn-small" type="submit">Criar formulário</button><p class="inline-feedback" id="formTemplateFeedback" role="status"></p></form><div class="portal-form-list">${list}</div>`;
      return;
    }
    if (name === 'company') {
      const company=await request('/api/companies'); currentCompany=company; $('#activeCompany').textContent=company.name;
      portalView.innerHTML=pageHead('Empresa', 'Atualize os dados básicos da organização.')+`<form class="portal-card portal-data-form" id="companyForm"><div class="form-grid"><div class="field wide"><label for="companyName">Nome da empresa</label><input id="companyName" name="name" value="${escapeHtml(company.name)}" maxlength="140" required /></div></div><button class="btn btn-small" type="submit">Salvar alterações</button><p class="inline-feedback" id="companyFeedback" role="status"></p></form>`;
      return;
    }
  } catch (error) {
    portalView.innerHTML=`<div class="portal-card"><h2>Não foi possível carregar esta área</h2><p>${escapeHtml(error.message)}</p><button class="btn btn-secondary btn-small" type="button" id="retryPanel">Tentar novamente</button></div>`;
  }
}

function editField(label, name, value, {type='text', options=null, wide=false, required=false, rows=0}={}) {
  const id=`edit-${name}`; const className=wide?'field wide':'field';
  let control;
  if(options) control=`<select id="${id}" name="${name}">${options.map(option=>`<option value="${escapeHtml(option)}" ${value===option?'selected':''}>${escapeHtml(option)}</option>`).join('')}</select>`;
  else if(rows) control=`<textarea id="${id}" name="${name}" rows="${rows}" ${required?'required':''}>${escapeHtml(value)}</textarea>`;
  else control=`<input id="${id}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${required?'required':''} />`;
  return `<div class="${className}"><label for="${id}">${escapeHtml(label)}${required?' *':''}</label>${control}</div>`;
}
function openEditDialog(type,id) {
  const collections={employee:cachedEmployees,process:cachedProcesses,deadline:cachedDeadlines};
  const item=collections[type]?.find(record=>record.id===id); if(!item)return;
  let fields='';
  if(type==='employee') fields=editField('Nome','name',item.name,{required:true})+editField('E-mail','email',item.email,{type:'email'})+editField('Área','department',item.department)+editField('Cargo','jobTitle',item.jobTitle)+editField('Situação','status',item.status,{options:['Ativo','Inativo','Afastado']})+editField('Data de admissão','hireDate',item.hireDate,{type:'date'});
  if(type==='process') fields=editField('Processo','title',item.title,{required:true})+editField('Área','area',item.area)+editField('Próxima ação','nextAction',item.nextAction)+editField('Status','status',item.status,{options:['A iniciar','Em andamento','Aguardando retorno','Concluído','Cancelado']})+editField('Prazo','dueDate',item.dueDate,{type:'date'})+editField('Funcionário','employeeId',item.employeeId||'',{options:[{id:'',name:'Sem vínculo'},...cachedEmployees.map(person=>({id:person.id,name:person.name}))].map(x=>x.id)});
  if(type==='deadline') fields=editField('Prazo','title',item.title,{required:true})+editField('Data','dueDate',item.dueDate,{type:'date',required:true})+editField('Status','status',item.status,{options:['Pendente','Concluído','Cancelado']})+editField('Funcionário','employeeId',item.employeeId||'',{options:['',...cachedEmployees.map(person=>person.id)]})+editField('Processo','processId',item.processId||'',{options:['',...cachedProcesses.map(process=>process.id)]})+editField('Observação','description',item.description,{wide:true,rows:3});
  const namedSelects=$$('#editRecordFields select');
  $('#editRecordFields').innerHTML=fields;
  // Replace opaque IDs with accessible names in relationship selectors.
  if(type==='process') { const select=$('#edit-employeeId'); select.innerHTML='<option value="">Sem vínculo</option>'+cachedEmployees.map(person=>`<option value="${escapeHtml(person.id)}" ${item.employeeId===person.id?'selected':''}>${escapeHtml(person.name)}</option>`).join(''); }
  if(type==='deadline') {
    const employee=$('#edit-employeeId'); employee.innerHTML='<option value="">Sem vínculo</option>'+cachedEmployees.map(person=>`<option value="${escapeHtml(person.id)}" ${item.employeeId===person.id?'selected':''}>${escapeHtml(person.name)}</option>`).join('');
    const process=$('#edit-processId'); process.innerHTML='<option value="">Sem vínculo</option>'+cachedProcesses.map(row=>`<option value="${escapeHtml(row.id)}" ${item.processId===row.id?'selected':''}>${escapeHtml(row.title)}</option>`).join('');
  }
  $('#editDialogTitle').textContent=`Editar ${type==='employee'?'funcionário':type==='process'?'processo':'prazo'}`;
  $('#editDialog').dataset.entityType=type; $('#editDialog').dataset.entityId=id; feedback('editRecordFeedback');
  $('#editDialog').showModal();
}
async function handleLogin(form, register = false) {
  const targetFeedback = register ? 'registerFeedback' : 'loginFeedback';
  feedback(targetFeedback, 'Conectando…');
  try {
    const data = await request(register ? '/api/auth/register' : '/api/auth/login', {method:'POST', body:JSON.stringify(formData(form))});
    setSession(data); showApp();
  } catch (error) { feedback(targetFeedback,error.message,true); }
}
function readFileBase64(file) {
  return file.arrayBuffer().then(buffer=>{
    const bytes=new Uint8Array(buffer); let binary=''; const chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
    return btoa(binary);
  });
}

$('#loginForm').addEventListener('submit', event=>{event.preventDefault();handleLogin(event.currentTarget,false);});
$('#registerForm').addEventListener('submit', event=>{event.preventDefault();handleLogin(event.currentTarget,true);});
$('#authSwitch').addEventListener('click',event=>{if(event.target.id==='showRegister')setAuthMode('register');if(event.target.id==='showLogin')setAuthMode('login');});
$('#contactForm').addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.currentTarget; const feedbackNode=$('#contactFeedback'); feedbackNode.textContent='Enviando…';
  try{const result=await request('/api/contact',{method:'POST',body:JSON.stringify(formData(form))});feedbackNode.textContent=result.message;form.reset();}
  catch(error){feedbackNode.textContent=error.message;feedbackNode.style.color='var(--red)';}
});
$$('[data-open-portal]').forEach(button=>button.addEventListener('click',showPortal));
$$('[data-back-site]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();showSite();}));
$$('.portal-nav [data-panel]').forEach(button=>button.addEventListener('click',()=>setPanel(button.dataset.panel)));
$('#logoutButton').addEventListener('click',async()=>{try{await request('/api/auth/logout',{method:'POST',body:'{}'});}catch{}showAuth('login');});
$('#portalView').addEventListener('click',async event=>{
  const retry=event.target.closest('#retryPanel'); if(retry)return renderPanel(currentPanel);
  const edit=event.target.closest('[data-edit-type]'); if(edit){openEditDialog(edit.dataset.editType,edit.dataset.id);return;}
  const del=event.target.closest('[data-delete-type]');
  if(del){
    const labels={employee:'funcionário',process:'processo',deadline:'prazo',document:'documento'};
    if(!confirm(`Excluir este ${labels[del.dataset.deleteType]}?`))return;
    try{await request(`/api/${del.dataset.deleteType==='employee'?'employees':del.dataset.deleteType==='process'?'processes':del.dataset.deleteType==='deadline'?'deadlines':'documents'}/${encodeURIComponent(del.dataset.id)}`,{method:'DELETE',body:'{}'});await renderPanel(currentPanel);}
    catch(error){feedback('portalFeedback',error.message,true);} return;
  }
  const download=event.target.closest('[data-download-id]');
  if(download){
    try{const blob=await request(`/api/documents/${encodeURIComponent(download.dataset.downloadId)}/download`,{download:true});const objectUrl=URL.createObjectURL(blob);const link=document.createElement('a');link.href=objectUrl;link.download='documento';link.click();URL.revokeObjectURL(objectUrl);}
    catch(error){feedback('portalFeedback',error.message,true);} return;
  }
  const submissions=event.target.closest('[data-submissions-id]');
  if(submissions){
    try{const rows=await request(`/api/forms/${encodeURIComponent(submissions.dataset.submissionsId)}/submissions`);const summary=rows.length?rows.map(row=>Object.entries(row.answers).map(([key,value])=>`${key}: ${value}`).join('\n')).join('\n\n---\n\n'):'Ainda não há respostas.';alert(summary);}
    catch(error){feedback('portalFeedback',error.message,true);}
  }
});
$('#portalView').addEventListener('submit',async event=>{
  const form=event.target; event.preventDefault();
  try{
    if(form.id==='employeeForm'){
      const data=formData(form); await request('/api/employees',{method:'POST',body:JSON.stringify(data)}); await renderPanel('team'); feedback('portalFeedback','Funcionário cadastrado.');
    } else if(form.id==='processForm'){
      const data=formData(form); await request('/api/processes',{method:'POST',body:JSON.stringify(data)}); await renderPanel('processes'); feedback('portalFeedback','Processo cadastrado.');
    } else if(form.id==='deadlineForm'){
      const data=formData(form); await request('/api/deadlines',{method:'POST',body:JSON.stringify(data)}); await renderPanel('deadlines'); feedback('portalFeedback','Prazo cadastrado.');
    } else if(form.id==='documentForm'){
      const file=$('#documentFile').files[0]; if(!file)throw new Error('Selecione um arquivo.'); if(file.size>10*1024*1024)throw new Error('O arquivo deve ter até 10 MB.');
      const contentBase64=await readFileBase64(file); const employeeId=formData(form).employeeId;
      await request('/api/documents',{method:'POST',body:JSON.stringify({name:file.name,mimeType:file.type||'application/octet-stream',contentBase64,employeeId})}); await renderPanel('documents'); feedback('portalFeedback','Documento enviado.');
    } else if(form.id==='formTemplateForm'){
      const data=formData(form); const fields=data.fields.split(/\r?\n/).map(label=>label.trim()).filter(Boolean).map(label=>({label,type:'text',required:true}));
      await request('/api/forms',{method:'POST',body:JSON.stringify({title:data.title,description:data.description,fields})}); await renderPanel('forms'); feedback('portalFeedback','Formulário criado.');
    } else if(form.dataset.submitForm){
      const answers=formData(form); await request(`/api/forms/${encodeURIComponent(form.dataset.submitForm)}/submissions`,{method:'POST',body:JSON.stringify({answers})}); await renderPanel('forms'); feedback('portalFeedback','Resposta registrada.');
    } else if(form.id==='companyForm'){
      const company=await request('/api/companies',{method:'PATCH',body:JSON.stringify(formData(form))}); currentCompany=company;$('#activeCompany').textContent=company.name;feedback('companyFeedback','Dados da empresa atualizados.');
    }
  } catch(error){
    const feedbackTarget={employeeForm:'employeeFeedback',processForm:'processFeedback',deadlineForm:'deadlineFeedback',documentForm:'documentFeedback',formTemplateForm:'formTemplateFeedback',companyForm:'companyFeedback'}[form.id] || form.querySelector('.inline-feedback')?.id;
    if(feedbackTarget) feedback(feedbackTarget,error.message,true); else feedback('portalFeedback',error.message,true);
  }
});

$('#closeEditDialog').addEventListener('click',()=>$('#editDialog').close());
$('#cancelEdit').addEventListener('click',()=>$('#editDialog').close());
$('#editRecordForm').addEventListener('submit',async event=>{
  event.preventDefault(); const dialog=$('#editDialog'); const type=dialog.dataset.entityType; const id=dialog.dataset.entityId;
  const endpoint=type==='employee'?'employees':type==='process'?'processes':'deadlines';
  try{await request(`/api/${endpoint}/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(formData(event.currentTarget))});dialog.close();await renderPanel(currentPanel);feedback('portalFeedback','Alterações salvas.');}
  catch(error){feedback('editRecordFeedback',error.message,true);}
});
$('#editDialog').addEventListener('click',event=>{if(event.target===$('#editDialog'))$('#editDialog').close();});

const menuToggle=$('#menuToggle'); const mainNav=$('#mainNav');
menuToggle.addEventListener('click',()=>{const opened=mainNav.classList.toggle('open');menuToggle.setAttribute('aria-expanded',String(opened));menuToggle.setAttribute('aria-label',opened?'Fechar menu':'Abrir menu');});
mainNav.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>{mainNav.classList.remove('open');menuToggle.setAttribute('aria-expanded','false');}));
$('#year').textContent=new Date().getFullYear();
if(new URLSearchParams(location.search).get('portal')==='1')showPortal();
