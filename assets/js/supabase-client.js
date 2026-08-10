// ============================================================
// CONTA SIM DIGITAL — Cliente Supabase & helpers compartilhados
// ============================================================

const SUPABASE_URL = 'https://arffptuclrrzuzdrcmuc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyZmZwdHVjbHJyenV6ZHJjbXVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3MTcxMDAsImV4cCI6MjEwMTI5MzEwMH0.n3AqYrMwv2ayVa4la6vesVJOfd_LkdmY-ikp8P8uFAg';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Toast simples ----------
function toast(msg, type) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

// ---------- Loading em botão ----------
function setBtnLoading(btn, loading, labelWhenDone) {
  if (loading) {
    btn.dataset.originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  } else {
    btn.disabled = false;
    btn.innerHTML = labelWhenDone || btn.dataset.originalLabel || btn.innerHTML;
  }
}

// ---------- Sessão do consultor/ajudante ----------
async function exigirSessao() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  return session;
}

async function obterPerfil() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;

  let { data: consultor } = await sb.from('csd_consultores').select('*').eq('auth_user_id', session.user.id).maybeSingle();
  if (consultor) return { tipo: 'consultor', ...consultor };

  let { data: ajudante } = await sb.from('csd_ajudantes').select('*').eq('auth_user_id', session.user.id).maybeSingle();
  if (ajudante) return { tipo: 'ajudante', ...ajudante };

  return null;
}

async function sair() {
  await sb.auth.signOut();
  window.location.href = 'index.html';
}

// ---------- Formatação ----------
function formatarCPF(cpf) {
  if (!cpf) return '';
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11) return cpf;
  return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

function apenasDigitos(str) {
  return (str || '').replace(/\D/g, '');
}

function copiarParaAreaTransferencia(texto) {
  navigator.clipboard.writeText(texto).then(() => toast('Copiado!', 'success'));
}
