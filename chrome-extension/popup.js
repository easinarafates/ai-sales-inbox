/* AI সেলস ইনবক্স — popup logic (plain JS, no build step).
 * Talks to the API only with a user-pasted API base URL + token stored in
 * chrome.storage.local. No password is ever stored. The extension never
 * posts a message itself — it only copies text for the owner to paste.
 */
'use strict';

const DEFAULTS = {
  apiBase: 'http://localhost:4000',
  dashboardUrl: 'http://localhost:3000',
  token: '',
};

const QUICK_REPLIES = [
  'আসসালামু আলাইকুম! কীভাবে সাহায্য করতে পারি? 😊',
  'জি, প্রোডাক্টটি স্টকে আছে। অর্ডার করতে নাম, ফোন নম্বর আর ঠিকানা দিন।',
  'ঢাকার ভেতরে ডেলিভারি চার্জ ৬০ টাকা, সময় ২-৩ দিন। ঢাকার বাইরে ১২০ টাকা, সময় ৩-৫ দিন।',
  'দাম জানতে প্রোডাক্টের নামটি লিখে পাঠান, আমি দাম আর স্টক জানিয়ে দিচ্ছি।',
  'আপনার অর্ডারটি নিশ্চিত হয়েছে। ধন্যবাদ! ডেলিভারির আগে ফোন করে জানিয়ে দেওয়া হবে।',
  'দুঃখিত, এই প্রোডাক্টটি এখন স্টকে নেই। আসলে জানিয়ে দেব — অন্য কিছু দেখবেন কি?',
];

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let pendingReply = '';

function showStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
}

function taka(paisa) {
  return (Number(paisa) / 100).toLocaleString('bn-BD');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_e) {
    // Clipboard API unavailable (older Chrome) — fallback.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  showStatus('কপি হয়েছে — চ্যাটে বসিয়ে পাঠান।');
}

async function api(path, options) {
  const url = settings.apiBase.replace(/\/+$/, '') + path;
  const res = await fetch(url, {
    ...(options || {}),
    headers: {
      'Content-Type': 'application/json',
      ...(settings.token ? { Authorization: 'Bearer ' + settings.token } : {}),
      ...((options && options.headers) || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch (_e) { /* non-JSON body */ }
  if (!res.ok) {
    const msg = (data && data.error) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

function renderQuickReplies() {
  const list = $('quickReplyList');
  list.innerHTML = '';
  QUICK_REPLIES.forEach((text) => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.textContent = text.length > 42 ? text.slice(0, 42) + '…' : text;
    btn.title = text;
    btn.addEventListener('click', () => {
      pendingReply = text;
      const preview = $('replyPreview');
      preview.textContent = text;
      preview.hidden = false;
      $('copyReply').hidden = false;
    });
    list.appendChild(btn);
  });
}

async function searchProducts() {
  const q = $('productQuery').value.trim();
  const box = $('productResults');
  box.innerHTML = '';
  if (!q) { showStatus('প্রোডাক্টের নাম লিখুন।', true); return; }
  if (!settings.token) { showStatus('আগে সেটিংসে লগইন টোকেন বসান।', true); return; }
  showStatus('খুঁজছি…');
  try {
    const data = await api('/api/products/search?q=' + encodeURIComponent(q));
    const products = data.products || [];
    if (products.length === 0) {
      box.innerHTML = '<p class="hint">কোনো প্রোডাক্ট পাওয়া যায়নি।</p>';
      showStatus('');
      return;
    }
    products.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'item';
      const stock = Number(p.stock) > 0 ? ('স্টক ' + Number(p.stock).toLocaleString('bn-BD') + 'টি') : 'স্টক নেই';
      div.innerHTML = '';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'দাম ৳' + taka(p.price_paisa) + ' • ' + stock;
      div.appendChild(name);
      div.appendChild(meta);
      div.addEventListener('click', () => {
        pendingReply = Number(p.stock) > 0
          ? (p.name + '-এর দাম ৳' + taka(p.price_paisa) + ', স্টক ' + Number(p.stock).toLocaleString('bn-BD') + 'টি আছে। অর্ডার করতে নাম, ফোন নম্বর আর ঠিকানা দিন।')
          : (p.name + ' এখন স্টকে নেই। আসলে জানিয়ে দেব — অন্য কিছু দেখবেন কি?');
        const preview = $('replyPreview');
        preview.textContent = pendingReply;
        preview.hidden = false;
        $('copyReply').hidden = false;
      });
      box.appendChild(div);
    });
    showStatus(products.length + 'টি প্রোডাক্ট পাওয়া গেছে।');
  } catch (err) {
    showStatus('খোঁজা যায়নি: ' + err.message, true);
  }
}

async function loadInbox() {
  const box = $('conversationList');
  box.innerHTML = '';
  if (!settings.token) {
    box.innerHTML = '<p class="hint">চ্যাট দেখতে আগে সেটিংসে লগইন টোকেন বসান।</p>';
    return;
  }
  try {
    const data = await api('/api/inbox?status=open');
    const convs = (data.conversations || []).slice(0, 10);
    if (convs.length === 0) {
      box.innerHTML = '<p class="hint">কোনো খোলা চ্যাট নেই।</p>';
      return;
    }
    convs.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'item';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = c.customer_name || 'কাস্টমার';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (c.mode === 'human' ? 'human' : 'ai');
      badge.textContent = c.mode === 'human' ? 'মানুষ নিয়েছে' : 'AI উত্তর দিচ্ছে';
      name.appendChild(badge);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = (c.channel_name || c.channel || '') + (c.last_message ? (' • ' + c.last_message.slice(0, 60)) : '');
      const actions = document.createElement('div');
      actions.className = 'conv-actions';
      const takeBtn = document.createElement('button');
      takeBtn.className = 'secondary';
      takeBtn.type = 'button';
      takeBtn.textContent = 'আমি নিচ্ছি';
      takeBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await api('/api/inbox/' + c.id + '/takeover', { method: 'POST', body: '{}' });
          showStatus('আপনি চ্যাটটি নিয়েছেন — AI এখন চুপ থাকবে।');
          loadInbox();
        } catch (err) { showStatus('হাতে নেওয়া যায়নি: ' + err.message, true); }
      });
      const returnBtn = document.createElement('button');
      returnBtn.className = 'secondary';
      returnBtn.type = 'button';
      returnBtn.textContent = 'AI-কে ফেরত দিন';
      returnBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await api('/api/inbox/' + c.id + '/return', { method: 'POST', body: '{}' });
          showStatus('AI আবার উত্তর দেবে।');
          loadInbox();
        } catch (err) { showStatus('ফেরত দেওয়া যায়নি: ' + err.message, true); }
      });
      actions.appendChild(takeBtn);
      actions.appendChild(returnBtn);
      div.appendChild(name);
      div.appendChild(meta);
      div.appendChild(actions);
      box.appendChild(div);
    });
  } catch (err) {
    box.innerHTML = '<p class="hint">চ্যাট লোড হয়নি: ' + err.message + '</p>';
  }
}

