/* AI সেলস ইনবক্স — content script (plain JS, no build step).
 * Runs only on facebook.com / messenger.com / business.facebook.com.
 * Adds a small helper panel: quick-reply chips (copy on click) + a link
 * back to the dashboard. It NEVER posts a message itself, never reads the
 * page's chat content, and never touches passwords or login tokens — it
 * only reads the dashboard URL from chrome.storage.local.
 */
(function () {
  'use strict';
  if (window.__aiInboxPanelInjected) return;
  window.__aiInboxPanelInjected = true;

  var QUICK_REPLIES = [
    'আসসালামু আলাইকুম! কীভাবে সাহায্য করতে পারি? 😊',
    'জি, প্রোডাক্টটি স্টকে আছে। অর্ডার করতে নাম, ফোন নম্বর আর ঠিকানা দিন।',
    'ঢাকার ভেতরে ডেলিভারি চার্জ ৬০ টাকা, সময় ২-৩ দিন। ঢাকার বাইরে ১২০ টাকা, সময় ৩-৫ দিন।',
    'আপনার অর্ডারটি নিশ্চিত হয়েছে। ধন্যবাদ!',
  ];

  var dashboardUrl = 'http://localhost:3000';
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ dashboardUrl: dashboardUrl }, function (stored) {
        if (stored && stored.dashboardUrl) dashboardUrl = stored.dashboardUrl;
        var link = document.getElementById('ai-inbox-dashboard-link');
        if (link) link.href = String(dashboardUrl).replace(/\/+$/, '') + '/inbox';
      });
    }
  } catch (_e) { /* storage unavailable — default link stays */ }

  function copyText(text, noteEl) {
    function done() {
      if (noteEl) {
        noteEl.textContent = 'কপি হয়েছে — চ্যাটে বসিয়ে পাঠান।';
        setTimeout(function () { noteEl.textContent = 'এই এক্সটেনশন নিজে মেসেজ পাঠায় না — লেখা কপি করে চ্যাটে বসান।'; }, 2500);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_e) { /* ignore */ }
    ta.remove();
  }

  function buildPanel() {
    var panel = document.createElement('div');
    panel.id = 'ai-inbox-helper-panel';

    var header = document.createElement('div');
    header.className = 'ai-inbox-header';
    header.textContent = '🛍️ AI সেলস ইনবক্স';

    var toggle = document.createElement('button');
    toggle.className = 'ai-inbox-toggle';
    toggle.type = 'button';
    toggle.textContent = '—';
    toggle.title = 'ছোট/বড় করুন';
    header.appendChild(toggle);

    var body = document.createElement('div');
    body.className = 'ai-inbox-body';

    var link = document.createElement('a');
    link.id = 'ai-inbox-dashboard-link';
    link.href = dashboardUrl.replace(/\/+$/, '') + '/inbox';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'ড্যাশবোর্ড খুলুন (ইনবক্স)';
    body.appendChild(link);

    var chips = document.createElement('div');
    chips.className = 'ai-inbox-chips';
    QUICK_REPLIES.forEach(function (text) {
      var chip = document.createElement('button');
      chip.className = 'ai-inbox-chip';
      chip.type = 'button';
      chip.textContent = text.length > 40 ? text.slice(0, 40) + '…' : text;
      chip.title = text;
      chip.addEventListener('click', function () { copyText(text, note); });
      chips.appendChild(chip);
    });
    body.appendChild(chips);

    var note = document.createElement('p');
    note.className = 'ai-inbox-note';
    note.textContent = 'এই এক্সটেনশন নিজে মেসেজ পাঠায় না — লেখা কপি করে চ্যাটে বসান।';
    body.appendChild(note);

    panel.appendChild(header);
    panel.appendChild(body);

    toggle.addEventListener('click', function () {
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      toggle.textContent = hidden ? '—' : '+';
    });

    return panel;
  }

  function inject() {
    if (document.getElementById('ai-inbox-helper-panel')) return;
    if (!document.body) return;
    document.body.appendChild(buildPanel());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