function loadSettings() {
  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = {
      apiBase: (stored.apiBase || DEFAULTS.apiBase).trim(),
      dashboardUrl: (stored.dashboardUrl || DEFAULTS.dashboardUrl).trim(),
      token: stored.token || '',
    };
    $('apiBase').value = settings.apiBase;
    $('dashboardUrl').value = settings.dashboardUrl;
    // The token value is never shown back — only whether one is saved.
    $('token').value = '';
    $('token').placeholder = settings.token ? 'টোকেন সংরক্ষিত আছে (দেখানো হবে না)' : 'টোকেন বসান — দেখানো হবে না';
    $('tokenStatus').textContent = settings.token ? 'টোকেন সংরক্ষিত আছে।' : 'টোকেন সংরক্ষিত নেই।';
    loadInbox();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderQuickReplies();
  loadSettings();

  $('saveSettings').addEventListener('click', () => {
    const apiBase = $('apiBase').value.trim() || DEFAULTS.apiBase;
    const dashboardUrl = $('dashboardUrl').value.trim() || DEFAULTS.dashboardUrl;
    const token = $('token').value.trim();
    // Empty token field = keep the saved token (we never display it back).
    const next = { apiBase, dashboardUrl, token: token || settings.token };
    chrome.storage.local.set(next, () => {
      settings = next;
      $('token').value = '';
      $('token').placeholder = settings.token ? 'টোকেন সংরক্ষিত আছে (দেখানো হবে না)' : 'টোকেন বসান — দেখানো হবে না';
      $('tokenStatus').textContent = settings.token ? 'টোকেন সংরক্ষিত আছে।' : 'টোকেন সংরক্ষিত নেই।';
      showStatus('সেটিংস সংরক্ষিত হয়েছে।');
      loadInbox();
    });
  });

  $('openDashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: settings.dashboardUrl.replace(/\/+$/, '') + '/inbox' });
  });

  $('searchProducts').addEventListener('click', searchProducts);
  $('productQuery').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') searchProducts();
  });
  $('copyReply').addEventListener('click', () => {
    if (pendingReply) copyText(pendingReply);
  });
  $('refreshInbox').addEventListener('click', loadInbox);
});
